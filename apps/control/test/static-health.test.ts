import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_REMOVED_SEQ, staticInputDigest, type StaticBatchDeployRequest, type StaticDeployer, type StaticInstanceStatus } from "@wtt/core";
import { resultsDeliveryJob } from "../src/cron/results-jobs";
import { runCron } from "../src/cron/runner";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { genOf, recordDeployRequests } from "../src/static-delivery";
import { rebuildStaticFiles, STATIC_REBUILD_PAGE, STATIC_REBUILD_PAGE_BYTES } from "../src/static-health";
import {
  beforeD1Query,
  call,
  choosePrimaryGoal,
  cloneSites,
  createExperiment,
  createSite,
  expectEnvelope,
  failingD1Query,
  fakeDeployer,
  fakeResultsBudget,
  fakeResultsHealth,
  inviteAndJoin,
  json,
  otherStaticInput,
  padConfig,
  RESULTS_STORE,
  setupOwner,
  siteRow,
  staticInputOf,
  testEnv,
  testEnvWith,
  TEXT_CHANGE,
} from "./helpers";

// 7o K11・K12: インスタンス全体の配信ファイルの状態(GET /static/status)と、全サイトの作り直し(POST /static/rebuild)

afterEach(() => vi.restoreAllMocks());

const db = () => getDb(env as unknown as Env);
type Owner = Awaited<ReturnType<typeof setupOwner>>;
type Fake = ReturnType<typeof fakeDeployer>;
/** 初めての公開の猶予(60 秒)より前の時刻 */
const twoMinAgo = () => Date.now() - 120_000;

/** console.error を黙らせて、呼ばれた最初の引数(ログの文)を返す */
function errorLog() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return { messages: () => spy.mock.calls.map((c) => c[0] as unknown) };
}
const freeze = () =>
  env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"r\"}', 1, null) on conflict(key) do nothing").run();
const unfreeze = () => env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();

/** サイトを n 個作って 1 回ずつ公開する(DEPLOYER は無し = 配信ファイルは skipped、static_stale = 1) */
async function publishedSites(o: Owner, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { id } = await createSite(o.token, o.workspaceId);
    const pub = await json(await call("POST", `/sites/${id}/publish`, { token: o.token }));
    expect(pub.ok).toBe(true);
    ids.push(id);
  }
  return ids;
}
/** D1 の世代(epoch, seq) */
const genNow = async (sid: string) => genOf(await siteRow(sid));
/** DO が今の D1 の世代・今の入力を配り終えた状態にする */
async function settled(fake: Fake, sid: string, envLike: Env = testEnv) {
  const g = await genNow(sid);
  fake.setSite(sid, { accepted: g, deployed: g, input: await staticInputOf(sid, envLike) });
}
const setLastActivated = (sid: string, at: number) => db().updateTable("sites").set({ last_activated_at: at }).where("id", "=", sid).execute();

async function getStatus(token: string, envOverride: Partial<Env>) {
  const res = await call("GET", "/static/status", { token, envOverride });
  expect(res.status).toBe(200);
  return json(res);
}
async function postRebuild(token: string, envOverride: Partial<Env>, body: Record<string, unknown> = {}) {
  const res = await call("POST", "/static/rebuild", { token, body, envOverride });
  expect(res.status).toBe(200);
  return json(res);
}
const sorted = (ids: string[]) => [...ids].sort();
/** DO が今の D1 の世代を、別の中身(digest)で配り終えた状態にする */
async function differsInDo(fake: Fake, sid: string) {
  const g = await genNow(sid);
  fake.setSite(sid, { accepted: g, deployed: g, acceptedDigest: "f".repeat(64), deployedDigest: "f".repeat(64) });
}
/** D1 に出した文(prepare の SQL)を控える */
function recordingD1(d1: D1Database): { db: D1Database; sqls: string[] } {
  const sqls: string[] = [];
  const wrapped = new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare") {
        return (q: string) => {
          sqls.push(q);
          return target.prepare(q);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: wrapped, sqls };
}


