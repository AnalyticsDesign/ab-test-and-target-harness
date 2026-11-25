import { kvKeys, parseCompiledConfig } from "@wtt/core";
import { expect, it, vi } from "vitest";
import { publishRepairJob } from "../src/cron/publish-repair";
import { runCron } from "../src/cron/runner";
import type { Env } from "../src/env";
import { abortingBindings, settleOrAbort, type AbortPoint } from "./abort-harness";
import { active, beforeD1BatchMatching, call, createExperiment, createSite, failingKv, fakeDeployer,
  json, publishRes, runDirect, setupOwner, siteRow, testEnv } from "./helpers";

const operations = {
  publish: ["running", "running"], start: ["draft", "running"], pause: ["running", "paused"],
  resume: ["paused", "running"], archive: ["running", "archived"],
} as const;
type Action = keyof typeof operations;
type Owner = Awaited<ReturnType<typeof setupOwner>>;
const actions = Object.keys(operations) as Action[];
const activation = /update "sites" set "active_version"/i;
const reserve = /insert into publishes \(id, site_id, version/i;
const lowerPointer = /update "sites" set "active_kv_stale" = case/i;
const lowerStatic = /update "sites" set "static_stale"/i;
const db = testEnv.DB;

async function fixture(owner: Owner, action: Action) {
  const { token, workspaceId } = owner;
  const { id: sid } = await createSite(token, workspaceId);
  const { id: eid } = await createExperiment(token, sid, { id: "exp_target" });
  await runDirect(sid, eid, operations[action][0]);
  const env = { ...testEnv, DEPLOYER: fakeDeployer() };
  // v1 を配っている状態から始める。次の activation にだけ収集を ON にする行が必要。
  await db.prepare("update sites set results_enabled=0 where id=?").bind(sid).run();
  expect(await json(await publishRes(token, sid, env))).toMatchObject({ ok: true, version: 1, staticDeploy: "deployed" });
  await db.prepare("update sites set results_enabled=1 where id=?").bind(sid).run();
  function send(which: Action, bindings: Partial<Env> = env, experiment = eid) {
    if (which === "publish") return publishRes(token, sid, bindings);
    return call("POST", `/sites/${sid}/experiments/${experiment}/status`, {
      token, envOverride: bindings, body: { status: operations[which][1] },
    });
  }
  return { sid, eid, token, action, env, send };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function boundary(calls: string[], pattern: RegExp) {
  const index = calls.findIndex(label => pattern.test(label));
  expect(index, pattern.toString()).toBeGreaterThanOrEqual(0);
  return index + 1;
}

async function traceSuccess(f: Fixture) {
  const trace = abortingBindings(f.env, null);
  const res = await f.send(f.action, trace.env);
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.publish ?? body).toMatchObject({ ok: true, version: 2, staticDeploy: "deployed" });
  return trace.calls;
}

async function interrupt(f: Fixture, point: AbortPoint, label: string, env: Env = f.env) {
  const trace = abortingBindings(env, point);
  const request = f.send(f.action, trace.env);
  // 発火せずに早期応答した場合も、ここで失敗する。例外注入ではアプリの catch まで待つ。
  expect(await settleOrAbort(request, trace.reached)).toEqual({ aborted: true });
  expect(trace.calls[point.at - 1]).toBe(label);
  if (point.mode === "throw_after") return request;
}

async function readShape(sid: string) {
  const site = await db.prepare(`select active_version as version, active_kv_stale as marker, static_stale as staticMarker,
    (select status from experiments where site_id=s.id and id='exp_target') as status,
    (select published_status from experiments where site_id=s.id and id='exp_target') as published,
    (select status from publishes where site_id=s.id and version=2) as reservation
    from sites s where id=?`).bind(sid).first<{
    version: number; marker: number; staticMarker: number; status: string; published: string; reservation: string | null;
  }>();
  if (!site) throw new Error(`サイトが無い: ${sid}`);
  const { results } = await db.prepare("select publish_version, enabled from results_collection_log where site_id=? order by id").bind(sid).all();
  return { ...site, pointer: await active(sid), switches: results };
}
const switched = [{ publish_version: 2, enabled: 1 }];

async function expectAllowedShape(f: Fixture, calls: string[], point: AbortPoint, response?: Response) {
  const shape = await readShape(f.sid);
  const { at, mode } = point;
  const [from, to] = operations[f.action];
  const committed = mode === "before" ? at - 1 : at;
  const activationAt = boundary(calls, activation);
  if (mode !== "throw_after") {
    const activated = committed >= activationAt;
    expect(shape).toEqual({
      version: activated ? 2 : 1,
      status: activated ? to : from, published: activated ? to : from,
      reservation: activated ? "active" : committed >= boundary(calls, reserve) ? "reserved" : null,
      pointer: committed >= boundary(calls, /^kv\.put .*:active$/) ? "2" : "1",
      marker: Number(activated && committed < boundary(calls, lowerPointer)),
      staticMarker: Number(activated && committed < boundary(calls, lowerStatic)),
      switches: activated ? switched : [],
    });
  } else {
    if (!response) throw new Error("例外注入後の応答が無い");
    await expectLostResponse(f, calls, at, shape, response);
  }
  return shape;
}

async function expectLostResponse(f: Fixture, calls: string[], at: number, shape: Awaited<ReturnType<typeof readShape>>, res: Response) {
  const [from, to] = operations[f.action];
  const repairRead = boundary(calls, /select "active_kv_stale", "active_version", "last_activated_at" from "sites"/);
  const reservation = boundary(calls, reserve);
  const activationAt = boundary(calls, activation);
  const original = { version: 1, pointer: "1", marker: 0, staticMarker: 0, status: from, published: from, switches: [] };

  if (at < repairRead) {
    // 凍結・セッション・権限・遷移前の検査は、公開も状態だけの保存も始めていない。
    expect(shape).toEqual({ ...original, reservation: null });
    expect(res.status).toBeGreaterThanOrEqual(400);
    return;
  }

  const body = await json(res);
  if (at !== repairRead && at < activationAt) {
    // 公開の冒頭の修復だけは best-effort。予約から activation の事前 SELECT までの失敗は公開できない。
    expect(at).toBeGreaterThanOrEqual(reservation);
    const stateOnly = f.action === "pause" || f.action === "archive";
    expect(shape).toEqual({ ...original, status: stateOnly ? to : from, reservation: "failed" });
    const label = calls[at - 1]!;
    const error = label.startsWith("kv.put ") ? "kv_put_failed" : label.startsWith("kv.get ") ? "kv_verify_failed" : "publish_failed";
    if (f.action === "publish") {
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ ok: false, error });
    } else if (stateOnly) {
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ experiment: { status: to, publishedStatus: from }, publish: { ok: false, error } });
      expect(await json(await call("GET", `/sites/${f.sid}`, { token: f.token, envOverride: f.env }))).toMatchObject({ hasUnpublishedChanges: true });
    } else {
      expect(res.status).toBe(409);
      expect(body).toMatchObject({ error, message: expect.any(String), hint: expect.any(String) });
    }
    return;
  }

  const pointerRead = boundary(calls, /^select "active_version", "last_activated_at" from "sites"/);
  const pointerPut = boundary(calls, /^kv\.put .*:active$/);
  const verifyPointer = boundary(calls, /^kv\.get .*:active$/);
  const staticStart = boundary(calls, /update "sites" set "static_seq" = static_seq/);
  const staticDone = boundary(calls, lowerStatic);
  // 版の SELECT が失敗すれば put 前。put だけの応答喪失は再試行で成功する。
  // 印を降ろした CASE または直後の KV 照合が失敗すれば、catch が既に降りた印を立て直す。
  expect(shape).toEqual({
    version: 2, status: to, published: to, reservation: "active", switches: switched,
    pointer: at === pointerRead ? "1" : "2",
    marker: Number(at === pointerRead || at === boundary(calls, lowerPointer) || at === verifyPointer),
    staticMarker: Number(at >= staticStart && at < staticDone),
  });

  // activation の応答は自分の active 行を読み直せる。静的配信の印の UPDATE は実行済みでも応答は失われる。
  expect(res.status).toBe(200);
  if (f.action !== "publish") expect(body.experiment).toMatchObject({ status: to, publishedStatus: to });
  const publish = f.action === "publish" ? body : body.publish;
  expect(publish).toMatchObject({ ok: true, version: 2, staticDeploy: at >= staticStart && at <= staticDone ? "pending" : "deployed" });

  // 終了時の速報の削除と未公開編集の表示用読み取りは公開・配信が済んだ後の補助処理。
  const warningEnd = f.action === "archive" ? boundary(calls, /^select "last_activated_at" from "sites"/) : calls.length;
  const needsWarning = at > activationAt && at !== pointerPut && at <= warningEnd;
  expect(publish.warnings.some((w: { path: string }) => w.path === "delivery")).toBe(needsWarning);
}

