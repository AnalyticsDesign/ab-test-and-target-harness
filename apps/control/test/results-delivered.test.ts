import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { staticInputDigest, type StaticDeployHistoryEntry, type StaticGeneration } from "@wtt/core";
import { resultsDeliveryJob } from "../src/cron/results-jobs";
import { runCron } from "../src/cron/runner";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { publishSite } from "../src/publish";
import { changedParts, confirmDeliveries, deliveredAt, recordDeliveredDefinitions, sitesNeedingDeliveryConfirmation, type DeliveredDefinition } from "../src/results/delivered";
import type { WriteGuard } from "../src/results/guard";
import { genOf, reconcileStatic } from "../src/static-delivery";
import {
  beforeD1Batch,
  call,
  choosePrimaryGoal,
  createExperiment,
  createSite,
  experimentRow,
  failingD1Query,
  fakeDeployer,
  fakeResultsBudget,
  fakeResultsHealth,
  json,
  otherStaticInput,
  publishRes,
  RESULTS_STORE,
  setupOwner,
  siteRow,
  staticInputOf,
  testEnv,
  testEnvWith,
  TEXT_CHANGE,
} from "./helpers";

// D9 ③(設計書 §5.5、plan ③ の K14・Task 7): 届く定義の記録・配信の確認・テスト中の変更

const db = () => getDb(env as unknown as Env);
const noGuard: WriteGuard = async () => {};
const iso = (ms: number) => new Date(ms).toISOString();
const g = (seq: number): StaticGeneration => ({ epoch: 1, seq });
const point = (seq: number, at: number) => ({ generation: g(seq), deployedAt: iso(at) });

/** パターン b の文言だけが違う届く定義 */
const def = (text: string, over: Partial<DeliveredDefinition> = {}): DeliveredDefinition => ({
  variants: [
    { id: "a", changes: [] },
    { id: "b", changes: [{ id: "c_text", type: "TEXT", selector: ".hero-title", payload: { text } }] },
  ],
  urlMatch: { op: "contains", value: "/" },
  targeting: null,
  primaryGoal: { id: "g_primary", config: {} },
  ...over,
});