describe("GET /static/status (7o K12)", () => {
  it("static_status_classifies_sites", async () => {
    const o = await setupOwner();
    const [a, b, c, y, v] = await publishedSites(o, 5) as [string, string, string, string, string];
    const { id: u } = await createSite(o.token, o.workspaceId); // 未公開
    for (const s of [a, b, c, y, v]) await setLastActivated(s, twoMinAgo());
    const fake = fakeDeployer();
    await settled(fake, a); // 配り終えた
    const rb = await siteRow(b);
    const ahead = { epoch: genOf(rb).epoch, seq: rb.static_seq + 10 };
    fake.setSite(b, { accepted: ahead, deployed: ahead, input: await staticInputOf(b) }); // 通常の世代で先行
    // c: DO の記録に無い(公開は 2 分前)
    const gy = await genNow(y);
    fake.setSite(y, { accepted: gy, deployed: { ...gy, seq: gy.seq - 1 }, input: await staticInputOf(y) }); // 受け付けたが配っていない
    const gv = await genNow(v);
    fake.setSite(v, { accepted: { ...gv, seq: gv.seq - 1 }, deployed: { ...gv, seq: gv.seq - 1 }, input: await staticInputOf(v) }); // D1 の世代が新しい
    fake.setSite("site_x", { accepted: { epoch: 1_000, seq: SITE_REMOVED_SEQ }, deployed: { epoch: 1_000, seq: 3 }, removed: true }); // 削除済み・墓標が消え残り
    const ru = await siteRow(u);
    fake.setSite(u, { accepted: { epoch: genOf(ru).epoch, seq: ru.static_seq }, deployed: { epoch: genOf(ru).epoch, seq: ru.static_seq } }); // 未公開なのに配信ファイルがある(先行でない)
    fake.setSite("site_m", { accepted: { epoch: 1_000, seq: 2 }, deployed: { epoch: 1_000, seq: 2 } }); // D1 に行が無いのに配信ファイルがある
    fake.setMeta({ failures: 2, lastError: "HTTP 503", lastDeployedAt: "2026-10-27T00:00:00.000Z" });
    const h = await getStatus(o.token, { DEPLOYER: fake });
    expect(h).toEqual({
      pendingSites: [y],
      removingSites: ["site_x"],
      lastError: "HTTP 503",
      failures: 2,
      lastDeployedAt: Date.parse("2026-10-27T00:00:00.000Z"),
      mismatchSites: sorted([b, u, "site_m"]),
      unknownSites: [c],
      undeliveredSites: [v],
      publishedSites: 5,
      unpublishedWithFiles: 2,
      removingInD1: 0,
      needsAttention: true,
    });

    // すべて揃っていれば帯を出さない
    const ok = fakeDeployer();
    for (const s of [a, b, c, y, v]) await settled(ok, s);
    const allOk = await getStatus(o.token, { DEPLOYER: ok });
    expect(allOk).toMatchObject({ pendingSites: [], removingSites: [], mismatchSites: [], unknownSites: [], undeliveredSites: [], lastError: null, failures: 0, lastDeployedAt: null, needsAttention: false });
    // 更新待ちだけ(失敗なし)なら帯を出さない
    const gy2 = await genNow(y);
    ok.setSite(y, { accepted: gy2, deployed: { ...gy2, seq: gy2.seq - 1 }, input: await staticInputOf(y) });
    expect(await getStatus(o.token, { DEPLOYER: ok })).toMatchObject({ pendingSites: [y], needsAttention: false });
    // 更新の依頼が届いていないサイトだけでも帯を出す
    await settled(ok, y);
    const gv2 = await genNow(v);
    ok.setSite(v, { accepted: { ...gv2, seq: gv2.seq - 1 }, deployed: { ...gv2, seq: gv2.seq - 1 }, input: await staticInputOf(v) });
    expect(await getStatus(o.token, { DEPLOYER: ok })).toMatchObject({ pendingSites: [], undeliveredSites: [v], mismatchSites: [], needsAttention: true });
  });

  it("公開履歴の無いサイトと、公開して 30 秒のサイトは「更新の依頼が届いていないサイト」に入らない", async () => {
    const o = await setupOwner();
    const [noRecord, recent, old] = await publishedSites(o, 3) as [string, string, string];
    const fake = fakeDeployer();
    for (const s of [noRecord, recent, old]) {
      const g = await genNow(s);
      fake.setSite(s, { accepted: { ...g, seq: g.seq - 1 }, deployed: { ...g, seq: g.seq - 1 }, input: await staticInputOf(s) });
    }
    await setLastActivated(noRecord, twoMinAgo());
    await sql`delete from publishes where site_id = ${noRecord} and version = ${(await siteRow(noRecord)).active_version}`.execute(db());
    await setLastActivated(recent, Date.now() - 30_000);
    await setLastActivated(old, twoMinAgo());
    expect((await getStatus(o.token, { DEPLOYER: fake })).undeliveredSites).toEqual([old]);
  });

  it("同じ世代で中身が違うサイト(印あり)は食い違いに数え、digest の無い古い記録は補った digest で比べる(K23)", async () => {
    const o = await setupOwner();
    // apiBase が digest に入る(edge の origin を設定した導入で、同じ入力が一致すること)
    const envLike = { ...testEnv, AB_EDGE_ORIGIN: "https://edge.example.com/" } as Env;
    const [same, differs, legacyOld, legacyNew, notStale] = await publishedSites(o, 5) as [string, string, string, string, string];
    for (const s of [same, differs, legacyOld, legacyNew, notStale]) await setLastActivated(s, twoMinAgo());
    const fake = fakeDeployer();
    await settled(fake, same, envLike);
    const gd = await genNow(differs);
    const otherDigest = await staticInputDigest(otherStaticInput(await staticInputOf(differs, envLike)));
    fake.setSite(differs, { accepted: gd, deployed: gd, acceptedDigest: otherDigest, deployedDigest: otherDigest });
    const go = await genNow(legacyOld);
    fake.setSite(legacyOld, { accepted: go, deployed: go, input: otherStaticInput(await staticInputOf(legacyOld, envLike)) }); // 前の中身(digest なし)
    const gn = await genNow(legacyNew);
    fake.setSite(legacyNew, { accepted: gn, deployed: gn, input: await staticInputOf(legacyNew, envLike) }); // 今の中身(digest なし)
    // 印が下りている行は比べない(同じ世代の別の中身は、印を立てる新しい依頼でだけ生じる)
    await db().updateTable("sites").set({ static_stale: 0 }).where("id", "=", notStale).execute();
    const gs = await genNow(notStale);
    fake.setSite(notStale, { accepted: gs, deployed: gs, input: otherStaticInput(await staticInputOf(notStale, envLike)) });
    const h = await getStatus(o.token, { DEPLOYER: fake, AB_EDGE_ORIGIN: envLike.AB_EDGE_ORIGIN });
    expect(h.mismatchSites).toEqual(sorted([differs, legacyOld]));
    // apiBase を渡さない(edge の origin が違う)と、今の中身のサイトも一致しない = apiBase が比べる入力に入っている
    expect((await getStatus(o.token, { DEPLOYER: fake })).mismatchSites).toEqual(sorted([same, differs, legacyOld, legacyNew]));
  });

  it("static_status_ignores_site_in_first_publish", async () => {
    const o = await setupOwner();
    const [s] = await publishedSites(o, 1) as [string];
    await setLastActivated(s, Date.now() - 30_000);
    const fake = fakeDeployer();
    expect(await getStatus(o.token, { DEPLOYER: fake })).toMatchObject({ unknownSites: [], publishedSites: 1, needsAttention: false });
    await setLastActivated(s, twoMinAgo());
    expect(await getStatus(o.token, { DEPLOYER: fake })).toMatchObject({ unknownSites: [s], needsAttention: true });
  });

  it("non_bootstrap_settings_change_does_not_cause_static_mismatch", async () => {
    const o = await setupOwner();
    const { id: s } = await createSite(o.token, o.workspaceId);
    const fake = fakeDeployer("pending");
    const pub = await json(await call("POST", `/sites/${s}/publish`, { token: o.token, envOverride: { DEPLOYER: fake } }));
    expect(pub).toMatchObject({ ok: true, staticDeploy: "pending" });
    expect((await siteRow(s)).static_stale).toBe(1);
    const before = await siteRow(s);
    // bootstrap に焼かない設定だけを変える(世代は進まない)
    const patch = await call("PATCH", `/sites/${s}`, { token: o.token, body: { allowedOrigins: ["https://www.example.com", "https://shop.example.com"] }, envOverride: { DEPLOYER: fake } });
    expect(patch.status).toBe(200);
    expect((await siteRow(s)).static_seq).toBe(before.static_seq);
    await fake.flush(); // 公開のときの入力で配り終える
    expect((await getStatus(o.token, { DEPLOYER: fake })).mismatchSites).toEqual([]); // 印が立ったままでも、digest は一致する
    const got = await json(await call("GET", `/sites/${s}`, { token: o.token, envOverride: { DEPLOYER: fake } }));
    expect(got).toMatchObject({ staticStale: false, staticMismatch: false });
    expect((await getStatus(o.token, { DEPLOYER: fake })).mismatchSites).toEqual([]);
  });

  it("先行の候補を読み直す前に D1 が追いついたサイトは、食い違いに数えない(K5)", async () => {
    const o = await setupOwner();
    const [s] = await publishedSites(o, 1) as [string];
    const row = await siteRow(s);
    const ahead = { epoch: genOf(row).epoch, seq: row.static_seq + 1 };
    const fake = fakeDeployer();
    fake.setSite(s, { accepted: ahead, deployed: ahead, input: await staticInputOf(s) });
    expect((await getStatus(o.token, { DEPLOYER: fake })).mismatchSites).toEqual([s]); // 追いつかなければ食い違い
    // 最初の行の読み取りの後、読み直しの文の直前に、並行の依頼が D1 の seq を DO の accepted まで進めた
    const hooked = beforeD1Query(env.DB, /from "sites" where id in \(select value from json_each/i, async () => {
      await db().updateTable("sites").set({ static_seq: ahead.seq }).where("id", "=", s).execute();
    });
    expect((await getStatus(o.token, { DEPLOYER: fake, DB: hooked.db })).mismatchSites).toEqual([]);
    expect(hooked.ran()).toBe(true);
  });

  it("101 サイトがすべて先行していても、読み直しは 1 文で終わり 101 件を数える", async () => {
    const o = await setupOwner();
    const [src] = await publishedSites(o, 1) as [string];
    const ids = [src, ...(await cloneSites(src, 100, "bulk_"))];
    const fake = fakeDeployer();
    for (const id of ids) {
      const r = await siteRow(id);
      fake.setSite(id, { accepted: { epoch: genOf(r).epoch, seq: r.static_seq + 5 }, deployed: null });
    }
    const h = await getStatus(o.token, { DEPLOYER: fake });
    expect(h.mismatchSites).toHaveLength(101);
    expect(h.publishedSites).toBe(101);
  }, 30_000);

  it("同じ世代の中身の比較は id の順に 25 件までで、候補が 26 件以上あっても config を読む文は 1 つ(CX-01・CL-2 (2))", async () => {
    const o = await setupOwner();
    const [src] = await publishedSites(o, 1) as [string];
    const ids = sorted([src, ...(await cloneSites(src, STATIC_REBUILD_PAGE + 2, "cmp_"))]); // 印あり・同じ世代の候補が 28 件
    const fake = fakeDeployer();
    for (const id of ids) await differsInDo(fake, id);
    const rec = recordingD1(env.DB);
    const h = await getStatus(o.token, { DEPLOYER: fake, DB: rec.db });
    expect(h.mismatchSites).toEqual(ids.slice(0, STATIC_REBUILD_PAGE)); // 比べなかった 3 件は食い違いに数えない
    expect(rec.sqls.filter((q) => /from publishes p join json_each/i.test(q))).toHaveLength(1);
  }, 30_000);

  it("同じ世代の中身の比較は、公開中の config の合計が頁のバイト数を超える手前で切る(1 件目だけで超えるときもその 1 件は比べる)", async () => {
    const o = await setupOwner();
    const [src] = await publishedSites(o, 1) as [string];
    const ids = await cloneSites(src, 6, "cmpbig_");
    await db().updateTable("sites").set({ active_version: null }).where("id", "=", src).execute(); // 元のサイトは候補に入れない
    const each = Math.floor(STATIC_REBUILD_PAGE_BYTES / 4.5); // 4 件で収まり 5 件目で超える
    for (const id of ids) await padConfig(id, each);
    const fake = fakeDeployer();
    for (const id of ids) await differsInDo(fake, id);
    expect((await getStatus(o.token, { DEPLOYER: fake })).mismatchSites).toEqual(ids.slice(0, 4));
    await padConfig(ids[0]!, STATIC_REBUILD_PAGE_BYTES + 1);
    expect((await getStatus(o.token, { DEPLOYER: fake })).mismatchSites).toEqual([ids[0]]);
  }, 60_000);

  it("D1 では未公開で、削除の記録(墓標・通常の世代の削除)のほうが新しいサイトは食い違いに数えない(CL-1・U1)", async () => {
    const o = await setupOwner();
    const { id: tomb } = await createSite(o.token, o.workspaceId);
    const { id: removedAhead } = await createSite(o.token, o.workspaceId);
    const fake = fakeDeployer();
    const gt = await genNow(tomb);
    const t = { epoch: gt.epoch, seq: SITE_REMOVED_SEQ };
    fake.setSite(tomb, { accepted: t, deployed: t, removed: true }); // 墓標が先行(未公開のサイトを消した後に D1 を戻した)
    const gr = await genNow(removedAhead);
    const ahead = { epoch: gr.epoch, seq: gr.seq + 3 };
    fake.setSite(removedAhead, { accepted: ahead, deployed: ahead, removed: true }); // 通常の世代の削除が先行
    expect(await getStatus(o.token, { DEPLOYER: fake })).toMatchObject({ mismatchSites: [], unpublishedWithFiles: 0, needsAttention: false });
  });

  it("デプロイ専用の Worker が応答しないと 2 秒で 503 static_deployer_unavailable(unreachable)", async () => {
    const o = await setupOwner();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    const res = await call("GET", "/static/status", { token: o.token, envOverride: { DEPLOYER: fakeDeployer("hang") } });
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await expectEnvelope(res)).toMatchObject({ error: "static_deployer_unavailable", reason: "unreachable", message: "デプロイ専用の Worker の状態を取得できませんでした" });
    const thrown = await call("GET", "/static/status", { token: o.token, envOverride: { DEPLOYER: fakeDeployer("throw") } });
    expect(await expectEnvelope(thrown)).toMatchObject({ error: "static_deployer_unavailable", reason: "unreachable" });
    const none = await call("GET", "/static/status", { token: o.token });
    expect(none.status).toBe(503);
    expect(await expectEnvelope(none)).toMatchObject({ error: "static_deployer_unavailable", reason: "not_configured", message: "配信ファイルを更新する仕組みが設定されていません" });
  }, 20_000);
});

