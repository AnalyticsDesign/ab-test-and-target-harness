import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  kvKeys,
  PAGE_CONDITION_MOVED_AUDIENCE_HINT,
  PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE,
  PAGE_CONDITION_MOVED_HINT,
  PAGE_CONDITION_MOVED_MESSAGE,
  parseCompiledConfig,
  RUN_ID_RE,
} from "@wtt/core";
import { getDb } from "../src/db";
import {
  call,
  choosePrimaryGoal,
  json,
  setupOwner,
  inviteAndJoin,
  createSite,
  createExperiment,
  TEXT_CHANGE,
  failingKv,
  failingD1Query,
  publishRes,
  active,
  siteRow,
  experimentRow,
  runDirect,
  RESULTS_STORE,
  countingD1,
} from "./helpers";

const setStatus = (token: string, sid: string, eid: string, status: string, envOverride?: Record<string, unknown>) =>
  call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status }, envOverride: envOverride as never });
const activeConfig = async (sid: string) => {
  const v = await env.CONFIG_KV.get(kvKeys.active(sid));
  if (v === null) return null;
  return parseCompiledConfig(JSON.parse((await env.CONFIG_KV.get(kvKeys.config(sid, Number(v))))!));
};

async function base() {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_hero" });
  await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
  return { owner, sid, eid };
}

/**
 * `select` 文のうち `columnPattern` にマッチする 1 文だけを壊す D1 ラッパ。`publishSite` は複数の select を
 * 順に投げるので、狙った 1 文だけを落として「その手前までは普段どおり進む」失敗を再現するのに使う
 * (carried-forward item 3 / review finding 1 用)
 */