/** 直接の検査用: run_id を持つ実行中のテストを 1 つ持つ Site(行・依頼・公開の記録は SQL と record で入れる) */
async function unitSite(existing?: Awaited<ReturnType<typeof setupOwner>>) {
  const owner = existing ?? (await setupOwner());
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_unit" });
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`;
  await sql`update experiments set status = 'running', run_id = ${runId} where site_id = ${sid} and id = ${eid}`.execute(db());
  return { owner, sid, eid, runId };
}
/** 届く定義の行を直接足す(activation の fence なし)。run_id はエクスペリエンスの行から取る */
async function record(s: { sid: string; eid: string }, version: number, gen: StaticGeneration | null, d: DeliveredDefinition) {
  await recordDeliveredDefinitions(db(), s.sid, version, gen, new Map([[s.eid, d]]), [await experimentRow(s.sid, s.eid)]);
}
/** 公開の記録(テスト中の変更の by に使う) */
async function seedPublish(sid: string, version: number, by: string, at: number) {
  await sql`insert into publishes (id, site_id, version, status, published_by, created_at, activated_at) values (${`pub_${sid}_${version}`}, ${sid}, ${version}, 'active', ${by}, ${at}, ${at})`.execute(db());
}
/** 出し直しの依頼の記録(世代 → 焼いた版)。inputDigest を省くと更新前の形(input_digest が NULL) */
async function seedRequest(sid: string, seq: number, version: number, requestedAt: number, inputDigest: string | null = null) {
  await db().insertInto("static_deploy_requests").values({ site_id: sid, epoch: 1, seq, version, requested_at: requestedAt, input_digest: inputDigest }).execute();
}
/** 配った入力の digest を持つ履歴の点(7o K24) */
const digestPoint = (seq: number, at: number, digest: string) => ({ ...point(seq, at), digest });
async function rows(sid: string) {
  return db().selectFrom("experiment_delivered_definitions").selectAll().where("site_id", "=", sid).orderBy("publish_version").execute();
}
async function rowOf(sid: string, version: number) {
  return db().selectFrom("experiment_delivered_definitions").selectAll().where("site_id", "=", sid).where("publish_version", "=", version).executeTakeFirstOrThrow();
}
async function changes(sid: string) {
  return db().selectFrom("experiment_delivery_changes").select(["publish_version", "at", "by", "parts_json"]).where("site_id", "=", sid).orderBy("publish_version").execute();
}
const textOf = (d: DeliveredDefinition | undefined) => (d?.variants[1]!.changes[0]?.payload as { text: string } | undefined)?.text;

/** 計測用 D1 がある導入の Site(結果を記録する) */
async function resultsSite(existing?: Awaited<ReturnType<typeof setupOwner>>) {
  const owner = existing ?? (await setupOwner());
  const res = await call("POST", `/workspaces/${owner.workspaceId}/sites`, { token: owner.token, body: { name: "Site", domain: "www.example.com" }, envOverride: RESULTS_STORE });
  expect(res.status).toBe(201);
  const { id: sid } = await json<{ id: string }>(res);
  return { owner, sid };
}
async function testExperiment(token: string, sid: string, id: string, overrides: Record<string, unknown> = {}) {
  await createExperiment(token, sid, { id, ...overrides });
  expect((await call("PUT", `/sites/${sid}/experiments/${id}/variants/b/changes`, { token, body: [TEXT_CHANGE()] })).status).toBe(200);
  await choosePrimaryGoal(token, sid, id);
}
async function transition(token: string, sid: string, eid: string, status: string, envOverride: Partial<Env> = {}) {
  const res = await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body: { status }, envOverride: { ...RESULTS_STORE, ...envOverride } });
  expect(res.status).toBe(200);
  expect((await json(res)).publish.ok).toBe(true);
}
async function publishOk(token: string, sid: string, envOverride?: Partial<Env>) {
  const r = await json(await publishRes(token, sid, envOverride));
  expect(r.ok).toBe(true);
  return r;
}
const setText = (token: string, sid: string, eid: string, text: string) =>
  call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body: [{ ...TEXT_CHANGE(), payload: { text } }] });

async function freeze() {
  await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', ?, 1000, null) on conflict(key) do update set value = excluded.value")
    .bind('{"reason":"r"}')
    .run();
}
/** 最初の batch(publishSite の activation の batch)が済んだ直後に hook を 1 回だけ実行する D1 ラッパ */
function afterFirstBatch(d1: D1Database, hook: () => Promise<unknown>): D1Database {
  let ran = false;
  return new Proxy(d1, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          const out = await target.batch(stmts);
          if (!ran) {
            ran = true;
            await hook();
          }
          return out;
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}
const unfreeze = () => env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();

describe("届く定義(D9 ③ K14)", () => {
  it("Publish で実行中のテストの定義を 1 行作り、同じ定義の再公開では作らない", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_t");
    await transition(owner.token, sid, "exp_t", "running"); // 開始の自動 Publish
    const runId = (await experimentRow(sid, "exp_t")).run_id!;
    let rs = await rows(sid);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ experiment_id: "exp_t", run_id: runId, delivered_from: null, settled: null });
    const d = JSON.parse(rs[0]!.definition_json) as DeliveredDefinition;
    expect(d).toEqual({
      variants: [{ id: "a", changes: [] }, { id: "b", changes: [TEXT_CHANGE()] }],
      urlMatch: { op: "contains", value: "/" },
      targeting: null,
      primaryGoal: { id: "g_primary", config: {} },
    });
    expect(rs[0]!.definition_json).not.toContain('"name"'); // 名前は入れない
    expect(rs[0]!.definition_hash).toMatch(/^[0-9a-f]{64}$/);
    // 同じ定義の再公開・名前だけの変更では作らない
    await publishOk(owner.token, sid);
    expect((await call("PATCH", `/sites/${sid}/experiments/exp_t`, { token: owner.token, body: { name: "改名" } })).status).toBe(200);
    await publishOk(owner.token, sid);
    expect(await rows(sid)).toHaveLength(1);
    // 中身が変われば作る
    expect((await setText(owner.token, sid, "exp_t", "Changed")).status).toBe(200);
    const pub = await publishOk(owner.token, sid);
    rs = await rows(sid);
    expect(rs).toHaveLength(2);
    expect(rs[1]!.publish_version).toBe(pub.version);
    expect(textOf(JSON.parse(rs[1]!.definition_json))).toBe("Changed");
  });

  it("delivered_from_is_set_when_static_generation_is_deployed", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_t");
    const fake = fakeDeployer();
    await transition(owner.token, sid, "exp_t", "running", { DEPLOYER: fake });
    const [row] = await rows(sid);
    const site = await siteRow(sid);
    // Publish の世代そのものが配られた: その時刻を delivered_from に入れる(Publish の応答の 1 点 = 仮。settled は NULL のまま)
    expect(JSON.parse(row!.static_generation!)).toEqual(fake.deploys[0]!.generation);
    expect(row!.delivered_from).toBe(Date.parse((await fake.siteStatus(sid)).deployedAt!));
    expect(row!.settled).toBeNull();
    expect((await deliveredAt(db(), sid, "exp_t", row!.delivered_from!))?.definition).toEqual(JSON.parse(row!.definition_json));
    expect(await deliveredAt(db(), sid, "exp_t", row!.delivered_from! - 1)).toBeNull();
    // 自己修復(reconcileStatic)は history の全体で確かめ直し、配信済みに確定する
    await sql`update sites set static_stale = 1 where id = ${sid}`.execute(db());
    await reconcileStatic({ ...testEnv, DEPLOYER: fake }, db(), { ...site, static_stale: 1 }, () => {});
    expect(await rowOf(sid, row!.publish_version)).toMatchObject({ delivered_from: row!.delivered_from, settled: "delivered" });
  });

  it("overtaken_generation_is_never_used_as_delivered", async () => {
    const s = await unitSite();
    await seedPublish(s.sid, 3, "u3", 2_500);
    await seedPublish(s.sid, 4, "u4", 3_500);
    await record(s, 3, g(3), def("v3"));
    await record(s, 4, g(4), def("v4"));
    await seedRequest(s.sid, 3, 3, 2_500);
    await seedRequest(s.sid, 4, 4, 3_500);
    // Publish の応答の 1 点(partial)では、版 3 を overtaken にしない
    await confirmDeliveries(db(), s.sid, { history: [point(4, 4_000)], historyFrom: null, partial: true }, 5_000, noGuard, null);
    expect((await rowOf(s.sid, 3)).settled).toBeNull();
    // 世代 4 だけが history にある(全体): 版 3 は overtaken、版 4 は delivered
    await confirmDeliveries(db(), s.sid, { history: [point(4, 4_000)], historyFrom: null }, 5_000, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: null, settled: "overtaken" });
    expect(await rowOf(s.sid, 4)).toMatchObject({ delivered_from: 4_000, delivered_until: null, settled: "delivered" });
    expect(await deliveredAt(db(), s.sid, s.eid, 3_900)).toBeNull();
    expect(textOf((await deliveredAt(db(), s.sid, s.eid, 4_500))?.definition)).toBe("v4");
    // 版 3 は配信していないので、テスト中の変更の比較にも使わない
    expect(await changes(s.sid)).toEqual([]);
  });

  it("pending_generation_deployed_before_next_publish_is_preserved", async () => {
    const s = await unitSite();
    for (const [v, at] of [[2, 1_500], [3, 2_500], [4, 3_500]] as const) {
      await seedPublish(s.sid, v, `u${v}`, at);
      await record(s, v, g(v), def(`v${v}`));
      await seedRequest(s.sid, v, v, at);
    }
    await confirmDeliveries(db(), s.sid, { history: [point(2, 2_000)], historyFrom: null }, 2_100, noGuard, null);
    // 版 3 の出し直しは pending(8 秒を超えた)。後で世代 3 が 3,000 に配られ、版 4 は deployed で 1 点の確認(partial)
    await confirmDeliveries(db(), s.sid, { history: [point(4, 4_000)], historyFrom: null, partial: true }, 4_100, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: null, settled: null }); // 未確定のまま(overtaken にしない)
    expect(await rowOf(s.sid, 4)).toMatchObject({ delivered_from: 4_000, settled: null });
    expect((await rowOf(s.sid, 2)).delivered_until).toBe(4_000);
    expect(await changes(s.sid)).toEqual([{ publish_version: 4, at: 4_000, by: "u4", parts_json: '["variants.b.changes"]' }]);
    // Cron の history の全体(新しい順): 版 3 が世代 3 の時刻で delivered、delivered_until = 版 4 の delivered_from
    await confirmDeliveries(db(), s.sid, { history: [point(4, 4_000), point(3, 3_000), point(2, 2_000)], historyFrom: null }, 5_000, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: 3_000, delivered_until: 4_000, settled: "delivered" });
    expect(await rowOf(s.sid, 4)).toMatchObject({ delivered_from: 4_000, delivered_until: null, settled: "delivered" });
    expect((await rowOf(s.sid, 2)).delivered_until).toBe(3_000);
    // テスト中の変更は版 3・版 4 の順に作り直される
    expect(await changes(s.sid)).toEqual([
      { publish_version: 3, at: 3_000, by: "u3", parts_json: '["variants.b.changes"]' },
      { publish_version: 4, at: 4_000, by: "u4", parts_json: '["variants.b.changes"]' },
    ]);
    expect(textOf((await deliveredAt(db(), s.sid, s.eid, 3_500))?.definition)).toBe("v3");
  });

  it("same_definition_republish_preserves_earliest_delivery", async () => {
    const s = await unitSite();
    await seedPublish(s.sid, 2, "u2", 1_500);
    await record(s, 2, g(2), def("old"));
    await seedRequest(s.sid, 2, 2, 1_500);
    await confirmDeliveries(db(), s.sid, { history: [point(2, 2_000)], historyFrom: null }, 2_100, noGuard, null);
    await seedPublish(s.sid, 3, "u3", 2_500);
    await record(s, 3, g(3), def("same"));
    await seedRequest(s.sid, 3, 3, 2_500);
    // 版 4 は同じ定義の再公開(行を作らない)
    await seedPublish(s.sid, 4, "u4", 3_500);
    await record(s, 4, g(4), def("same"));
    await seedRequest(s.sid, 4, 4, 3_500);
    expect((await rows(s.sid)).map((r) => r.publish_version)).toEqual([2, 3]);
    // 世代 3(版 3)は 3,000 に、世代 4(版 4)は 4,000 に配られた。版 4 の 1 点の確認(partial)が先に来る
    await confirmDeliveries(db(), s.sid, { history: [point(4, 4_000)], historyFrom: null, partial: true }, 4_100, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: 4_000, settled: null });
    expect(textOf((await deliveredAt(db(), s.sid, s.eid, 3_500))?.definition)).toBe("old"); // まだ早い点を知らない
    // Cron の history の全体: より早い点(世代 3 の 3,000)を見つけたので早い方へ直し、配信済みに確定する
    await confirmDeliveries(db(), s.sid, { history: [point(4, 4_000), point(3, 3_000), point(2, 2_000)], historyFrom: null }, 5_000, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: 3_000, delivered_until: null, settled: "delivered" });
    expect((await rowOf(s.sid, 2)).delivered_until).toBe(3_000);
    const at3500 = await deliveredAt(db(), s.sid, s.eid, 3_500);
    expect(textOf(at3500?.definition)).toBe("same");
    expect(at3500?.deliveredFrom).toBe(3_000);
    expect(await changes(s.sid)).toEqual([{ publish_version: 3, at: 3_000, by: "u3", parts_json: '["variants.b.changes"]' }]);
    // 後でもう一度 1 点の確認(partial)が来ても、遅い方へは戻さず、確定も外さない
    await confirmDeliveries(db(), s.sid, { history: [point(4, 4_000)], historyFrom: null, partial: true }, 6_000, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: 3_000, settled: "delivered" });
  });

  it("same_definition_republish_is_delivered_by_later_generation", async () => {
    const s = await unitSite();
    await seedPublish(s.sid, 3, "u3", 2_500);
    await seedPublish(s.sid, 4, "u4", 3_500);
    await record(s, 3, g(3), def("same"));
    await record(s, 4, g(4), def("same"));
    await seedRequest(s.sid, 3, 3, 2_500);
    await seedRequest(s.sid, 4, 4, 3_500);
    expect(await rows(s.sid)).toHaveLength(1);
    // 世代 3 は配られず、世代 4 だけが deployed。版 3 の行が世代 4 の時刻で delivered(overtaken にしない)
    expect(await confirmDeliveries(db(), s.sid, { history: [point(4, 4_000)], historyFrom: null }, 5_000, noGuard, null)).toBe(1);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: 4_000, settled: "delivered" });
  });

  it("truncated_history_marks_unknown", async () => {
    const s = await unitSite();
    await seedPublish(s.sid, 3, "u3", 1_000);
    await seedPublish(s.sid, 4, "u4", 2_500);
    await record(s, 3, g(3), def("v3"));
    await record(s, 4, g(4), def("v4"));
    await seedRequest(s.sid, 3, 3, 1_000);
    await seedRequest(s.sid, 4, 4, 2_500);
    // 履歴は 2,000 より前を切り詰めている。版 3 の依頼(1,000)はそれより前で history に無く、後の行も確かめられていない → unknown
    await confirmDeliveries(db(), s.sid, { history: [point(9, 2_200)], historyFrom: iso(2_000), partial: true }, 3_000, noGuard, null);
    expect((await rowOf(s.sid, 3)).settled).toBeNull(); // partial では決めない
    await confirmDeliveries(db(), s.sid, { history: [point(9, 2_200)], historyFrom: iso(2_000) }, 3_000, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: null, settled: "unknown" });
    // 版 4 の依頼(2,500)は切り詰めた範囲の後。まだ配られていないだけなので未確定のまま
    expect(await rowOf(s.sid, 4)).toMatchObject({ delivered_from: null, settled: null });
    expect(await deliveredAt(db(), s.sid, s.eid, 2_900)).toBeNull();
  });

  it("redeploy_failure_preserves_delivered_definition", async () => {
    const s = await unitSite();
    await seedPublish(s.sid, 2, "u2", 1_500);
    await record(s, 2, g(2), def("v2"));
    await seedRequest(s.sid, 2, 2, 1_500);
    await confirmDeliveries(db(), s.sid, { history: [point(2, 2_000)], historyFrom: null }, 2_100, noGuard, null);
    // 出し直しに失敗した Publish(世代が無い): static_generation は NULL
    await seedPublish(s.sid, 3, "u3", 2_500);
    await record(s, 3, null, def("v3"));
    expect((await rowOf(s.sid, 3)).static_generation).toBeNull();
    await confirmDeliveries(db(), s.sid, { history: [point(2, 2_000)], historyFrom: null }, 3_000, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: null, settled: null }); // 未確定のまま
    expect(textOf((await deliveredAt(db(), s.sid, s.eid, 5_000))?.definition)).toBe("v2"); // 前の定義が有効のまま
    // 自己修復の出し直し(世代 5)がその版を焼いて配られた → 配信済み
    await seedRequest(s.sid, 5, 3, 4_500);
    await confirmDeliveries(db(), s.sid, { history: [point(5, 5_000), point(2, 2_000)], historyFrom: null }, 5_100, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: 5_000, settled: "delivered" });
    expect((await rowOf(s.sid, 2)).delivered_until).toBe(5_000);
    expect(textOf((await deliveredAt(db(), s.sid, s.eid, 4_999))?.definition)).toBe("v2");
    expect(textOf((await deliveredAt(db(), s.sid, s.eid, 5_000))?.definition)).toBe("v3");
    // その版より後を焼いた世代でも確かめられる(版 4 は同じ定義で行が無い)
    const t = await unitSite(s.owner);
    await seedPublish(t.sid, 3, "u3", 2_500);
    await record(t, 3, null, def("v3"));
    await seedRequest(t.sid, 6, 4, 5_500);
    await confirmDeliveries(db(), t.sid, { history: [point(6, 6_000)], historyFrom: null }, 6_100, noGuard, null);
    expect(await rowOf(t.sid, 3)).toMatchObject({ delivered_from: 6_000, settled: "delivered" });
  });

  it("superseded_publish_does_not_advance_delivered_definition", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_t");
    await transition(owner.token, sid, "exp_t", "running");
    expect(await rows(sid)).toHaveLength(1);
    expect((await setText(owner.token, sid, "exp_t", "Changed")).status).toBe(200);
    // 自分より新しい版が先に active になっている = この Publish は superseded
    await sql`update sites set active_version = 999 where id = ${sid}`.execute(db());
    const r = await publishSite({ ...testEnv, DEPLOYER: fakeDeployer() }, db(), await siteRow(sid), owner.userId);
    expect(r).toMatchObject({ ok: true, superseded: true });
    expect(await rows(sid)).toHaveLength(1);
  });

  it("Change・配信条件・オーディエンスの編集・目標の定義の編集をテスト中の変更として拾う。変わらなければ記録しない", async () => {
    const { owner, sid } = await resultsSite();
    const token = owner.token;
    const page = (value: string) => ({ part: "path", op: "startsWith", value });
    expect((await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_primary", name: "完了", type: "PAGEVIEW", config: { page: page("/thanks/") } } })).status).toBe(201);
    expect((await call("POST", `/sites/${sid}/audiences`, { token, body: { id: "aud_x", name: "料金", definition: { hist: "visited", page: page("/pricing/"), min: 1, withinDays: 30 } } })).status).toBe(201);
    await testExperiment(token, sid, "exp_t", { targeting: { audience: "aud_x" } });
    const fake = fakeDeployer();
    const viaFake = { DEPLOYER: fake };
    await transition(token, sid, "exp_t", "running", viaFake);
    const first = JSON.parse((await rows(sid))[0]!.definition_json) as DeliveredDefinition;
    // オーディエンスの参照は定義に置き換える
    expect(first.targeting).toEqual({ hist: "visited", page: expect.objectContaining({ value: "/pricing/" }), withinDays: 30 }); // min: 1 は既定値で保存時に省かれる
    expect(first.primaryGoal).toEqual({ id: "g_primary", config: { page: expect.objectContaining({ value: "/thanks/" }) } });
    // ① Change
    expect((await setText(token, sid, "exp_t", "Changed")).status).toBe(200);
    await publishOk(token, sid, viaFake);
    // ② オーディエンスの編集
    expect((await call("PATCH", `/sites/${sid}/audiences/aud_x`, { token, body: { definition: { hist: "visited", page: page("/pricing/"), min: 2, withinDays: 30 } } })).status).toBe(200);
    await publishOk(token, sid, viaFake);
    // ③ 配信条件(エクスペリエンスの targeting)
    const targeting = { and: [{ audience: "aud_x" }, { ctx: "device", op: "in", value: ["mobile"] }] };
    expect((await call("PATCH", `/sites/${sid}/experiments/exp_t`, { token, body: { targeting } })).status).toBe(200);
    await publishOk(token, sid, viaFake);
    // ④ 判定に使う目標の定義
    expect((await call("PATCH", `/sites/${sid}/goals/g_primary`, { token, body: { config: { page: page("/done/") } } })).status).toBe(200);
    await publishOk(token, sid, viaFake);
    // ⑤ 変わらない再公開
    await publishOk(token, sid, viaFake);
    expect(await rows(sid)).toHaveLength(5);
    const recorded = await changes(sid);
    expect(recorded.map((c) => JSON.parse(c.parts_json))).toEqual([["variants.b.changes"], ["targeting"], ["targeting"], ["primaryGoal"]]);
    expect(recorded.every((c) => c.by === owner.userId)).toBe(true);
    const confirmedRows = await rows(sid);
    expect(recorded.map((c) => c.at)).toEqual(confirmedRows.slice(1).map((r) => r.delivered_from));
    // 部分の比較(変わらなければ空)
    expect(changedParts(def("x"), def("x"))).toEqual([]);
    expect(changedParts(def("x"), def("y", { urlMatch: { op: "contains", value: "/lp" } }))).toEqual(["variants.b.changes", "urlMatch"]);
  });

  it("一時停止中のテストは行を作らない(直前の定義のまま)", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_t");
    const fake = fakeDeployer();
    await transition(owner.token, sid, "exp_t", "running", { DEPLOYER: fake });
    await transition(owner.token, sid, "exp_t", "paused", { DEPLOYER: fake });
    const [before] = await rows(sid);
    expect(await rows(sid)).toHaveLength(1);
    expect((await setText(owner.token, sid, "exp_t", "While paused")).status).toBe(200);
    await publishOk(owner.token, sid, { DEPLOYER: fake });
    expect(await rows(sid)).toHaveLength(1);
    expect(textOf((await deliveredAt(db(), sid, "exp_t", Date.now() + 60_000))?.definition)).toBe("Hello");
    expect(before!.delivered_from).not.toBeNull();
  });

  it("凍結中の reconcileStatic は confirmDeliveries を呼ばない", async () => {
    const s = await unitSite();
    await seedPublish(s.sid, 3, "u3", 2_500);
    await record(s, 3, null, def("v3"));
    const site = await siteRow(s.sid);
    const mine = genOf(site); // 自己修復は自分の世代が配られていれば印を下ろすだけ(依頼し直さない)
    await db().insertInto("static_deploy_requests").values({ site_id: s.sid, epoch: mine.epoch, seq: mine.seq, version: 3, requested_at: 3_000 }).execute();
    const fake = fakeDeployer();
    fake.setStatus({ accepted: mine, deployed: mine, deployedAt: iso(4_000), history: [{ generation: mine, deployedAt: iso(4_000) }], historyFrom: null, pending: false, lastError: null });
    const stale = { ...site, static_stale: 1 };
    await freeze();
    try {
      await reconcileStatic({ ...testEnv, DEPLOYER: fake }, db(), stale, () => {});
      expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: null, settled: null });
    } finally {
      await unfreeze();
    }
    await sql`update sites set static_stale = 1 where id = ${s.sid}`.execute(db());
    await reconcileStatic({ ...testEnv, DEPLOYER: fake }, db(), stale, () => {});
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: 4_000, settled: "delivered" });
    // guard が投げれば書かない(凍結の確かめは各文の直前)
    const t = await unitSite(s.owner);
    await seedPublish(t.sid, 3, "u3", 2_500);
    await record(t, 3, g(3), def("v3"));
    await seedRequest(t.sid, 3, 3, 2_500);
    const frozenGuard: WriteGuard = async () => {
      throw new Error("frozen");
    };
    await expect(confirmDeliveries(db(), t.sid, { history: [point(3, 3_000)], historyFrom: null }, 3_100, frozenGuard, null)).rejects.toThrow("frozen");
    expect(await rowOf(t.sid, 3)).toMatchObject({ delivered_from: null, settled: null });
  });

  // ---- fix round 1 ----

  it("the delivered row is written with the activation: a publish that activated always has its row", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_t");
    await transition(owner.token, sid, "exp_t", "running");
    // ① activation の前に読むもの(評価計画)が落ちる → activation しない(版は進まず、行も無い)
    expect((await setText(owner.token, sid, "exp_t", "Changed 0")).status).toBe(200);
    const before = (await siteRow(sid)).active_version;
    const failed = await publishRes(owner.token, sid, { DB: failingD1Query(env.DB, /evaluation_plans/) });
    expect(failed.status === 200 ? (await json(failed)).ok : false).toBe(false);
    expect((await siteRow(sid)).active_version).toBe(before);
    // ② activation の後に書くもの(世代)が落ちる → activation 済みで行がある。世代は NULL のまま(依頼の記録から引ける)
    expect((await setText(owner.token, sid, "exp_t", "Changed 1")).status).toBe(200);
    const res = await json(
      await publishRes(owner.token, sid, { DB: failingD1Query(env.DB, /^update "experiment_delivered_definitions" set "static_generation"/), DEPLOYER: fakeDeployer() }),
    );
    expect(res).toMatchObject({ ok: true, superseded: false, staticDeploy: "deployed" });
    expect((await siteRow(sid)).active_version).toBe(res.version);
    expect(res.version).toBeGreaterThan(before!);
    const row = await rowOf(sid, res.version);
    expect(textOf(JSON.parse(row.definition_json))).toBe("Changed 1");
    expect(row.static_generation).toBeNull();
  });

  it("an experiment deleted between compile and activation gets no row and the publish still activates", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_t");
    await transition(owner.token, sid, "exp_t", "running");
    expect((await setText(owner.token, sid, "exp_t", "Changed")).status).toBe(200);
    const wrapped = beforeD1Batch(env.DB, () => env.DB.prepare("delete from experiments where site_id = ? and id = ?").bind(sid, "exp_t").run());
    const r = await publishSite({ ...testEnv, DB: wrapped }, db(), await siteRow(sid), owner.userId);
    expect(r).toMatchObject({ ok: true, superseded: false });
    expect((await siteRow(sid)).active_version).toBe((r as { version: number }).version);
    expect(await rows(sid)).toEqual([]); // 消えたエクスペリエンスの行は外部キーの CASCADE で消え、新しい版の行も足さない
  });

  it("a concurrent publish that reverts the definition gets its own row (rows are written in version order)", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_t");
    await transition(owner.token, sid, "exp_t", "running"); // 版 1 = Hello
    expect((await setText(owner.token, sid, "exp_t", "Changed")).status).toBe(200);
    let reverted: number | null = null;
    // A の activation の直後(出し直しの前)に、B が定義を元に戻して Publish する
    const wrapped = afterFirstBatch(env.DB, async () => {
      expect((await setText(owner.token, sid, "exp_t", "Hello")).status).toBe(200);
      reverted = (await publishOk(owner.token, sid)).version;
    });
    const a = await publishSite({ ...testEnv, DB: wrapped }, db(), await siteRow(sid), owner.userId);
    expect(a).toMatchObject({ ok: true, superseded: false });
    expect(reverted).toBe((a as { version: number }).version + 1);
    const rs = await rows(sid);
    expect(rs.map((r) => [r.publish_version, textOf(JSON.parse(r.definition_json))])).toEqual([
      [rs[0]!.publish_version, "Hello"],
      [(a as { version: number }).version, "Changed"],
      [reverted, "Hello"],
    ]);
  });

  it("a self-repair during the deploy wait maps the new generation to the new row, not the previous one", async () => {
    const { owner, sid } = await resultsSite();
    await testExperiment(owner.token, sid, "exp_t");
    await transition(owner.token, sid, "exp_t", "running"); // DEPLOYER なし: 版 1 の行は配られていない
    const [first] = await rows(sid);
    expect((await setText(owner.token, sid, "exp_t", "Changed")).status).toBe(200);
    const fake = fakeDeployer();
    // 出し直しの待ちの間に GET /sites/:sid の自己修復が走る(デプロイ専用の Worker はもう配り終えている)
    const hooked = {
      ...fake,
      async redeploySite(req: Parameters<typeof fake.redeploySite>[0]) {
        const r = await fake.redeploySite(req);
        await reconcileStatic({ ...testEnv, DEPLOYER: fake }, db(), { ...(await siteRow(sid)), static_stale: 1 }, () => {});
        return r;
      },
    };
    const pub = await publishOk(owner.token, sid, { DEPLOYER: hooked });
    const t = Date.parse((await fake.siteStatus(sid)).deployedAt!);
    expect(await rowOf(sid, first!.publish_version)).toMatchObject({ delivered_from: null, delivered_until: null, settled: "overtaken" });
    expect(await rowOf(sid, pub.version)).toMatchObject({ delivered_from: t, settled: "delivered" });
    expect(await changes(sid)).toEqual([]);
  });

  it("an overlapping confirmation keeps the earlier time and the until / changes follow the re-read values", async () => {
    const s = await unitSite();
    await seedPublish(s.sid, 2, "u2", 1_500);
    await record(s, 2, g(2), def("old"));
    await seedRequest(s.sid, 2, 2, 1_500);
    await confirmDeliveries(db(), s.sid, { history: [point(2, 2_000)], historyFrom: null }, 2_100, noGuard, null);
    await seedPublish(s.sid, 3, "u3", 2_500);
    await record(s, 3, g(3), def("same"));
    await seedRequest(s.sid, 3, 3, 2_500);
    await seedPublish(s.sid, 4, "u4", 3_500);
    await seedRequest(s.sid, 4, 4, 3_500); // 版 4 は同じ定義(行なし)
    // 外の確認(世代 4 @4000)が版 3 の行を書く直前に、別の確認(世代 3 @3000)が割り込む
    let raced = false;
    const racingGuard: WriteGuard = async () => {
      if (raced) return;
      raced = true;
      await confirmDeliveries(db(), s.sid, { history: [point(3, 3_000)], historyFrom: null, partial: true }, 3_100, noGuard, null);
    };
    await confirmDeliveries(db(), s.sid, { history: [point(4, 4_000)], historyFrom: null, partial: true }, 4_100, racingGuard, null);
    expect(raced).toBe(true);
    expect((await rowOf(s.sid, 3)).delivered_from).toBe(3_000); // 遅い方で上書きしない
    expect((await rowOf(s.sid, 2)).delivered_until).toBe(3_000); // 読み直した値で付け直す
    expect(await changes(s.sid)).toEqual([{ publish_version: 3, at: 3_000, by: "u3", parts_json: '["variants.b.changes"]' }]);

    // overtaken の書き込みも、割り込んだ確認が配信を確かめていたら書かない
    const t = await unitSite(s.owner);
    await seedPublish(t.sid, 3, "u3", 2_500);
    await seedPublish(t.sid, 4, "u4", 3_500);
    await record(t, 3, g(3), def("v3"));
    await record(t, 4, g(4), def("v4"));
    await seedRequest(t.sid, 3, 3, 2_500);
    await seedRequest(t.sid, 4, 4, 3_500);
    let raced2 = false;
    const racingGuard2: WriteGuard = async () => {
      if (raced2) return;
      raced2 = true;
      await confirmDeliveries(db(), t.sid, { history: [point(4, 4_000), point(3, 3_000)], historyFrom: null }, 4_100, noGuard, null);
    };
    // 数えるのは実際に変えた行だけ(版 3 の overtaken は書かれなかった。版 4 の 1 行)
    expect(await confirmDeliveries(db(), t.sid, { history: [point(4, 4_000)], historyFrom: null }, 4_100, racingGuard2, null)).toBe(1);
    expect(raced2).toBe(true);
    expect(await rowOf(t.sid, 3)).toMatchObject({ delivered_from: 3_000, delivered_until: 4_000, settled: "delivered" });
    expect(await changes(t.sid)).toEqual([{ publish_version: 4, at: 4_000, by: "u4", parts_json: '["variants.b.changes"]' }]);
  });

  it("confirmDeliveries reads only runs that still have an unsettled row", async () => {
    const s = await unitSite();
    await seedPublish(s.sid, 3, "u3", 2_500);
    await record(s, 3, g(3), def("v3"));
    await seedRequest(s.sid, 3, 3, 2_500);
    await confirmDeliveries(db(), s.sid, { history: [point(3, 3_000)], historyFrom: null }, 3_100, noGuard, null);
    expect(await rowOf(s.sid, 3)).toMatchObject({ delivered_from: 3_000, settled: "delivered" });
    // 確定した run は読まない(同じ世代の別の時刻が来ても触らない)
    expect(await confirmDeliveries(db(), s.sid, { history: [point(3, 2_000)], historyFrom: null }, 3_200, noGuard, null)).toBe(0);
    expect((await rowOf(s.sid, 3)).delivered_from).toBe(3_000);
  });

  it("a run whose latest row is unknown is still read, and a later same-definition generation delivers it", async () => {
    const s = await unitSite();
    await seedPublish(s.sid, 3, "u3", 2_500);
    await seedPublish(s.sid, 4, "u4", 3_500);
    await seedPublish(s.sid, 5, "u5", 5_500);
    await record(s, 3, g(3), def("v3"));
    await record(s, 4, g(4), def("v4"));
    await record(s, 5, g(5), def("v4")); // 版 5 は版 4 と同じ定義(行なし)
    await seedRequest(s.sid, 3, 3, 2_500);
    await seedRequest(s.sid, 4, 4, 3_500);
    await seedRequest(s.sid, 5, 5, 5_500);
    await confirmDeliveries(db(), s.sid, { history: [point(3, 3_000)], historyFrom: null }, 3_100, noGuard, null);
    // 履歴が 4,000 より前を切り詰めた: 版 4 の依頼(3,500)は判断できない → unknown(最新の行)
    await confirmDeliveries(db(), s.sid, { history: [], historyFrom: iso(4_000) }, 4_100, noGuard, null);
    expect(await rowOf(s.sid, 4)).toMatchObject({ delivered_from: null, settled: "unknown" });
    expect(await sitesNeedingDeliveryConfirmation(db())).toContain(s.sid);
    // 世代 5(版 5 = 版 4 と同じ定義)が配られた → 版 4 の行が配信済み
    expect(await confirmDeliveries(db(), s.sid, { history: [point(5, 6_000)], historyFrom: iso(4_000) }, 6_100, noGuard, null)).toBe(1);
    expect(await rowOf(s.sid, 4)).toMatchObject({ delivered_from: 6_000, settled: "delivered" });
    expect((await rowOf(s.sid, 3)).delivered_until).toBe(6_000);
    expect(textOf((await deliveredAt(db(), s.sid, s.eid, 6_500))?.definition)).toBe("v4");
    expect(await sitesNeedingDeliveryConfirmation(db())).not.toContain(s.sid);
  });

  it("run_id を持つ実行中のテストで展開の上限を超える Publish は、届く定義を作る前に audience_expansion_too_large で止まる(B159、G32)", async () => {
    const { owner, sid } = await resultsSite();
    const leaf = { ctx: "referrer", op: "isEmpty" };
    expect((await call("POST", `/sites/${sid}/audiences`, { token: owner.token, body: { id: "aud_big", name: "大きい", definition: leaf } })).status).toBe(201);
    await testExperiment(owner.token, sid, "exp_t", { targeting: { or: Array.from({ length: 500 }, () => ({ audience: "aud_big" })) } });
    await transition(owner.token, sid, "exp_t", "running"); // 開始の自動 Publish(1 ノード × 500 回は上限の内)で run_id が付く
    expect((await experimentRow(sid, "exp_t")).run_id).not.toBeNull();
    expect(await rows(sid)).toHaveLength(1);
    // 実行中のまま、オーディエンスを 50 ノードにする(50 × 500 = 25,000 > 20,000)
    const definition = { or: Array.from({ length: 49 }, () => leaf) };
    expect((await call("PATCH", `/sites/${sid}/audiences/aud_big`, { token: owner.token, body: { definition } })).status).toBe(200);
    // 届く定義の記録は定義を JSON にして hash を取る。展開した全ノードの JSON(約 900 KB)が hash に渡らないこと = 記録を作る前に止まったこと
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const r = await json<{ ok: boolean; error?: string }>(await publishRes(owner.token, sid, RESULTS_STORE));
      expect(r).toMatchObject({ ok: false, error: "audience_expansion_too_large" });
      const largest = Math.max(0, ...digest.mock.calls.map(([, data]) => (data as ArrayBufferView | ArrayBuffer).byteLength));
      expect(largest).toBeLessThan(100_000);
    } finally {
      digest.mockRestore();
    }
    expect(await rows(sid)).toHaveLength(1); // 失敗した Publish は届く定義の行を足さない
  });
});

// ---- 7o K24: 世代の再利用で別の中身の配信を証拠にしない ----

describe("配信の確認の入力の digest(7o K24)", () => {
  /** 実行中のテストを持ち、DEPLOYER なしで公開した(依頼を送っていない)Site。版 1 の届く定義の行がある */
  async function runningSite(existing?: Awaited<ReturnType<typeof setupOwner>>) {
    const { owner, sid } = await resultsSite(existing);
    await testExperiment(owner.token, sid, "exp_t");
    await transition(owner.token, sid, "exp_t", "running");
    return { owner, sid };
  }
  /** 次の公開が出し直しの依頼に割り当てる世代(activation と依頼がそれぞれ seq を 1 つ進める) */
  async function nextPublishGen(sid: string): Promise<StaticGeneration> {
    const row = await siteRow(sid);
    return { epoch: genOf(row).epoch, seq: row.static_seq + 2 };
  }
  /** 15 分ごとの Cron の results-delivery だけを 1 回走らせる(cron-results.test.ts と同じ呼び方) */
  async function cronDelivery(deployer: Env["DEPLOYER"]) {
    const e: Env = { ...testEnvWith({ resultsStore: true }), RESULTS_BUDGET: fakeResultsBudget().ns, RESULTS_HEALTH: fakeResultsHealth().ns, DEPLOYER: deployer };
    return runCron(e, Date.now(), [resultsDeliveryJob]);
  }
  /** 自己修復(GET /sites/:sid の reconcileStatic → confirmFromStatus) */
  async function selfRepair(token: string, sid: string, deployer: Env["DEPLOYER"]) {
    const res = await call("GET", `/sites/${sid}`, { token, envOverride: { DEPLOYER: deployer } });
    expect(res.status).toBe(200);
    return json(res);
  }
  const requestOf = (sid: string, g: StaticGeneration) =>
    db().selectFrom("static_deploy_requests").selectAll().where("site_id", "=", sid).where("epoch", "=", g.epoch).where("seq", "=", g.seq).executeTakeFirst();

  /**
   * DO が前の中身(版 1)を世代 g で配った履歴の点(digest 付き)を持ち、D1 を戻した後の新しい中身(版 2)の依頼が同じ世代 g を再利用する。
   * 戻り値の pub = 版 2 の公開の応答
   */
  async function collision() {
    const { owner, sid } = await runningSite();
    const g = await nextPublishGen(sid);
    const oldInput = await staticInputOf(sid);
    const oldDigest = await staticInputDigest(oldInput);
    const fake = fakeDeployer();
    const oldAt = Date.now() - 60_000;
    fake.setSite(sid, { accepted: g, deployed: g, input: oldInput, deployedAt: iso(oldAt), history: [{ generation: g, deployedAt: iso(oldAt), digest: oldDigest }] });
    expect((await setText(owner.token, sid, "exp_t", "New")).status).toBe(200);
    const pub = await publishOk(owner.token, sid, { ...RESULTS_STORE, DEPLOYER: fake });
    expect(pub.staticDeploy).toBe("pending"); // 同じ世代として捨てられた
    const req = await requestOf(sid, g);
    expect(req).toMatchObject({ version: pub.version });
    expect(req!.input_digest).toBe(await staticInputDigest(await staticInputOf(sid)));
    expect(req!.input_digest).not.toBe(oldDigest);
    expect(JSON.parse((await rowOf(sid, pub.version)).static_generation!)).toEqual(g); // 行には世代が入る(依頼は送った)
    return { owner, sid, fake, pub, g, oldAt };
  }

  it("generation_collision_does_not_confirm_undelivered_definition", async () => {
    const c = await collision();
    // (1) 自己修復も (2) Cron も、古い配信を新しい版の証拠にしない(digest を持つ点は rowGenVersion でも引かない)
    const got = await selfRepair(c.owner.token, c.sid, c.fake);
    expect(got.staticMismatch).toBe(true);
    expect(await rowOf(c.sid, c.pub.version)).toMatchObject({ delivered_from: null, settled: null });
    await cronDelivery(c.fake);
    expect(await rowOf(c.sid, c.pub.version)).toMatchObject({ delivered_from: null, settled: null });
    // (3) 手動の作り直しに成功した後は、新しい履歴の点(新しい世代・新しい digest)の時刻で確かめる
    const res = await call("POST", `/sites/${c.sid}/static/redeploy`, { token: c.owner.token, envOverride: { DEPLOYER: c.fake } });
    expect(await json(res)).toEqual({ staticDeploy: "deployed" });
    const at = Date.parse((await c.fake.siteStatus(c.sid)).deployedAt!);
    expect(at).toBeGreaterThan(c.oldAt);
    await cronDelivery(c.fake);
    expect(await rowOf(c.sid, c.pub.version)).toMatchObject({ delivered_from: at, settled: "delivered" });
  });

  it("作り直しても配置に失敗して新しい配信の証拠が無ければ、版 2 は未確定のまま", async () => {
    const c = await collision();
    c.fake.setMode("pending"); // 作り直しの配置が失敗する
    const res = await call("POST", `/sites/${c.sid}/static/redeploy`, { token: c.owner.token, envOverride: { DEPLOYER: c.fake } });
    expect(await json(res)).toEqual({ staticDeploy: "pending" });
    await selfRepair(c.owner.token, c.sid, c.fake);
    await cronDelivery(c.fake);
    expect(await rowOf(c.sid, c.pub.version)).toMatchObject({ delivered_from: null, settled: null });
  });

  it("legacy_history_cannot_confirm_new_definition_when_request_record_fails", async () => {
    // DO は更新前に前の中身を世代 g で配った(digest の無い履歴の点)。D1 を戻した後の新しい中身の依頼が同じ世代 g を再利用し、依頼の記録だけが書けない
    const { owner, sid } = await runningSite();
    const g = await nextPublishGen(sid);
    const oldAt = Date.now() - 60_000;
    const fake = fakeDeployer();
    fake.setSite(sid, { accepted: g, deployed: g, input: await staticInputOf(sid), deployedAt: iso(oldAt), history: [{ generation: g, deployedAt: iso(oldAt) }] });
    expect((await setText(owner.token, sid, "exp_t", "New")).status).toBe(200);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pub = await publishOk(owner.token, sid, { ...RESULTS_STORE, DEPLOYER: fake, DB: failingD1Query(env.DB, /^\s*insert into "?static_deploy_requests/i) });
    error.mockRestore();
    expect(pub.staticDeploy).toBe("pending");
    expect(fake.deploys).toHaveLength(0); // 記録を書けなければ送らない
    expect((await siteRow(sid)).static_stale).toBe(1);
    expect(await requestOf(sid, g)).toBeUndefined();
    expect((await rowOf(sid, pub.version)).static_generation).toBeNull(); // 送っていない世代を行に書かない
    // (1) 自己修復 (2) Cron のどちらでも、古い配信を新しい版の証拠にしない
    await selfRepair(owner.token, sid, fake);
    expect(await rowOf(sid, pub.version)).toMatchObject({ delivered_from: null, settled: null });
    await cronDelivery(fake);
    expect(await rowOf(sid, pub.version)).toMatchObject({ delivered_from: null, settled: null });
  });

  it("記録を書けなかった依頼は、後で自己修復が依頼し直して digest 付きの記録で確かめる", async () => {
    const { owner, sid } = await runningSite();
    const fake = fakeDeployer(); // 何も受け付けていない
    expect((await setText(owner.token, sid, "exp_t", "New")).status).toBe(200);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pub = await publishOk(owner.token, sid, { ...RESULTS_STORE, DEPLOYER: fake, DB: failingD1Query(env.DB, /^\s*insert into "?static_deploy_requests/i) });
    error.mockRestore();
    expect(pub.staticDeploy).toBe("pending");
    expect(fake.deploys).toHaveLength(0);
    // INSERT を戻した後の自己修復で依頼し直す(waitUntil。call は待つ)
    await selfRepair(owner.token, sid, fake);
    expect(fake.deploys).toHaveLength(1);
    const g = fake.deploys[0]!.generation;
    expect((await requestOf(sid, g))?.input_digest).toBe(await staticInputDigest(await staticInputOf(sid)));
    expect((await siteRow(sid)).static_stale).toBe(0);
    const at = Date.parse((await fake.siteStatus(sid)).deployedAt!);
    await cronDelivery(fake);
    expect(await rowOf(sid, pub.version)).toMatchObject({ delivered_from: at, settled: "delivered" });
  });

  it("legacy_pending_request_deployed_after_upgrade_is_confirmed", async () => {
    const shared = await setupOwner();
    for (const via of ["repair", "cron"] as const) {
      // 更新前の control が書いた依頼の記録(input_digest が NULL)と、更新前の DO が受け付けて配置待ちだった状態(digest なし・保存済みの入力)
      const { owner, sid } = await runningSite(shared);
      const row = await siteRow(sid);
      const g = genOf(row);
      await db().insertInto("static_deploy_requests").values({ site_id: sid, epoch: g.epoch, seq: g.seq, version: row.active_version!, requested_at: Date.now() }).execute();
      const fake = fakeDeployer();
      fake.setSite(sid, { accepted: g, deployed: null, input: await staticInputOf(sid) });
      await fake.flush(); // 更新後の deployer の alarm で配置(履歴の点に digest が付く)
      const st = await fake.siteStatus(sid);
      expect(st.history[0]!.digest).toBeDefined();
      const at = Date.parse(st.deployedAt!);
      if (via === "repair") expect((await selfRepair(owner.token, sid, fake)).staticStale).toBe(false);
      else await cronDelivery(fake);
      expect(await rowOf(sid, row.active_version!)).toMatchObject({ delivered_from: at, settled: "delivered" });
    }
  });

  it("更新前の記録の世代に別の中身が配られた点・記録の後に設定が変わった点は数えない", async () => {
    const shared = await setupOwner();
    for (const via of ["repair", "cron"] as const) {
      for (const kind of ["other_content", "settings_changed"] as const) {
        const { owner, sid } = await runningSite(shared);
        const row = await siteRow(sid);
        const g = genOf(row);
        await db().insertInto("static_deploy_requests").values({ site_id: sid, epoch: g.epoch, seq: g.seq, version: row.active_version!, requested_at: Date.now() }).execute();
        const input = await staticInputOf(sid);
        const fake = fakeDeployer();
        fake.setSite(sid, { accepted: g, deployed: null, input: kind === "other_content" ? otherStaticInput(input) : input });
        await fake.flush();
        // 記録の後に bootstrap に焼く設定が変わった(D1 だけ。今の設定から作る digest が点と合わない)
        if (kind === "settings_changed") await sql`update sites set decision_timeout_ms = decision_timeout_ms + 100 where id = ${sid}`.execute(db());
        if (via === "repair") await selfRepair(owner.token, sid, fake);
        else await cronDelivery(fake);
        expect(await rowOf(sid, row.active_version!)).toMatchObject({ delivered_from: null, settled: null });
      }
    }
  });

  it("古い記録どうしは世代で引き、digest のどちらかがあれば組み合うときだけ数える", async () => {
    const owner = await setupOwner();
    const prepare = async () => {
      const s = await unitSite(owner);
      await seedPublish(s.sid, 3, "u3", 2_500);
      await record(s, 3, g(3), def("v3"));
      return s;
    };
    const confirm = (sid: string, h: StaticDeployHistoryEntry[]) => confirmDeliveries(db(), sid, { history: h, historyFrom: null }, 4_000, noGuard, null);
    // 点にも記録にも digest が無い(更新前どうし): 記録の版で確かめる
    const a = await prepare();
    await seedRequest(a.sid, 3, 3, 2_500);
    await confirm(a.sid, [point(3, 3_000)]);
    expect(await rowOf(a.sid, 3)).toMatchObject({ delivered_from: 3_000, settled: "delivered" });
    // 点にも記録にも digest が無く、記録も無い: 行の世代で補う(更新前の世代)
    const b = await prepare();
    await confirm(b.sid, [point(3, 3_000)]);
    expect(await rowOf(b.sid, 3)).toMatchObject({ delivered_from: 3_000, settled: "delivered" });
    // 点に digest が無く、記録に digest がある: 数えない
    const c = await prepare();
    await seedRequest(c.sid, 3, 3, 2_500, "d-new");
    await confirm(c.sid, [point(3, 3_000)]);
    expect(await rowOf(c.sid, 3)).toMatchObject({ delivered_from: null, settled: null });
    // 点に digest があり、記録の digest が違う: 数えない
    const d = await prepare();
    await seedRequest(d.sid, 3, 3, 2_500, "d-new");
    await confirm(d.sid, [digestPoint(3, 3_000, "d-old")]);
    expect(await rowOf(d.sid, 3)).toMatchObject({ delivered_from: null, settled: null });
    // 点に digest があり、記録が無い(行の世代だけ): rowGenVersion で補わない
    const e = await prepare();
    await confirm(e.sid, [digestPoint(3, 3_000, "d-old")]);
    expect(await rowOf(e.sid, 3)).toMatchObject({ delivered_from: null, settled: null });
    // 点に digest があり、記録の digest が同じ: 数える
    const f = await prepare();
    await seedRequest(f.sid, 3, 3, 2_500, "d-new");
    await confirm(f.sid, [digestPoint(3, 3_000, "d-new")]);
    expect(await rowOf(f.sid, 3)).toMatchObject({ delivered_from: 3_000, settled: "delivered" });
  });
});