describe("POST /static/rebuild (7o K11)", () => {
  it("rebuild_all_advances_epoch_past_deployer_and_skips_removing", async () => {
    const o = await setupOwner();
    const [a, b, c, removing] = await publishedSites(o, 4) as [string, string, string, string];
    const { id: unpublished } = await createSite(o.token, o.workspaceId); // DO に記録の無い未公開のサイト
    await db().updateTable("sites").set({ static_removing: "tok" }).where("id", "=", removing).execute();
    const fake = fakeDeployer();
    const far = Date.now() + 10_000;
    fake.setSite(a, { accepted: { epoch: far, seq: 1 }, deployed: { epoch: far, seq: 1 } }); // DO の最大の epoch
    const before = new Map<string, Awaited<ReturnType<typeof siteRow>>>();
    for (const s of [a, b, c, removing, unpublished]) before.set(s, await siteRow(s));
    const res = await postRebuild(o.token, { DEPLOYER: fake });
    expect(res).toEqual({ requested: 3, removed: 0, skippedRemoving: 1, failed: [], next: null });
    for (const s of [a, b, c]) {
      const r = await siteRow(s);
      expect(r.static_epoch).toBe(far + 1);
      expect(r.static_seq).toBe(before.get(s)!.static_seq + 1);
      expect(r.static_stale).toBe(1);
      const req = await db().selectFrom("static_deploy_requests").selectAll().where("site_id", "=", s).where("epoch", "=", far + 1).where("seq", "=", r.static_seq).executeTakeFirst();
      expect(req).toMatchObject({ version: r.active_version });
      expect(req!.input_digest).toBe(await staticInputDigest(await staticInputOf(s)));
    }
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]).toMatchObject({ protocol: 1, flush: "soon", force: true });
    expect(fake.batches[0]!.sites.map((e) => e.siteId)).toEqual(sorted([a, b, c]));
    for (const e of fake.batches[0]!.sites) expect(e.generation.epoch).toBe(far + 1);
    for (const s of [removing, unpublished]) expect(await siteRow(s)).toEqual(before.get(s)); // 触らない
  });

  it("older_rebuild_cannot_regress_epoch_after_newer_rebuild", async () => {
    const o = await setupOwner();
    const [s] = await publishedSites(o, 1) as [string];
    const seq0 = (await siteRow(s)).static_seq;
    const fake = fakeDeployer();
    const statusA: StaticInstanceStatus = { sites: [], failures: 0, lastError: null, lastDeployedAt: null };
    const eB = Date.now() + 50_000;
    const statusB: StaticInstanceStatus = { ...statusA, sites: [{ siteId: "site_z", accepted: { epoch: eB - 1, seq: SITE_REMOVED_SEQ }, deployed: null, removed: true }] };
    const envB = { ...testEnv, DEPLOYER: fake } as Env;
    // A は小さい epoch の状態を読んだ後、UPDATE の直前で止まる。その間に B が最後まで走る
    const hooked = beforeD1Query(env.DB, /^\s*update "sites"/i, async () => {
      await rebuildStaticFiles(envB, db(), { after: null }, { status: statusB, now: Date.now(), force: true });
      expect((await siteRow(s)).static_epoch).toBe(eB);
    });
    const envA = { ...testEnv, DEPLOYER: fake, DB: hooked.db } as Env;
    await rebuildStaticFiles(envA, getDb(envA), { after: null }, { status: statusA, now: Date.now(), force: true });
    expect(hooked.ran()).toBe(true);
    const r = await siteRow(s);
    expect(r.static_epoch).toBe(eB); // 下がらない
    expect(r.static_seq).toBe(seq0 + 2);
  });

  it("並行の新しい依頼に追い越された(応答の accepted が送った世代より新しい)サイトは失敗に数えない", async () => {
    const o = await setupOwner();
    const [s] = await publishedSites(o, 1) as [string];
    const fake = fakeDeployer();
    const status = await fake.instanceStatus(); // 古い状態(空)を読んだ
    fake.setSite(s, { accepted: { epoch: Date.now() + 100_000, seq: 1 }, deployed: null }); // その後に新しい依頼が受け付けられた
    const out = await rebuildStaticFiles({ ...testEnv, DEPLOYER: fake } as Env, db(), { after: null }, { status, now: Date.now(), force: true });
    expect(out).toEqual({ requested: [s], removed: [], skippedRemoving: [], failed: [], next: null });
  });

  it("作り直しは UPDATE が返した行の版で config を読み、記録する版とそろえる(CX-High-3)", async () => {
    const o = await setupOwner();
    const created = await call("POST", `/workspaces/${o.workspaceId}/sites`, { token: o.token, body: { name: "Site", domain: "www.example.com" }, envOverride: RESULTS_STORE });
    const { id: s } = await json<{ id: string }>(created);
    await createExperiment(o.token, s, { id: "exp_t" });
    expect((await call("PUT", `/sites/${s}/experiments/exp_t/variants/b/changes`, { token: o.token, body: [TEXT_CHANGE()] })).status).toBe(200);
    await choosePrimaryGoal(o.token, s, "exp_t");
    const start = await call("POST", `/sites/${s}/experiments/exp_t/status`, { token: o.token, body: { status: "running" }, envOverride: RESULTS_STORE });
    expect((await json(start)).publish.ok).toBe(true);
    const v1 = (await siteRow(s)).active_version!;
    expect((await call("PUT", `/sites/${s}/experiments/exp_t/variants/b/changes`, { token: o.token, body: [{ ...TEXT_CHANGE(), payload: { text: "New" } }] })).status).toBe(200);
    // UPDATE の後・config の読み取りの直前に、新しい版の公開(activation)が入る
    let v2 = 0;
    const hooked = beforeD1Query(env.DB, /from publishes p join json_each/i, async () => {
      const pub = await json(await call("POST", `/sites/${s}/publish`, { token: o.token, envOverride: RESULTS_STORE }));
      expect(pub.ok).toBe(true);
      v2 = pub.version;
    });
    const fake = fakeDeployer();
    expect(await postRebuild(o.token, { ...RESULTS_STORE, DEPLOYER: fake, DB: hooked.db })).toMatchObject({ requested: 1, failed: [] });
    expect(hooked.ran()).toBe(true);
    expect(v2).toBeGreaterThan(v1);
    const sent = fake.batches[0]!.sites[0]! as Extract<StaticBatchDeployRequest["sites"][number], { config: unknown }>;
    expect((sent.config as { version: number }).version).toBe(v1);
    const req = await db().selectFrom("static_deploy_requests").selectAll().where("site_id", "=", s).where("epoch", "=", sent.generation.epoch).where("seq", "=", sent.generation.seq).executeTakeFirstOrThrow();
    expect(req.version).toBe(v1);
    // 配った後の配信の確認で、配っていない新しい版の定義を配信済みにしない
    await fake.flush();
    const e: Env = { ...testEnvWith({ resultsStore: true }), RESULTS_BUDGET: fakeResultsBudget().ns, RESULTS_HEALTH: fakeResultsHealth().ns, DEPLOYER: fake };
    await runCron(e, Date.now(), [resultsDeliveryJob]);
    const rowV2 = await db().selectFrom("experiment_delivered_definitions").selectAll().where("site_id", "=", s).where("publish_version", "=", v2).executeTakeFirstOrThrow();
    expect(rowV2.delivered_from).toBeNull();
  });

  it("rebuild_all_removes_files_of_unpublished_site_known_to_deployer", async () => {
    const o = await setupOwner();
    const { id: u } = await createSite(o.token, o.workspaceId);
    const { id: removingU } = await createSite(o.token, o.workspaceId);
    const { id: removedU } = await createSite(o.token, o.workspaceId);
    const fake = fakeDeployer();
    for (const s of [u, removingU]) {
      const r = await siteRow(s);
      fake.setSite(s, { accepted: { epoch: genOf(r).epoch, seq: r.static_seq + 3 }, deployed: { epoch: genOf(r).epoch, seq: r.static_seq + 3 } }); // D1 より新しい世代
    }
    const rr = await siteRow(removedU);
    fake.setSite(removedU, { accepted: { epoch: genOf(rr).epoch, seq: rr.static_seq + 3 }, deployed: null, removed: true });
    await db().updateTable("sites").set({ static_removing: "tok" }).where("id", "=", removingU).execute();
    const before = { removingU: await siteRow(removingU), removedU: await siteRow(removedU) };
    const startedAt = Date.now();
    const res = await postRebuild(o.token, { DEPLOYER: fake });
    expect(res).toEqual({ requested: 0, removed: 1, skippedRemoving: 1, failed: [], next: null });
    const after = await siteRow(u);
    expect(after.static_epoch).toBeGreaterThanOrEqual(startedAt);
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]!.sites).toEqual([{ siteId: u, generation: genOf(after), remove: true }]);
    expect(fake.batches[0]!.sites[0]!.generation.seq).not.toBe(SITE_REMOVED_SEQ);
    expect(fake.removes).toHaveLength(0); // removeSite を 1 件ずつ呼ばない
    expect(await siteRow(removingU)).toEqual(before.removingU);
    expect(await siteRow(removedU)).toEqual(before.removedU);
  });

  it("rebuild_all_removes_files_of_site_missing_from_d1", async () => {
    const o = await setupOwner();
    const fake = fakeDeployer();
    fake.setSite("site_m", { accepted: { epoch: 1_000, seq: 3 }, deployed: { epoch: 1_000, seq: 3 } });
    fake.setSite("site_gone", { accepted: { epoch: 1_000, seq: SITE_REMOVED_SEQ }, deployed: { epoch: 1_000, seq: SITE_REMOVED_SEQ }, removed: true }); // 普段の削除済み
    // after に site_m より後の ID を渡した頁では送らない(DO の index から拾う頁の読み方)
    expect(await postRebuild(o.token, { DEPLOYER: fake }, { after: "site_n" })).toEqual({ requested: 0, removed: 0, skippedRemoving: 0, failed: [], next: null });
    expect(fake.batches).toHaveLength(0);
    const startedAt = Date.now();
    expect(await postRebuild(o.token, { DEPLOYER: fake })).toEqual({ requested: 0, removed: 1, skippedRemoving: 0, failed: [], next: null });
    expect(fake.batches).toHaveLength(1);
    const [e] = fake.batches[0]!.sites;
    expect(e).toMatchObject({ siteId: "site_m", remove: true, generation: { seq: SITE_REMOVED_SEQ } });
    expect(e!.generation.epoch).toBeGreaterThanOrEqual(startedAt);
    expect(await db().selectFrom("sites").select("id").where("id", "=", "site_m").executeTakeFirst()).toBeUndefined(); // D1 に行を作らない
  });

  it("記録の INSERT だけが失敗した 5 件は送らず、印は立ったまま(K24 (1))", async () => {
    const o = await setupOwner();
    const ids = await publishedSites(o, 3);
    await db().updateTable("sites").set({ static_stale: 0 }).where("id", "in", ids).execute();
    const fake = fakeDeployer();
    const log = errorLog();
    const res = await postRebuild(o.token, { DEPLOYER: fake, DB: failingD1Query(env.DB, /^\s*insert into "?static_deploy_requests/i) });
    expect(res).toEqual({ requested: 0, removed: 0, skippedRemoving: 0, failed: sorted(ids).map((siteId) => ({ siteId, reason: "unavailable" })), next: null });
    expect(fake.batches).toHaveLength(0);
    for (const s of ids) expect((await siteRow(s)).static_stale).toBe(1);
    expect(log.messages()).toContain("static deploy request record failed");
  });

  it("公開履歴の無いサイトは no_publish_record、invalid_payload は rejected、RPC の失敗・待ち切れないは unavailable", async () => {
    const o = await setupOwner();
    const [noRecord, s] = await publishedSites(o, 2) as [string, string];
    await sql`delete from publishes where site_id = ${noRecord} and version = ${(await siteRow(noRecord)).active_version}`.execute(db());
    const fake = fakeDeployer();
    const log = errorLog();
    const res = await postRebuild(o.token, { DEPLOYER: fake });
    expect(res).toEqual({ requested: 1, removed: 0, skippedRemoving: 0, failed: [{ siteId: noRecord, reason: "no_publish_record" }], next: null });
    expect(fake.batches[0]!.sites.map((e) => e.siteId)).toEqual([s]); // 公開履歴の無いサイトは送らない
    expect(log.messages()).toContain("static deploy skipped: active version has no publish record");
    const invalid: StaticDeployer = {
      ...fake,
      redeploySites: async (req) => ({ state: "accepted", sites: req.sites.map((e) => ({ siteId: e.siteId, accepted: null, error: "invalid_payload" as const })) }),
    };
    expect((await postRebuild(o.token, { DEPLOYER: invalid })).failed).toEqual(sorted([noRecord, s]).map((siteId) => ({ siteId, reason: siteId === noRecord ? "no_publish_record" : "rejected" })));
    const down: StaticDeployer = { ...fake, redeploySites: async () => { throw new Error("binding down"); } };
    expect((await postRebuild(o.token, { DEPLOYER: down })).failed).toContainEqual({ siteId: s, reason: "unavailable" });
    const hang: StaticDeployer = { ...fake, redeploySites: () => new Promise(() => {}) };
    const hung = await postRebuild(o.token, { DEPLOYER: hang });
    expect(hung).toMatchObject({ requested: 0 });
    expect(hung.failed).toContainEqual({ siteId: s, reason: "unavailable" });
  }, 30_000);

  it("rebuild_all_pages_with_next", async () => {
    const o = await setupOwner();
    const [src] = await publishedSites(o, 1) as [string];
    const ids = sorted([src, ...(await cloneSites(src, 26, "page_"))]);
    const fake = fakeDeployer();
    const first = await postRebuild(o.token, { DEPLOYER: fake });
    expect(first).toEqual({ requested: 25, removed: 0, skippedRemoving: 0, failed: [], next: ids[24] });
    expect(fake.batches.map((b) => b.flush)).toEqual(["later", "later", "later", "later", "soon"]);
    expect(fake.batches.flatMap((b) => b.sites.map((e) => e.siteId))).toEqual(ids.slice(0, 25));
    const second = await postRebuild(o.token, { DEPLOYER: fake }, { after: first.next });
    expect(second).toEqual({ requested: 2, removed: 0, skippedRemoving: 0, failed: [], next: null });
    expect(fake.batches.slice(5).flatMap((b) => b.sites.map((e) => e.siteId))).toEqual(ids.slice(25));
  }, 30_000);

  it("config の合計が頁のバイト数を超える手前で頁を切り、1 件目だけで超えるときもその 1 件は入れる", async () => {
    const o = await setupOwner();
    const [src] = await publishedSites(o, 1) as [string];
    const ids = await cloneSites(src, 6, "big_");
    await db().updateTable("sites").set({ active_version: null }).where("id", "=", src).execute(); // 元のサイトは頁に入れない
    const each = Math.floor(STATIC_REBUILD_PAGE_BYTES / 4.5); // 4 件で収まり 5 件目で超える
    for (const id of ids) await padConfig(id, each);
    const fake = fakeDeployer();
    const first = await postRebuild(o.token, { DEPLOYER: fake });
    expect(first).toMatchObject({ requested: 4, failed: [], next: ids[3] });
    expect(await postRebuild(o.token, { DEPLOYER: fake }, { after: first.next })).toMatchObject({ requested: 2, next: null });
    // 1 件目だけで上限を超える
    await padConfig(ids[0]!, STATIC_REBUILD_PAGE_BYTES + 1);
    expect(await postRebuild(o.token, { DEPLOYER: fake })).toMatchObject({ requested: 1, failed: [], next: ids[0] });
  }, 60_000);

  it("rebuild_all_is_session_only_and_status_reads_with_full_key", async () => {
    const o = await setupOwner(); // システム管理者
    const key = async (body: Record<string, unknown>) => (await json<{ key: string }>(await call("POST", "/me/api-keys", { token: o.token, body: { name: "k", ...body } }))).key;
    const fullKey = await key({ workspaceId: null });
    const wsKey = await key({ workspaceId: o.workspaceId });
    const cappedKey = await key({ workspaceId: null, roleCap: "viewer" });
    const plain = await inviteAndJoin(o.token, o.workspaceId, "admin");
    await sql`update member set role = 'owner' where userId = ${plain.userId}`.execute(db()); // システム管理者でないオーナー
    const fake = fakeDeployer();
    const rebuild = (token: string, envOverride: Partial<Env> = { DEPLOYER: fake }) => call("POST", "/static/rebuild", { token, body: {}, envOverride });
    const status = (token: string, envOverride: Partial<Env> = { DEPLOYER: fake }) => call("GET", "/static/status", { token, envOverride });

    expect((await rebuild(o.token)).status).toBe(200);
    for (const k of [fullKey, wsKey, cappedKey]) {
      const res = await rebuild(k);
      expect(res.status).toBe(403);
      expect(await expectEnvelope(res)).toMatchObject({ error: "session_required", hint: "配信ファイルの作り直しはセッション(管理画面)からのみ行えます" });
    }
    const notAdmin = await rebuild(plain.token);
    expect(notAdmin.status).toBe(403);
    expect(await expectEnvelope(notAdmin)).toMatchObject({ error: "forbidden", required: "instance_admin" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const none = await rebuild(o.token, {});
    expect(none.status).toBe(503);
    expect(await expectEnvelope(none)).toMatchObject({ error: "static_deployer_unavailable", reason: "not_configured" });

    expect((await status(o.token)).status).toBe(200);
    expect((await status(fullKey)).status).toBe(200);
    for (const t of [wsKey, cappedKey, plain.token]) expect((await status(t)).status).toBe(403);

    await freeze();
    try {
      const frozen = await rebuild(o.token);
      expect(frozen.status).toBe(503);
      expect((await expectEnvelope(frozen)).error).toBe("write_frozen");
      expect((await status(o.token)).status).toBe(200); // 読み取りは凍結中も読める
    } finally {
      await unfreeze();
    }
  });

  it("siteIds(Cron)のときは頁を作らず、公開履歴のある公開中のサイトだけを進め、書く前に beforeWrite を呼ぶ(K13)", async () => {
    const o = await setupOwner();
    const [s, noRecord] = await publishedSites(o, 2) as [string, string];
    const { id: unpublished } = await createSite(o.token, o.workspaceId);
    await sql`delete from publishes where site_id = ${noRecord} and version = ${(await siteRow(noRecord)).active_version}`.execute(db());
    const before = { noRecord: await siteRow(noRecord), unpublished: await siteRow(unpublished) };
    const fake = fakeDeployer();
    let calls = 0;
    const out = await rebuildStaticFiles({ ...testEnv, DEPLOYER: fake } as Env, db(), { siteIds: [s, noRecord, unpublished] }, {
      status: await fake.instanceStatus(),
      now: Date.now(),
      force: false,
      beforeWrite: async () => void calls++,
      notFrozenSql: true,
    });
    expect(out).toEqual({ requested: [s], removed: [], skippedRemoving: [], failed: [], next: null });
    expect(calls).toBe(2); // UPDATE の前と記録の INSERT の前
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]!.force).toBeUndefined();
    expect(await siteRow(noRecord)).toEqual(before.noRecord); // 公開履歴の無いサイトは進めない
    expect(await siteRow(unpublished)).toEqual(before.unpublished);
  });

  it("siteIds が STATIC_REBUILD_PAGE 件を超えると、何も書かずに投げる(UPDATE の bind を上限 100 に近づけない)", async () => {
    const o = await setupOwner();
    const [s] = await publishedSites(o, 1) as [string];
    const before = await siteRow(s);
    const fake = fakeDeployer();
    const ids = [s, ...Array.from({ length: STATIC_REBUILD_PAGE }, (_, i) => `site_none${i}`)];
    let calls = 0;
    await expect(
      rebuildStaticFiles({ ...testEnv, DEPLOYER: fake } as Env, db(), { siteIds: ids }, { status: await fake.instanceStatus(), now: Date.now(), force: false, beforeWrite: async () => void calls++ }),
    ).rejects.toThrow(/at most 25/);
    expect(calls).toBe(0);
    expect(await siteRow(s)).toEqual(before);
    expect(fake.batches).toHaveLength(0);
  });

  it("recordDeployRequests は 5 行を 1 文で書き、notFrozenSql なら凍結中は書かずに false", async () => {
    const o = await setupOwner();
    const [s] = await publishedSites(o, 1) as [string];
    const row = await siteRow(s);
    const rows = [1, 2, 3, 4, 5].map((n) => ({ siteId: s, generation: { epoch: 7, seq: n }, version: row.active_version!, inputDigest: `d${n}` }));
    const count = async () => Number((await sql<{ n: number }>`select count(*) as n from static_deploy_requests where site_id = ${s} and epoch = 7`.execute(db())).rows[0]!.n);
    await freeze();
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await recordDeployRequests(db(), rows, { notFrozenSql: true })).toBe(false);
      expect(await count()).toBe(0);
    } finally {
      await unfreeze();
    }
    expect(await recordDeployRequests(db(), rows, { notFrozenSql: true })).toBe(true);
    expect(await count()).toBe(5);
    const r3 = await db().selectFrom("static_deploy_requests").selectAll().where("site_id", "=", s).where("epoch", "=", 7).where("seq", "=", 3).executeTakeFirstOrThrow();
    expect(r3).toMatchObject({ version: row.active_version, input_digest: "d3" });
    // 同じ世代の記録が既にあれば成功として扱う(notFrozenSql でなければ数を見ない)
    expect(await recordDeployRequests(db(), rows)).toBe(true);
  });

  it("after の形を確かめる(サイト ID の形でない・知らないキーは 422)", async () => {
    const o = await setupOwner();
    const fake = fakeDeployer();
    expect((await call("POST", "/static/rebuild", { token: o.token, body: { after: "bad id!" }, envOverride: { DEPLOYER: fake } })).status).toBe(422);
    expect((await call("POST", "/static/rebuild", { token: o.token, body: { extra: 1 }, envOverride: { DEPLOYER: fake } })).status).toBe(422);
  });
});