function failingD1Select(columnPattern: RegExp, onHit: () => void = () => {}): D1Database {
  const boom = async () => {
    onHit();
    throw new Error(`injected d1 select failure matching ${columnPattern}`);
  };
  const failing = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(s, p) {
        if (p === "run" || p === "first" || p === "all" || p === "raw") return boom;
        if (p === "bind") return (...args: unknown[]) => failing(s.bind(...args));
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
  return new Proxy(env.DB, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sqlText: string) => {
          const stmt = target.prepare(sqlText);
          return /^\s*select/i.test(sqlText) && columnPattern.test(sqlText) ? failing(stmt) : stmt;
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

/**
 * `sqlPattern` にマッチする最初の 1 文の直前に `sideEffect` を差し込む D1 ラッパ(review finding 3 用)。
 * 「compile 済みの config が確定した後、published_status を書き込む直前に、別の actor が status を書き換える」
 * という競合を実際に発生させて、published_status がどちらの値で書かれるかを確かめる
 */
function withSideEffectBeforeFirstMatch(sqlPattern: RegExp, sideEffect: () => Promise<void>): D1Database {
  let done = false;
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(s, p) {
        if ((p === "run" || p === "first" || p === "all") && !done) {
          done = true;
          return async (...args: unknown[]) => {
            await sideEffect();
            return (s[p as "run"] as (...a: unknown[]) => unknown).apply(s, args);
          };
        }
        if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
  return new Proxy(env.DB, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sqlText: string) => {
          const stmt = target.prepare(sqlText);
          return sqlPattern.test(sqlText) ? wrap(stmt) : stmt;
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

describe("status transitions (spec §13.8)", () => {
  it("start publishes automatically and published_status follows", async () => {
    const { owner, sid, eid } = await base();
    const res = await setStatus(owner.token, sid, eid, "running");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.publish).toMatchObject({ ok: true, version: 1 });
    expect(body.experiment).toMatchObject({ status: "running", publishedStatus: "running", unpublished: false });
    expect((await activeConfig(sid))?.experiments.map((e) => e.id)).toEqual(["exp_hero"]);
  });
  it("status_paused_removes_experiment_from_compiled_config", async () => {
    const { owner, sid, eid } = await base();
    await setStatus(owner.token, sid, eid, "running");
    const res = await setStatus(owner.token, sid, eid, "paused");
    expect((await json(res)).publish).toMatchObject({ ok: true, version: 2 });
    expect((await activeConfig(sid))?.experiments).toEqual([]);
    expect((await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: owner.token }))).publishedStatus).toBe("paused");
  });
  it("archived_cannot_return_to_running", async () => {
    const { owner, sid, eid } = await base();
    await setStatus(owner.token, sid, eid, "running");
    expect((await setStatus(owner.token, sid, eid, "archived")).status).toBe(200);
    const res = await setStatus(owner.token, sid, eid, "running");
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "invalid_transition", from: "archived", to: "running" });
    expect((await setStatus(owner.token, sid, eid, "paused")).status).toBe(409);
    // draft → paused / archived も不可、running → running も不可
    const { id: e2 } = await createExperiment(owner.token, sid, { id: "exp_two" });
    expect((await setStatus(owner.token, sid, e2, "paused")).status).toBe(409);
    expect((await setStatus(owner.token, sid, e2, "running")).status).toBe(200);
    expect((await setStatus(owner.token, sid, e2, "running")).status).toBe(409);
  });
  it("review finding 6: invalid_transition has a Japanese message in the envelope (UI 文言は日本語という Global Constraint)", async () => {
    const { owner, sid, eid } = await base();
    const res = await setStatus(owner.token, sid, eid, "paused"); // draft → paused は表外
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toBe("invalid_transition");
    expect(typeof body.message).toBe("string");
    expect(body.message).not.toBe("invalid_transition"); // code そのままではなく日本語の文になっている
    expect(body.message).toMatch(/[぀-ヿ一-鿿]/); // ひらがな/カタカナ/漢字を含む
  });
  it("editor_cannot_publish_or_change_status", async () => {
    const { owner, sid, eid } = await base();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const s = await setStatus(ed.token, sid, eid, "running");
    expect(s.status).toBe(403);
    expect(await json(s)).toMatchObject({ error: "forbidden", required: "admin" });
    const p = await publishRes(ed.token, sid);
    expect(p.status).toBe(403);
    expect((await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: ed.token }))).status).toBe("draft");
    expect(await env.CONFIG_KV.get(kvKeys.active(sid))).toBeNull();
  });
  it("status_publish_failure_preserves_previous_published_status", async () => {
    const { owner, sid, eid } = await base();
    await setStatus(owner.token, sid, eid, "running");
    const res = await setStatus(owner.token, sid, eid, "paused", { CONFIG_KV: failingKv(/config:v2$/) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.publish).toMatchObject({ ok: false, version: 2, error: "kv_put_failed" });
    // 決定 17: D1 の status は戻さず、published_status は前回 activation の値のまま
    expect(body.experiment).toMatchObject({ status: "paused", publishedStatus: "running" });
    expect((await activeConfig(sid))?.experiments.map((e) => e.id)).toEqual(["exp_hero"]);
  });
  it("status_retry_converges_d1_and_active_config", async () => {
    const { owner, sid, eid } = await base();
    await setStatus(owner.token, sid, eid, "running");
    await setStatus(owner.token, sid, eid, "paused", { CONFIG_KV: failingKv(/config:v2$/) });
    const retry = await json(await publishRes(owner.token, sid));
    expect(retry).toMatchObject({ ok: true, version: 3 });
    const exp = await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token: owner.token }));
    expect(exp).toMatchObject({ status: "paused", publishedStatus: "paused", unpublished: false });
    expect((await activeConfig(sid))?.experiments).toEqual([]);
  });
  it("concurrent status changes let exactly one win", async () => {
    const { owner, sid, eid } = await base();
    const token = owner.token;
    await setStatus(token, sid, eid, "running");
    const [a, p] = await Promise.all([
      call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status: "archived" } }),
      call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status: "paused" } }),
    ]);
    expect([a.status, p.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? "archived" : "paused";
    const exp = await json(await call("GET", `/sites/${sid}/experiments/${eid}`, { token }));
    expect(exp.status).toBe(winner); // 先に CAS を通した側だけが反映され、負けた側は 409(stale read で上書きしない)
  });
  it("concurrent status changes to the SAME target status still let only one win (review finding 4: 異なる target 同士だと、直列実行でも TRANSITIONS 表だけで 409 が出て CAS を試さずに通ってしまう可能性があるため、同じ target で狙って CAS を踏ませる)", async () => {
    const { owner, sid, eid } = await base();
    const token = owner.token;
    await setStatus(token, sid, eid, "running");
    const [a, b] = await Promise.all([
      call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status: "paused" } }),
      call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status: "paused" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // CAS が無いと両方 200 になりうる(実測: red-check 参照)。D1 の状態も 1 回だけ更新されている
    expect((await experimentRow(sid, eid)).status).toBe("paused");
  });

  // --- 繰越項目のカバレッジ(Task 5 の未達成分をここで通す) ---

  it("carried-forward 1: DELETE 409 experiment_active becomes reachable once /status can make an experiment running, and clears on archive", async () => {
    const { owner, sid, eid } = await base();
    expect((await setStatus(owner.token, sid, eid, "running")).status).toBe(200);
    const del1 = await call("DELETE", `/sites/${sid}/experiments/${eid}`, { token: owner.token });
    expect(del1.status).toBe(409);
    // Task 12: 発見時は message 未設定で code(experiment_active)がそのまま出ていた
    expect(await json(del1)).toMatchObject({ error: "experiment_active", message: "配信中のエクスペリエンスは削除できません" });
    expect((await setStatus(owner.token, sid, eid, "archived")).status).toBe(200);
    const del2 = await call("DELETE", `/sites/${sid}/experiments/${eid}`, { token: owner.token });
    expect(del2.status).toBe(204);
  });

  it("review finding 1: a publishSite throw right at the start (before activation) still reports the committed status change as 200, not 500", async () => {
    const { owner, sid, eid } = await base();
    // version 予約の insert(手順 2。compile より前で、UNIQUE 以外の catch を素通りして re-throw する)を壊す。
    // Task 8 で reconcileActive 自体が「絶対に throw しない」形に直った(review r1 finding 1)ので、
    // publishSite の一番最初の呼び出しは reconcileActive ではなくこの insert になった —
    // それでも activation どころか compile にも到達しない、より早い段階での throw であることに変わりはない
    const res = await setStatus(owner.token, sid, eid, "running", { DB: failingD1Query(env.DB, /^\s*insert into publishes/i) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.publish).toMatchObject({ ok: false, version: null, error: "publish_failed" });
    // status の CAS 自体は publishSite を呼ぶ前に確定しているので、D1 には running が乗っている
    expect(body.experiment).toMatchObject({ status: "running" });
    expect((await experimentRow(sid, eid)).status).toBe("running");
    // publish 自体は 1 度も進んでいないので、KV の active はまだ無い(前の版も無い、そもそも初回)
    expect(await active(sid)).toBeNull();
  });

  it("review finding 3: published_status is written from the compile-time snapshot, not a live re-read — a status change that lands after compile does not leak in", async () => {
    const { owner, sid, eid } = await base();
    await setStatus(owner.token, sid, eid, "running"); // v1: config に exp_hero を含めて活性化。status も published_status も running

    // 別の actor が、この plain /publish の「published_status を書く」直前(= compile も activation も終わった後)に
    // この Experiment を paused に書き換える(runDirect は D1 を直接叩く。route の CAS も自動 Publish も経由しない)。
    // 決定 17 が守るべきなのは「published_status は published_status = status の update が読む瞬間の値」ではなく
    // 「この publish が実際に compile した瞬間の値」— 後者でなければ site-delete guard(routes/sites.ts)が
    // published_status を見て「もう running を含んでいない」と誤判定しうる(review finding 3)
    const sideEffect = () => runDirect(sid, eid, "paused");
    const res = await publishRes(owner.token, sid, { DB: withSideEffectBeforeFirstMatch(/published_status/i, sideEffect) });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, version: 2 });

    const row = await experimentRow(sid, eid);
    // 競合した書込みは実際に効いている(D1 の生の status は paused)
    expect(row.status).toBe("paused");
    // しかし published_status は、この publish が compile した瞬間の値(running)のまま —
    // 競合した書込みを published_status に取り込んでいない(取り込んでいたら "paused" になっていたはず)
    expect(row.published_status).toBe("running");
    // 実際に配信されている config(この publish が activate した v2)は running のまま exp_hero を含む
    expect((await activeConfig(sid))?.experiments.map((e) => e.id)).toEqual(["exp_hero"]);
  });

  it("carried-forward 3: a cleanup failure after a successful activation still reports the status change (does not turn a 200 into a 500)", async () => {
    const { owner, sid, eid } = await base();
    // 古い版の掃除は、配信ファイルが配っている版が分かるまで何も消さない(7i plan K20 ①)= 公開の SELECT に届かない。
    // 掃除が本当に失敗する SELECT(kv_deleted)まで進むよう、配っている版を記録済みにしておく
    await getDb(env).updateTable("sites").set({ static_served_version: 1 }).where("id", "=", sid).execute();
    let hits = 0;
    const res = await setStatus(owner.token, sid, eid, "running", { DB: failingD1Select(/kv_deleted/i, () => { hits++; }) });
    expect(hits).toBeGreaterThan(0); // 掃除の SELECT が実際に失敗した(この検査が空振りしていない)
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.publish).toMatchObject({ ok: true, version: 1 });
    expect(body.experiment).toMatchObject({ status: "running", publishedStatus: "running" });
    // D1 / KV の記帳自体は普段どおり進んでいる(cleanup だけが失敗した)
    expect((await siteRow(sid)).active_version).toBe(1);
    expect(await active(sid)).toBe("1");
  });

  it("review finding 5: started_at is set on the first running transition, survives pause -> resume, and stopped_at is set on archive", async () => {
    const { owner, sid, eid } = await base();
    const before = Date.now();
    expect((await setStatus(owner.token, sid, eid, "running")).status).toBe(200);
    const afterFirstRun = await experimentRow(sid, eid);
    expect(afterFirstRun.started_at).not.toBeNull();
    expect(afterFirstRun.started_at!).toBeGreaterThanOrEqual(before);
    expect(afterFirstRun.stopped_at).toBeNull();

    expect((await setStatus(owner.token, sid, eid, "paused")).status).toBe(200);
    expect((await experimentRow(sid, eid)).started_at).toBe(afterFirstRun.started_at); // pause では触られない

    // paused → running(唯一の legal な「復帰」遷移)。started_at は初回のまま動かない(決定 34)
    expect((await setStatus(owner.token, sid, eid, "running")).status).toBe(200);
    const afterResume = await experimentRow(sid, eid);
    expect(afterResume.status).toBe("running");
    expect(afterResume.started_at).toBe(afterFirstRun.started_at);
    expect(afterResume.stopped_at).toBeNull();

    expect((await setStatus(owner.token, sid, eid, "archived")).status).toBe(200);
    const afterArchive = await experimentRow(sid, eid);
    expect(afterArchive.started_at).toBe(afterFirstRun.started_at); // archive でも動かない
    expect(afterArchive.stopped_at).not.toBeNull();
    expect(afterArchive.stopped_at!).toBeGreaterThanOrEqual(before);
  });
});

