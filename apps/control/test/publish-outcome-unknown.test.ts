import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { active, beforeD1BatchMatching, failingD1Query, fakeDeployer, failingKv, json, publishRes, siteRow, siteWithRunning } from "./helpers";

const activation = /update "sites" set "active_version"/i;

// activation の batch だけを選び、D1 の確定と応答の間に別の公開・読み取り障害を差し込む。
function interruptActivation(commit: boolean, hook?: () => Promise<unknown>, failRead = false) {
  let interrupt = false;
  let interrupted = false;
  const binding = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare" && interrupted && failRead) {
        return (query: string) => {
          if (!/select/i.test(query)) return target.prepare(query);
          interrupted = false; // 2 回目の読み直しなら成功してしまう。
          return failingD1Query(target, /select/i).prepare(query);
        };
      }
      if (prop === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!interrupt) return target.batch(statements);
        interrupt = false;
        if (commit) await target.batch(statements);
        await hook?.();
        interrupted = true;
        throw new Error("injected activation response failure");
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return beforeD1BatchMatching(binding, activation, async () => { interrupt = true; }).db;
}

const history = (sid: string) => env.DB.prepare("select status from publishes where site_id = ? and version = 1").bind(sid).first("status");

it("batch_throw_after_commit_is_treated_as_success", async () => {
  const { owner, sid } = await siteWithRunning();
  const res = await publishRes(owner.token, sid, { DB: interruptActivation(true), DEPLOYER: fakeDeployer() });
  expect(await json(res)).toMatchObject({ ok: true, version: 1 });
  expect(await history(sid)).toBe("active");
  expect(await active(sid)).toBe("1");
  expect(await siteRow(sid)).toMatchObject({ active_kv_stale: 0, static_served_version: 1 });
});

it("batch_throw_before_commit_is_failure", async () => {
  const { owner, sid } = await siteWithRunning();
  const res = await publishRes(owner.token, sid, { DB: failingD1Query(env.DB, activation) });
  expect(await json(res)).toMatchObject({ ok: false, error: "publish_failed" });
  expect(await history(sid)).toBe("failed");
});

it.each([true, false])("batch commit=%s and reread failure is outcome_unknown", async commit => {
  const { owner, sid } = await siteWithRunning();
  const res = await publishRes(owner.token, sid, { DB: interruptActivation(commit, undefined, true) });
  expect(res.status).toBe(503);
  expect(await json(res)).toEqual({
    error: "publish_outcome_unknown", message: "公開の結果を確かめられませんでした",
    hint: "公開履歴と状態を読み込み直して確かめてください。確かめる前に送り直さないでください",
  });
  expect(await history(sid)).toBe(commit ? "active" : "reserved");
  expect(await active(sid)).toBeNull();
});

it("outcome_decided_by_own_row_when_other_advanced", async () => {
  const { owner, sid } = await siteWithRunning();
  const DB = interruptActivation(true, async () => {
    expect(await json(await publishRes(owner.token, sid))).toMatchObject({ ok: true, version: 2 });
  });
  expect(await json(await publishRes(owner.token, sid, { DB }))).toMatchObject({ ok: true, version: 1, superseded: false });
  expect(await active(sid)).toBe("2");
});

it("reread_row_missing_is_record_missing", async () => {
  const { owner, sid } = await siteWithRunning();
  const DB = interruptActivation(false, () => env.DB.prepare("delete from publishes where site_id = ?").bind(sid).run());
  expect(await json(await publishRes(owner.token, sid, { DB }))).toMatchObject({ ok: false, error: "publish_record_missing" });
});

it.each([
  ["marker", /update "sites" set "active_kv_stale" = case/i, 1],
  ["cleanup", /select "static_served_version", "static_prev_served_version"/i, 0],
  ["static", /update "sites" set "static_seq"/i, 0],
] as const)("finish failure at %s returns success with delivery warning", async (_stage, pattern, stale) => {
  const { owner, sid } = await siteWithRunning();
  const res = await publishRes(owner.token, sid, { DB: failingD1Query(env.DB, pattern) });
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.objectContaining({ path: "delivery" })]) });
  expect((await siteRow(sid)).active_kv_stale).toBe(stale);
});

it.each([
  ["reservation_insert", /insert into publishes \(id/i, null],
  ["record_batch", /update publishes set config_hash/i, "failed"],
] as const)("%s error is publish_failed", async (_stage, pattern, status) => {
  const { owner, sid } = await siteWithRunning();
  const res = await publishRes(owner.token, sid, { DB: failingD1Query(env.DB, pattern) });
  expect(await json(res)).toMatchObject({ ok: false, error: "publish_failed" });
  expect(await history(sid)).toBe(status);
});

it.each([[1, 1], [2, 0]])("KV active read %i failure keeps the required marker", async (failRead, stale) => {
  const { owner, sid } = await siteWithRunning();
  let reads = 0;
  const CONFIG_KV = new Proxy(env.CONFIG_KV, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "get") return (key: string, ...args: unknown[]) => {
        if (key.endsWith(":active") && ++reads === failRead) throw new Error("injected KV read failure");
        return value.apply(target, [key, ...args]);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const res = await publishRes(owner.token, sid, { CONFIG_KV });
  expect(await json(res)).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.objectContaining({ path: "delivery" })]) });
  expect((await siteRow(sid)).active_kv_stale).toBe(stale);
});

it.each(["prepare", "activation"] as const)("a failed history update preserves the original %s failure", async stage => {
  const { owner, sid } = await siteWithRunning();
  const db = stage === "activation" ? failingD1Query(env.DB, activation) : env.DB;
  const res = await publishRes(owner.token, sid, {
    DB: failingD1Query(db, /update "publishes" set "status" = .*, "error"/i),
    CONFIG_KV: stage === "prepare" ? failingKv(/config:v1$/) : env.CONFIG_KV,
  });
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ ok: false, error: stage === "prepare" ? "kv_put_failed" : "publish_failed" });
  expect(await history(sid)).toBe("reserved");
  expect(await active(sid)).toBeNull();
});

it.each([
  ["load compile rows", /select \* from "experiments" where "site_id"/i],
  ["pending purge", /select "run_id" from "results_purge_queue"/i],
  ["before activation", /as "snapshot_ok"/i],
] as const)("D1 read failure at %s is publish_failed", async (_stage, pattern) => {
  const { owner, sid } = await siteWithRunning();
  const res = await publishRes(owner.token, sid, { DB: failingD1Query(env.DB, pattern) });
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ ok: false, error: "publish_failed" });
  expect(await history(sid)).toBe("failed");
  expect(await active(sid)).toBeNull();
});

it.each(["pending", "hang", "tombstone", "throw"] as const)("static deploy %s warns only on exception", async mode => {
  const { owner, sid } = await siteWithRunning();
  const deployer = fakeDeployer(mode === "tombstone" ? "deploy" : mode);
  if (mode === "tombstone") deployer.setTombstone((await siteRow(sid)).created_at);
  const res = await json(await publishRes(owner.token, sid, { DEPLOYER: deployer }));
  expect(res).toMatchObject({ ok: true, staticDeploy: "pending" });
  expect(res.warnings.some((warning: { path: string }) => warning.path === "delivery")).toBe(mode === "throw");
  expect(await siteRow(sid)).toMatchObject({ active_kv_stale: 0, static_stale: 1 });
});