async function expectRepaired(f: Fixture, version: number) {
  const status = operations[f.action][1];
  expect(await readShape(f.sid)).toMatchObject({
    version, marker: 0, pointer: String(version), status, published: status, reservation: "active", switches: switched,
  });
}

it.each(actions)("%s: 全 D1・KV 呼び出しの前・後・応答喪失", async action => {
  const owner = await setupOwner();
  const base = await fixture(owner, action);
  const calls = await traceSuccess(base);
  const activationAt = boundary(calls, activation);
  for (const mode of ["before", "after", "throw_after"] as const) {
    for (let at = 1; at <= calls.length; at++) {
      const f = await fixture(owner, action);
      const label = calls[at - 1]!.replaceAll(base.sid, f.sid);
      try {
        const res = await interrupt(f, { at, mode }, label);
        const shape = await expectAllowedShape(f, calls, { at, mode }, res);
        if (shape.status === shape.published) {
          const now = (await siteRow(f.sid)).last_activated_at! + 31_000;
          expect(await runCron(f.env, now, [publishRepairJob])).toMatchObject([{ job: "publish-repair", outcome: "ran" }]);
          if (shape.version === 2) await expectRepaired(f, 2);
          else expect(await readShape(f.sid)).toEqual(shape);
        }
      } catch (error) {
        throw new Error(`${action} ${mode} k=${at}/${calls.length}: ${label.slice(0, 160)}`, { cause: error });
      }
    }
  }
  console.log(`abort coverage ${action}: ${calls.length} boundaries x 3, activation=${activationAt}`);
}, 120_000);