// D9 ②(plan ② の K14、設計書 §5.2・§6.3): 開始(draft → running)のときだけ run_id を振る。
// 振るのは kind = test・Site が結果を記録する(results_enabled = 1)・計測用 D1 がある、のすべてを満たすときだけ
describe("run_id の発行と開始の警告(D9 ②)", () => {
  const NOT_RECORDED = { path: "results", message: "結果はツール上に残りません。後から結果の記録を有効にしても、このテストの結果は記録されません" };
  /** 計測用 D1 がある導入で作った Site(results_enabled = 1)と、変更 1 件のテスト */
  async function storeBase(expOverrides: Record<string, unknown> = {}) {
    const owner = await setupOwner();
    const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "Site", domains: ["www.example.com"] }, envOverride: RESULTS_STORE });
    expect(res.status).toBe(201);
    const { id: sid } = await json<{ id: string }>(res);
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_hero", ...expOverrides });
    // 結果を記録する開始は判定に使う目標が要る(D9 ③ Task 5)。パーソナライズには評価計画が無い
    if (expOverrides.kind !== "single") await choosePrimaryGoal(owner.token, sid, eid);
    return { owner, sid, eid };
  }

  it("issues run_id on first start of a test when site records results", async () => {
    const { owner, sid, eid } = await storeBase();
    const res = await setStatus(owner.token, sid, eid, "running", RESULTS_STORE);
    expect(res.status).toBe(200);
    const body = await json(res);
    const row = await experimentRow(sid, eid);
    expect(row.run_id).toHaveLength(22);
    expect(row.run_id).toMatch(RUN_ID_RE);
    expect(body.experiment.runId).toBe(row.run_id);
    expect(body.warnings).toEqual([]);
  });

  it("run_id_not_issued_when_site_results_disabled_at_start", async () => {
    const { owner, sid, eid } = await storeBase();
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsEnabled: false }, envOverride: RESULTS_STORE })).status).toBe(200);
    const res = await setStatus(owner.token, sid, eid, "running", RESULTS_STORE);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((await experimentRow(sid, eid)).run_id).toBeNull();
    expect(body.experiment.runId).toBeNull();
    expect(body.warnings).toEqual([NOT_RECORDED]);
    // 後から Site で有効にしても、このテストには振らない(再開は開始ではない)
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { resultsEnabled: true }, envOverride: RESULTS_STORE })).status).toBe(200);
    expect((await setStatus(owner.token, sid, eid, "paused", RESULTS_STORE)).status).toBe(200);
    expect((await setStatus(owner.token, sid, eid, "running", RESULTS_STORE)).status).toBe(200);
    expect((await experimentRow(sid, eid)).run_id).toBeNull();
  });

  it("single never gets run_id", async () => {
    const { owner, sid, eid } = await storeBase({ kind: "single" });
    const res = await setStatus(owner.token, sid, eid, "running", RESULTS_STORE);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((await experimentRow(sid, eid)).run_id).toBeNull();
    expect(body.experiment.runId).toBeNull();
    expect(body.warnings).toEqual([]); // パーソナライズは結果を持たないので、警告も出さない
  });

  it("resume_keeps_run_id", async () => {
    const { owner, sid, eid } = await storeBase();
    expect((await setStatus(owner.token, sid, eid, "running", RESULTS_STORE)).status).toBe(200);
    const first = (await experimentRow(sid, eid)).run_id;
    expect(first).toMatch(RUN_ID_RE);
    const paused = await json(await setStatus(owner.token, sid, eid, "paused", RESULTS_STORE));
    expect(paused.warnings).toEqual([]);
    const resumed = await json(await setStatus(owner.token, sid, eid, "running", RESULTS_STORE));
    expect(resumed.warnings).toEqual([]);
    expect(resumed.experiment.runId).toBe(first);
    expect((await experimentRow(sid, eid)).run_id).toBe(first);
    expect((await json(await setStatus(owner.token, sid, eid, "archived", RESULTS_STORE))).experiment.runId).toBe(first);
  });

  it("legacy_paused_test_can_resume", async () => {
    // v1.0 より前に開始した(run_id の無い)一時停止中のテスト。結果を記録する Site でも、再開で振らない
    const { owner, sid, eid } = await storeBase();
    await runDirect(sid, eid, "paused");
    const res = await setStatus(owner.token, sid, eid, "running", RESULTS_STORE);
    expect(res.status).toBe(200);
    expect((await json(res)).warnings).toEqual([]);
    const row = await experimentRow(sid, eid);
    expect(row.status).toBe("running");
    expect(row.run_id).toBeNull();
  });

  it("start without store gives warning and no run_id", async () => {
    // Site は結果を記録する設定のまま、導入から計測用 D1 が外れた(binding が無い)
    const { owner, sid, eid } = await storeBase();
    expect((await siteRow(sid)).results_enabled).toBe(1);
    const res = await setStatus(owner.token, sid, eid, "running");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((await experimentRow(sid, eid)).run_id).toBeNull();
    expect(body.warnings).toEqual([NOT_RECORDED]);
  });
});

// B69(spec §6.2.1): 開始・再開は、外したページの条件(直接・参照するオーディエンス経由)が残っていれば状態の CAS の前に 422
describe("開始・再開の前の、外したページの条件の検査(B69)", () => {
  const QUERY = { ctx: "query", name: "a", op: "exists" };
  const DEVICE = { ctx: "device", op: "in", value: ["mobile"] };
  const writeTargeting = (sid: string, eid: string, targeting: unknown) =>
    env.DB.prepare("update experiments set targeting_json = ? where site_id = ? and id = ?").bind(JSON.stringify(targeting), sid, eid).run();
  /** オーディエンスの定義を D1 に直接書く(古い条件は保存の検査を通らないため) */
  const writeAudience = (sid: string, aid: string, definition: unknown) =>
    env.DB.prepare(
      "insert into audiences (site_id, id, name, definition_json, created_at, updated_at) values (?1, ?2, ?2, ?3, 1, 1) on conflict (site_id, id) do update set definition_json = excluded.definition_json",
    ).bind(sid, aid, JSON.stringify(definition)).run();
  const planRow = (sid: string, eid: string) => getDb(env).selectFrom("evaluation_plans").selectAll().where("site_id", "=", sid).where("experiment_id", "=", eid).executeTakeFirst();
  let siteSeq = 0;
  /** 結果を記録するサイトのテスト(開始で run_id を振り、評価計画を固定する) */
  async function recordingTest(owner: Awaited<ReturnType<typeof setupOwner>>, eid: string) {
    const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "Site", domains: [`www.b69-${++siteSeq}.example.com`] }, envOverride: RESULTS_STORE });
    expect(res.status).toBe(201);
    const { id: sid } = await json<{ id: string }>(res);
    await createExperiment(owner.token, sid, { id: eid });
    await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    await choosePrimaryGoal(owner.token, sid, eid);
    return sid;
  }

  it("start_and_resume_reject_moved_page_condition", async () => {
    const owner = await setupOwner();
    // assetGuardEnabled が真(既定の R2 あり)と偽(R2 もアップローダーも無い)の両方で
    for (const [label, guardOff] of [["guard", {}], ["no guard", { ASSETS: undefined }]] as const) {
      for (const via of ["direct", "audience"] as const) {
        for (const from of ["draft", "paused"] as const) {
          const eid = `exp_${via}_${from}_${label === "guard" ? "g" : "n"}`;
          const sid = await recordingTest(owner, eid);
          if (via === "direct") await writeTargeting(sid, eid, { and: [DEVICE, QUERY] });
          else {
            await writeAudience(sid, "aud_old", { or: [DEVICE, { not: { ctx: "path", op: "startsWith", value: "/lp/" } }] });
            await writeTargeting(sid, eid, { and: [DEVICE, { audience: "aud_old" }] });
          }
          if (from === "paused") await runDirect(sid, eid, "paused");
          const before = await experimentRow(sid, eid);
          const plan = await planRow(sid, eid);
          const res = await setStatus(owner.token, sid, eid, "running", { ...RESULTS_STORE, ...guardOff });
          const tag = `${label} ${via} ${from}`;
          expect(res.status, tag).toBe(422);
          const body = await json(res);
          if (via === "direct") expect(body, tag).toMatchObject({ error: "invalid_experiment_targeting", path: ["targeting", "and", 1], message: PAGE_CONDITION_MOVED_MESSAGE, hint: PAGE_CONDITION_MOVED_HINT });
          else expect(body, tag).toMatchObject({ error: "invalid_experiment_targeting", audience: "aud_old", message: PAGE_CONDITION_MOVED_AUDIENCE_MESSAGE, hint: PAGE_CONDITION_MOVED_AUDIENCE_HINT });
          // 状態・開始時刻・run_id・評価計画は変わらない(CAS も公開も走らない)
          expect(await experimentRow(sid, eid), tag).toEqual(before);
          expect(await planRow(sid, eid), tag).toEqual(plan);
          expect((await siteRow(sid)).active_version, tag).toBeNull();
        }
      }
    }
  });

  it("start reads only the audiences of the same site (another site's legacy audience with the same id does not block)", async () => {
    const owner = await setupOwner();
    const { id: other } = await createSite(owner.token, owner.workspaceId);
    await writeAudience(other, "aud_x", { ctx: "query", name: "a", op: "exists" });
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    expect((await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: { id: "aud_x", name: "X", definition: DEVICE } })).status).toBe(201);
    const { id: eid } = await createExperiment(owner.token, sid, { targeting: { audience: "aud_x" } });
    await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    const res = await setStatus(owner.token, sid, eid, "running");
    expect(res.status).toBe(200);
    expect((await json(res)).publish.ok).toBe(true);
  });

  it("start_reads_at_most_one_more_d1", async () => {
    const owner = await setupOwner();
    /** 同じ形のサイトで 1 回開始し、D1 の往復(文の実行 + batch)を数える */
    const startTrips = async (targeting: unknown, audience: boolean) => {
      const { id: sid } = await createSite(owner.token, owner.workspaceId);
      if (audience) expect((await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: { id: "aud_ok", name: "OK", definition: DEVICE } })).status).toBe(201);
      const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_load", ...(targeting !== null ? { targeting } : {}) });
      await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
      const counter = countingD1(env.DB);
      const res = await setStatus(owner.token, sid, eid, "running", { DB: counter.db });
      expect(res.status).toBe(200);
      expect((await json(res)).publish.ok).toBe(true);
      const c = counter.counts();
      return { trips: c.queries + c.batches, sql: c.sql };
    };
    const none = await startTrips(null, false);
    const device = await startTrips(DEVICE, false);
    const viaAudience = await startTrips({ and: [DEVICE, { audience: "aud_ok" }] }, true);
    // オーディエンスを参照しない開始は今と同じ回数。参照する開始だけ、その定義の読み 1 回が増える
    expect(device.trips).toBe(none.trips);
    expect(viaAudience.trips).toBe(none.trips + 1);
    const audienceReads = (s: string[]) => s.filter((q) => /from "audiences"/.test(q) && /json_each/.test(q)).length;
    expect(audienceReads(none.sql)).toBe(0);
    expect(audienceReads(viaAudience.sql)).toBe(1);
  });

  it("pause_and_archive_pass_on_legacy_row", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    for (const [eid, targeting] of [["exp_direct", QUERY], ["exp_aud", { audience: "aud_old" }]] as const) {
      await createExperiment(owner.token, sid, { id: eid });
      await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
      await runDirect(sid, eid, "running");
      await writeTargeting(sid, eid, targeting);
    }
    await writeAudience(sid, "aud_old", { ctx: "host", op: "equals", value: "example.com" });
    // 一時停止・終了は止めない(片付けを止めない)。一時停止で 2 つとも配る設定から外れたので公開も通る
    expect((await setStatus(owner.token, sid, "exp_direct", "paused")).status).toBe(200);
    const paused = await setStatus(owner.token, sid, "exp_aud", "paused");
    expect(paused.status).toBe(200);
    expect((await json(paused)).publish.ok).toBe(true);
    for (const eid of ["exp_direct", "exp_aud"]) {
      const res = await setStatus(owner.token, sid, eid, "archived");
      expect(res.status, eid).toBe(200);
      expect((await json(res)).publish.ok, eid).toBe(true);
      expect((await experimentRow(sid, eid)).status).toBe("archived");
    }
  });
});