it.each(actions)("%s: activation 直後を GET と次の公開で修復", async action => {
  const owner = await setupOwner();
  const base = await fixture(owner, action);
  const calls = await traceSuccess(base);
  const at = boundary(calls, activation);
  for (const route of ["get", "publish"] as const) {
    const f = await fixture(owner, action);
    await interrupt(f, { at, mode: "after" }, calls[at - 1]!);
    expect(await readShape(f.sid)).toMatchObject({ version: 2, marker: 1, pointer: "1" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    try {
      if (route === "get") {
        const res = await call("GET", `/sites/${f.sid}`, { token: f.token, envOverride: f.env });
        expect(await json(res)).toMatchObject({ activeKvStale: false });
        await expectRepaired(f, 2);
      } else {
        // 次版が古いずれを隠す前に、前の版そのものの修復を確認する。
        const check = beforeD1BatchMatching(db, reserve, () => expectRepaired(f, 2));
        expect(await json(await f.send("publish", { ...f.env, DB: check.db }))).toMatchObject({ ok: true, version: 3 });
        expect(check.ran()).toBe(true);
        await expectRepaired(f, 3);
      }
    } finally { clock.mockRestore(); }
  }
});

it("準備の KV が失敗した一時停止で、状態だけの batch の応答を失う", async () => {
  const owner = await setupOwner();
  const base = await fixture(owner, "pause");
  const trace = abortingBindings({ ...base.env, CONFIG_KV: failingKv(/config:v/) }, null);
  expect(await json(await base.send("pause", trace.env))).toMatchObject({ publish: { ok: false } });
  const at = boundary(trace.calls, /update "experiments" set "status"/);
  for (const mode of ["after", "throw_after"] as const) {
    const f = await fixture(owner, "pause");
    await interrupt(f, { at, mode }, trace.calls[at - 1]!, { ...f.env, CONFIG_KV: failingKv(/config:v/) });
    expect(await readShape(f.sid)).toEqual({ version: 1, marker: 0, staticMarker: 0, pointer: "1", status: "paused",
      published: "running", switches: [], reservation: "failed" });
    expect(await json(await call("GET", `/sites/${f.sid}`, { token: f.token, envOverride: f.env }))).toMatchObject({ hasUnpublishedChanges: true });
  }
});

async function expectServingStatuses(f: Fixture) {
  const row = await siteRow(f.sid);
  expect(await active(f.sid)).toBe(String(row.active_version));
  expect(row.active_kv_stale).toBe(0);
  const raw = await f.env.CONFIG_KV.get(kvKeys.config(f.sid, row.active_version!));
  const config = raw && parseCompiledConfig(JSON.parse(raw));
  if (!config) throw new Error("有効な版の設定が読めません");
  const { results } = await db.prepare("select id, status, published_status from experiments where site_id=? order by id")
    .bind(f.sid).all<{ id: string; status: string; published_status: string }>();
  for (const exp of results) expect(exp.published_status).toBe(exp.status);
  expect(config.experiments.map(e => e.id).sort()).toEqual(results.filter(e => e.status === "running").map(e => e.id));
}

it.each([["publish", "publish"], ["publish", "pause"], ["pause", "publish"]] as const)(
  "%s が先に予約し %s が先に確定する", async (outer, inner) => {
    const f = await fixture(await setupOwner(), outer);
    const history = () => db.prepare("select version, status from publishes where site_id=? order by version").bind(f.sid).all();
    let atReservation: unknown;
    const second = beforeD1BatchMatching(db, reserve, async () => { atReservation = (await history()).results; });
    let innerResult;
    const first = beforeD1BatchMatching(db, activation, async () => {
      innerResult = await json(await f.send(inner, { ...f.env, DB: second.db }));
    });
    const res = await f.send(outer, { ...f.env, DB: first.db });
    expect(first.ran() && second.ran()).toBe(true);
    expect(atReservation).toEqual([{ version: 1, status: "active" }, { version: 2, status: "reserved" }]);
    expect(innerResult).toMatchObject(inner === "publish" ? { ok: true, version: 3 } : { publish: { ok: true, version: 3 } });
    expect(res.status).toBe(200);
    const body = await json(res);
    if (outer === "pause") expect(body.publish).toMatchObject({ ok: true, version: 4 });
    else if (inner === "pause") expect(body).toMatchObject({ ok: false, version: 2, error: "state_changed" });
    else expect(body).toMatchObject({ ok: true, version: 2, superseded: true });
    expect((await siteRow(f.sid)).active_version).toBe(outer === "pause" ? 4 : 3);
    await expectServingStatuses(f);
  },
);

function pausedActivation() {
  let signal!: () => void;
  const reached = new Promise<void>(resolve => { signal = resolve; });
  let resume!: () => void;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  const hook = beforeD1BatchMatching(db, activation, async () => { signal(); await wait; });
  return { db: hook.db, reached, resume };
}

for (const b of ["pause", "start"] as const) {
  it.each(["publish", "start"] as const)(`B の ${b} と C の %s: C が読んだ後に B を確定する`, async c => {
    const f = await fixture(await setupOwner(), b);
    const { id: other } = await createExperiment(f.token, f.sid, { id: "exp_other" });
    const first = pausedActivation(), second = pausedActivation();
    const bRequest = f.send(b, { ...f.env, DB: first.db });
    try {
      expect(await settleOrAbort(bRequest, first.reached)).toEqual({ aborted: true });
      const cRequest = f.send(c, { ...f.env, DB: second.db }, other);
      expect(await settleOrAbort(cRequest, second.reached)).toEqual({ aborted: true });
      const reservations = await db.prepare("select version from publishes where site_id=? and status='reserved' order by version").bind(f.sid).all();
      expect(reservations.results).toEqual([{ version: 2 }, { version: 3 }]);
      first.resume();
      expect(await json(await bRequest)).toMatchObject({ publish: { ok: true, version: 2 } });
      second.resume();
      const res = await cRequest;
      if (c === "publish") expect(await json(res)).toMatchObject({ ok: false, error: "state_changed", version: 3 });
      else {
        expect(res.status).toBe(409);
        expect(await json(res)).toMatchObject({ error: "transition_conflict" });
      }
      expect((await siteRow(f.sid)).active_version).toBe(2);
      await expectServingStatuses(f);
    } finally {
      first.resume();
      second.resume();
    }
  });
}

it("新版の確認後に旧版の put が届くと、旧版の公開自身が CASE で印を立て直す", async () => {
  const f = await fixture(await setupOwner(), "publish");
  let newer: unknown;
  const key = kvKeys.active(f.sid);
  const kv = new Proxy(f.env.CONFIG_KV, {
    get(target, prop) {
      if (prop === "put") return async (k: string, value: string, options?: KVNamespacePutOptions) => {
        if (k === key && value === "2") {
          expect(await json(await f.send("publish"))).toMatchObject({ ok: true, version: 3 });
          newer = await readShape(f.sid);
        }
        return target.put(k, value, options);
      };
      const method = Reflect.get(target, prop);
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
  expect(await json(await f.send("publish", { ...f.env, CONFIG_KV: kv }))).toMatchObject({ ok: true, version: 2 });
  expect(newer).toMatchObject({ version: 3, marker: 0, pointer: "3" });
  expect(await readShape(f.sid)).toMatchObject({ version: 3, marker: 1, pointer: "2" });
  const now = (await siteRow(f.sid)).last_activated_at! + 31_000;
  await runCron(f.env, now, [publishRepairJob]);
  await expectRepaired(f, 3);
});
