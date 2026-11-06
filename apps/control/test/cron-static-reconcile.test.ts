import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_REMOVED_SEQ, type StaticGeneration } from "@wtt/core";
import { CRON_JOBS } from "../src/cron/jobs";
import { countingD1, CronFrozen, runCron, type CronContext, type CronJob } from "../src/cron/runner";
import { STATIC_RECONCILE_QUERIES, staticReconcileJob } from "../src/cron/static-reconcile";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { genOf } from "../src/static-delivery";
import { STATIC_REBUILD_PAGE, STATIC_REBUILD_PAGE_BYTES } from "../src/static-health";
import { isWriteFrozen } from "../src/write-freeze";
import { beforeD1Query, call, cloneSites, createSite, json, padConfig, setupOwner, siteRow, staticInputOf, testEnv, fakeDeployer } from "./helpers";

// 7o K13: control の Cron の自動の依頼し直し(static-reconcile)。DO の記録に無い公開中のサイトと、更新の依頼が届いていない公開中のサイトを
// 依頼し直し、DO が先行した公開中のサイトには static_stale = 1 だけを立てる(墓標・未公開・D1 に行が無いサイトは触らない)

afterEach(() => vi.restoreAllMocks());

const db = () => getDb(env as unknown as Env);
type Owner = Awaited<ReturnType<typeof setupOwner>>;
type Fake = ReturnType<typeof fakeDeployer>;
const twoMinAgo = () => Date.now() - 120_000;
const withDeployer = (fake: unknown, extra: Partial<Env> = {}) => ({ ...testEnv, DEPLOYER: fake, ...extra }) as Env;
const reconcile = (e: Env, jobs: CronJob[] = [staticReconcileJob]) => runCron(e, Date.now(), jobs);
const RAN = [{ job: "static-reconcile", outcome: "ran" }];

function errorLog() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return { messages: () => spy.mock.calls.map((c) => c[0] as unknown) };
}
const freeze = () =>
  env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{\"reason\":\"r\"}', 1, null) on conflict(key) do nothing").run();
const unfreeze = () => env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();

/** サイトを n 個作って 1 回ずつ公開する(DEPLOYER は無し = static_stale = 1)。公開は 2 分前にする(初めての公開の猶予の外) */
async function publishedSites(o: Owner, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { id } = await createSite(o.token, o.workspaceId);
    expect((await json(await call("POST", `/sites/${id}/publish`, { token: o.token }))).ok).toBe(true);
    await setLastActivated(id, twoMinAgo());
    ids.push(id);
  }
  return ids;
}
const setLastActivated = (sid: string, at: number) => db().updateTable("sites").set({ last_activated_at: at }).where("id", "=", sid).execute();
const setStale = (sid: string, v: 0 | 1) => db().updateTable("sites").set({ static_stale: v }).where("id", "=", sid).execute();
const genNow = async (sid: string) => genOf(await siteRow(sid));
/** DO が今の D1 の世代・今の入力を配り終えた状態にする */
async function settled(fake: Fake, sid: string) {
  const g = await genNow(sid);
  fake.setSite(sid, { accepted: g, deployed: g, input: await staticInputOf(sid) });
}
/** DO が通常の世代で先行した状態にする(D1 を Time Travel で戻した向き) */
async function aheadInDo(fake: Fake, sid: string, by = 5): Promise<StaticGeneration> {
  const g = await genNow(sid);
  const ahead = { epoch: g.epoch, seq: g.seq + by };
  fake.setSite(sid, { accepted: ahead, deployed: ahead });
  return ahead;
}
/** DO に削除の墓標が配られている状態にする */
async function tombstoneInDo(fake: Fake, sid: string) {
  const t = { epoch: (await genNow(sid)).epoch, seq: SITE_REMOVED_SEQ };
  fake.setSite(sid, { accepted: t, deployed: t, removed: true });
}
const requestsOf = async (sid: string) =>
  Number((await sql<{ n: number }>`select count(*) as n from static_deploy_requests where site_id = ${sid}`.execute(db())).rows[0]!.n);
const sentIds = (fake: Fake) => fake.batches.flatMap((b) => b.sites.map((s) => s.siteId));
/** DO が今の D1 の世代を、別の中身(digest)で配り終えた状態にする */
async function differsInDo(fake: Fake, sid: string) {
  const g = await genNow(sid);
  fake.setSite(sid, { accepted: g, deployed: g, acceptedDigest: "f".repeat(64), deployedDigest: "f".repeat(64) });
}

/** 15 分の枠(CX-03 の回し方の単位) */
const SLOT_MS = 900_000;
/**
 * 依頼し直しの候補が n 件のとき、id の順の start 番目から回る枠の時刻。今より後の枠にする
 * (初めての公開の猶予の外に保つ。epoch の下限にもなるので、過去の小さい値は使わない)
 */
function nowForStart(start: number, n: number): number {
  const base = Math.floor(Date.now() / SLOT_MS) + 1;
  return (base + ((((start - base) % n) + n) % n)) * SLOT_MS;
}

/** job.run を直接呼ぶ ctx。D1 の呼び出しを runner と同じ数え方(countingD1。batch は 1 件)で数える */
function countedCtx(e: Env, over: Partial<CronContext> = {}) {
  let n = 0;
  const counted = { ...e, DB: countingD1(env.DB, (k) => (n += k)) } as Env;
  const d = getDb(counted);
  const ctx: CronContext = {
    env: counted,
    db: d,
    now: Date.now(),
    async assertNotFrozen() {
      if (await isWriteFrozen(d)) throw new CronFrozen();
    },
    queries: { left: () => 40, use: (k) => k <= 40 },
    ...over,
  };
  return { ctx, count: () => n };
}
/** D1 のクエリの残りを n に固定したジョブ(runner は配分の無いジョブの呼び出しを数えないので、残りは実行のあいだ変わらない) */
const withBudget = (n: number): CronJob => ({ ...staticReconcileJob, run: (ctx) => staticReconcileJob.run({ ...ctx, queries: { left: () => n, use: (k) => k <= n } }) });
/** assertNotFrozen だけを差し替えたジョブ(名前はそのまま。runner の報告で確かめる) */
const withAssert = (assertNotFrozen: () => Promise<void>): CronJob => ({ ...staticReconcileJob, run: (ctx) => staticReconcileJob.run({ ...ctx, assertNotFrozen }) });

describe("static-reconcile (7o K13)", () => {
  it("cron_rerequests_unknown_published_sites_only", async () => {
    const o = await setupOwner();
    const [a, b, c, d, e, h] = (await publishedSites(o, 6)) as [string, string, string, string, string, string];
    const fake = fakeDeployer();
    await settled(fake, b); // DO にある
    await setStale(b, 0); // 配り終えて印も下りている(印が立っていれば Cron が下ろす = U2。別のテストで見る)
    await db().updateTable("sites").set({ static_removing: "tok" }).where("id", "=", c).execute(); // 削除の途中
    await setLastActivated(d, Date.now() - 30_000); // 30 秒前に公開(初めての公開の依頼が届く途中)
    await tombstoneInDo(fake, e); // 削除の墓標が配られている(D1 の行あり・削除の途中でない)
    await setStale(e, 0);
    await sql`delete from publishes where site_id = ${h} and version = ${(await siteRow(h)).active_version}`.execute(db()); // 公開履歴が無い
    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = new Map<string, Awaited<ReturnType<typeof siteRow>>>();
    for (const s of [a, b, c, d, e, h]) before.set(s, await siteRow(s));

    expect(await reconcile(withDeployer(fake))).toEqual(RAN);
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]!.sites.map((s) => s.siteId)).toEqual([a]);
    expect(fake.batches[0]!.force).toBeUndefined(); // force は付かない
    const ra = await siteRow(a);
    expect(ra.static_epoch).toBeGreaterThanOrEqual(before.get(a)!.static_epoch);
    expect(ra.static_seq).toBe(before.get(a)!.static_seq + 1);
    expect(ra.static_stale).toBe(1);
    expect(fake.batches[0]!.sites[0]!.generation).toEqual(genOf(ra));
    expect(await requestsOf(a)).toBe(1);
    // 墓標のサイト・公開履歴の無いサイト・DO にあるサイト・削除の途中・初めての公開の途中は触らない
    for (const s of [b, c, d, e, h]) expect(await siteRow(s)).toEqual(before.get(s));
  });

  it("依頼が届いていない公開中のサイトは、全サイトの作り直しの RPC が失敗した後に Cron が依頼し直す(CL-Medium-4)", async () => {
    const o = await setupOwner();
    const ids = await publishedSites(o, 5);
    const fake = fakeDeployer();
    for (const s of ids) await settled(fake, s);
    errorLog();
    const broken = { ...fake, redeploySites: async () => { throw new Error("binding down"); } };
    const res = await call("POST", "/static/rebuild", { token: o.token, body: {}, envOverride: { DEPLOYER: broken } });
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out.failed).toEqual([...ids].sort().map((siteId) => ({ siteId, reason: "unavailable" })));
    for (const s of ids) await setLastActivated(s, twoMinAgo());
    const st1 = await json(await call("GET", "/static/status", { token: o.token, envOverride: { DEPLOYER: fake } }));
    expect(st1).toMatchObject({ undeliveredSites: [...ids].sort(), needsAttention: true });

    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await reconcile(withDeployer(fake))).toEqual(RAN);
    expect(fake.batches).toHaveLength(1);
    expect(sentIds(fake)).toEqual([...ids].sort());
    expect(fake.batches[0]!.force).toBeUndefined();
    const st2 = await json(await call("GET", "/static/status", { token: o.token, envOverride: { DEPLOYER: fake } }));
    expect(st2.undeliveredSites).toEqual([]);
  });

  it("cron_marks_stale_but_does_not_advance_when_deployer_is_ahead", async () => {
    const o = await setupOwner();
    const [f, t] = (await publishedSites(o, 2)) as [string, string];
    const fake = fakeDeployer();
    await aheadInDo(fake, f);
    await tombstoneInDo(fake, t); // 墓標が先行している(D1 の行あり)
    for (const s of [f, t]) await setStale(s, 0);
    const bf = await siteRow(f);
    const bt = await siteRow(t);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const first = countedCtx(withDeployer(fake));
    expect(await staticReconcileJob.run(first.ctx)).toBeUndefined();
    expect(fake.batches).toHaveLength(0);
    const rf = await siteRow(f);
    expect(rf.static_stale).toBe(1);
    expect(genOf(rf)).toEqual(genOf(bf)); // epoch・seq は変わらない
    expect(await siteRow(t)).toEqual(bt); // 墓標が先行しているサイトには印を立てない(7i K23)
    // 行の読み取り 1 + 読み直し 1 + 凍結の確かめ 1 + batch 1
    expect(first.count()).toBe(4);

    // 2 回目は印が立っているので条件に合わず、何も書かない(凍結の確かめも batch も出さない)
    const second = countedCtx(withDeployer(fake));
    await staticReconcileJob.run(second.ctx);
    expect(second.count()).toBe(2);
    expect(await siteRow(f)).toEqual(rf);
    expect(fake.batches).toHaveLength(0);
  });

  it("印の各文は読み直した世代・印が無いこと・凍結の印が無いことを条件にする(確かめの後に凍結が入っても書かない)", async () => {
    const o = await setupOwner();
    const [f] = (await publishedSites(o, 1)) as [string];
    const fake = fakeDeployer();
    await aheadInDo(fake, f);
    await setStale(f, 0);
    vi.spyOn(console, "log").mockImplementation(() => {});
    // assertNotFrozen は通り、その直後(batch の前)に凍結が入った
    const { ctx } = countedCtx(withDeployer(fake), { assertNotFrozen: async () => void (await freeze()) });
    try {
      await staticReconcileJob.run(ctx);
      expect((await siteRow(f)).static_stale).toBe(0);
    } finally {
      await unfreeze();
    }
    // 読み直しの後に別の処理が世代を進めた(seq が読み直しの値と違う)行には印を立てない
    const { ctx: ctx2 } = countedCtx(withDeployer(fake), {
      assertNotFrozen: async () => void (await db().updateTable("sites").set({ static_seq: sql<number>`static_seq + 1` }).where("id", "=", f).execute()),
    });
    await staticReconcileJob.run(ctx2);
    expect((await siteRow(f)).static_stale).toBe(0);
  });

  it("cron_does_not_remove_files_of_unpublished_site", async () => {
    const o = await setupOwner();
    const { id: u1 } = await createSite(o.token, o.workspaceId);
    const { id: u2 } = await createSite(o.token, o.workspaceId);
    for (const s of [u1, u2]) await setStale(s, 0);
    const fake = fakeDeployer();
    const g1 = await genNow(u1);
    fake.setSite(u1, { accepted: g1, deployed: g1 }); // 未公開なのに配信ファイルがある(DO は先行していない)
    await aheadInDo(fake, u2); // 未公開なのに配信ファイルがある(DO が先行)
    fake.setSite("site_m", { accepted: { epoch: 1_000, seq: 2 }, deployed: { epoch: 1_000, seq: 2 } }); // D1 に行が無い
    const b1 = await siteRow(u1);
    const b2 = await siteRow(u2);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await reconcile(withDeployer(fake))).toEqual(RAN);
    expect(fake.removes).toHaveLength(0);
    expect(fake.batches).toHaveLength(0);
    expect(await siteRow(u1)).toEqual(b1);
    expect(await siteRow(u2)).toEqual(b2);
  });

  it("101 サイトがすべて DO で先行していても、読み直し 1 文と印の batch 1 つで 101 サイトに印を立てる", async () => {
    const o = await setupOwner();
    const [src] = (await publishedSites(o, 1)) as [string];
    const ids = [src, ...(await cloneSites(src, 100, "bulk_"))];
    await sql`update sites set static_stale = 0 where id in (select value from json_each(${JSON.stringify(ids)}))`.execute(db());
    const fake = fakeDeployer();
    for (const id of ids) await aheadInDo(fake, id);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx, count } = countedCtx(withDeployer(fake));
    await staticReconcileJob.run(ctx);
    expect(count()).toBe(4); // 行の読み取り 1 + 読み直し 1 + 凍結の確かめ 1 + batch 1
    const marked = await sql<{ n: number }>`select count(*) as n from sites where static_stale = 1 and id in (select value from json_each(${JSON.stringify(ids)}))`.execute(db());
    expect(marked.rows[0]!.n).toBe(101);
    expect(fake.batches).toHaveLength(0);
  }, 30_000);

  it("全サイトの作り直しの後、配置が済んだサイトの印は Cron が下ろす(サイトを開かなくても。U2)", async () => {
    const o = await setupOwner();
    const ids = await publishedSites(o, 3);
    const fake = fakeDeployer();
    expect(await json(await call("POST", "/static/rebuild", { token: o.token, body: {}, envOverride: { DEPLOYER: fake } }))).toMatchObject({ requested: 3, failed: [] });
    for (const s of ids) expect((await siteRow(s)).static_stale).toBe(1);
    // 受け付けただけ(配置の前)では下ろさない
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await reconcile(withDeployer(fake))).toEqual(RAN);
    for (const s of ids) expect((await siteRow(s)).static_stale).toBe(1);
    await fake.flush(); // alarm の配置
    const before = new Map<string, Awaited<ReturnType<typeof siteRow>>>();
    for (const s of ids) before.set(s, await siteRow(s));
    const { ctx, count } = countedCtx(withDeployer(fake));
    expect(await staticReconcileJob.run(ctx)).toBeUndefined();
    expect(count()).toBe(4); // 行の読み取り 1 + config の読み取り 1 + 凍結の確かめ 1 + batch 1
    expect(fake.batches).toHaveLength(1); // 依頼し直さない
    for (const s of ids) {
      const r = await siteRow(s);
      const b = before.get(s)!;
      // 印だけを下ろし、配っている版を記録する(世代は変えない)
      expect(r).toMatchObject({ static_stale: 0, static_served_version: b.active_version, static_epoch: b.static_epoch, static_seq: b.static_seq });
    }
    const st = await json(await call("GET", "/static/status", { token: o.token, envOverride: { DEPLOYER: fake } }));
    expect(st).toMatchObject({ mismatchSites: [], needsAttention: false });
  });

  it("digest が違う・DO が先行している・配っていないサイトの印は Cron で下りない", async () => {
    const o = await setupOwner();
    const [differs, ahead, notDeployed] = (await publishedSites(o, 3)) as [string, string, string];
    const fake = fakeDeployer();
    await differsInDo(fake, differs);
    await aheadInDo(fake, ahead); // 印は立っている
    const g = await genNow(notDeployed);
    fake.setSite(notDeployed, { accepted: g, deployed: { ...g, seq: g.seq - 1 }, input: await staticInputOf(notDeployed) });
    const before = new Map<string, Awaited<ReturnType<typeof siteRow>>>();
    for (const s of [differs, ahead, notDeployed]) before.set(s, await siteRow(s));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await reconcile(withDeployer(fake))).toEqual(RAN);
    for (const s of [differs, ahead, notDeployed]) expect(await siteRow(s)).toEqual(before.get(s));
  });

  it("凍結中は印を下ろさず、確かめの後に凍結が入っても・世代が進んでも書かない(U2)", async () => {
    const o = await setupOwner();
    const [c] = (await publishedSites(o, 1)) as [string];
    const fake = fakeDeployer();
    await settled(fake, c);
    vi.spyOn(console, "log").mockImplementation(() => {});
    // 凍結中は runner が見送る
    await freeze();
    try {
      expect(await reconcile(withDeployer(fake))).toEqual([{ job: "static-reconcile", outcome: "skipped_frozen" }]);
    } finally {
      await unfreeze();
    }
    expect((await siteRow(c)).static_stale).toBe(1);
    // 書く直前の確かめで凍結が見つかれば stopped_frozen
    const frozenJob = withAssert(async () => {
      throw new CronFrozen();
    });
    expect(await reconcile(withDeployer(fake), [frozenJob])).toEqual([{ job: "static-reconcile", outcome: "stopped_frozen" }]);
    expect((await siteRow(c)).static_stale).toBe(1);
    // 確かめは通り、その直後(batch の前)に凍結が入った: NOT_FROZEN_SQL で書かない
    const { ctx } = countedCtx(withDeployer(fake), { assertNotFrozen: async () => void (await freeze()) });
    try {
      await staticReconcileJob.run(ctx);
      expect((await siteRow(c)).static_stale).toBe(1);
    } finally {
      await unfreeze();
    }
    // 確かめの後に別の依頼が世代を進めた(seq が読んだ値と違う)行の印は下ろさない
    const { ctx: ctx2 } = countedCtx(withDeployer(fake), {
      assertNotFrozen: async () => void (await db().updateTable("sites").set({ static_seq: sql<number>`static_seq + 1` }).where("id", "=", c).execute()),
    });
    await staticReconcileJob.run(ctx2);
    expect((await siteRow(c)).static_stale).toBe(1);
  });

  it("依頼し直しは公開中の config の合計が頁のバイト数を超える手前で切る(CX-02・CL-3)", async () => {
    const o = await setupOwner();
    const [src] = (await publishedSites(o, 1)) as [string];
    const ids = (await cloneSites(src, 6, "big_")).sort(); // DO に無い 6 サイト
    await db().updateTable("sites").set({ active_version: null }).where("id", "=", src).execute(); // 元のサイトは候補に入れない
    const each = Math.floor(STATIC_REBUILD_PAGE_BYTES / 4.5); // 4 件で収まり 5 件目で超える
    for (const id of ids) await padConfig(id, each);
    const fake = fakeDeployer();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx } = countedCtx(withDeployer(fake), { now: nowForStart(0, ids.length) });
    await staticReconcileJob.run(ctx);
    expect(sentIds(fake)).toEqual(ids.slice(0, 4));
    for (const id of ids.slice(4)) expect(await requestsOf(id)).toBe(0); // 切った分は世代も進めない
  }, 60_000);

  it("入力を作れないサイトが 25 件以上あっても、枠の番号で始まりを回すので後ろの正常なサイトに依頼が届く(CX-03)", async () => {
    const o = await setupOwner();
    const [good] = (await publishedSites(o, 1)) as [string];
    const bad = await cloneSites(good, STATIC_REBUILD_PAGE + 1, "bad_"); // id の順で good より前の 26 件
    await sql`update publishes set config_json = '{"broken":true}' where site_id in (select value from json_each(${JSON.stringify(bad)}))`.execute(db());
    const candidates = [...bad, good].sort();
    expect(candidates.at(-1)).toBe(good);
    const fake = fakeDeployer();
    errorLog();
    vi.spyOn(console, "log").mockImplementation(() => {});
    // 先頭から回る枠では、入力を作れない 25 件で埋まって good に届かない
    await staticReconcileJob.run(countedCtx(withDeployer(fake), { now: nowForStart(0, candidates.length) }).ctx);
    expect(sentIds(fake)).toEqual([]);
    expect(await requestsOf(good)).toBe(0);
    // 枠が変わると始まりがずれ、good が 25 件の窓に入る
    await staticReconcileJob.run(countedCtx(withDeployer(fake), { now: nowForStart(2, candidates.length) }).ctx);
    expect(sentIds(fake)).toEqual([good]);
    expect(await requestsOf(good)).toBe(1);
  }, 30_000);

  it("static_reconcile_query_count_matches_worst_case", async () => {
    // Ruling 1・CL-4: STATIC_RECONCILE_QUERIES は 1 回の実行の最大の実数(突き合わせ 3 + 作り直し 13 + 印を立てる 2 + 印を下ろす 2)
    const o = await setupOwner();
    const [src, ahead, same] = (await publishedSites(o, 3)) as [string, string, string];
    const unknown = [src, ...(await cloneSites(src, STATIC_REBUILD_PAGE, "worst_"))].sort(); // DO に無い 26 サイト(1 回で送るのは 25)
    const fake = fakeDeployer();
    await aheadInDo(fake, ahead); // 先行の候補(読み直し 1 + 印を立てる 2)
    await setStale(ahead, 0);
    await settled(fake, same); // 印あり・同じ世代・同じ中身(config の読み取り 1 + 印を下ろす 2)
    vi.spyOn(console, "log").mockImplementation(() => {});
    // 候補 26 件の先頭から回る枠(CX-03)。送るのは id の順の先頭 25 件になる
    const { ctx, count } = countedCtx(withDeployer(fake), { now: nowForStart(0, unknown.length) });
    await staticReconcileJob.run(ctx);
    expect(count()).toBe(STATIC_RECONCILE_QUERIES);
    expect(STATIC_RECONCILE_QUERIES).toBe(20);
    expect(sentIds(fake)).toEqual(unknown.slice(0, STATIC_REBUILD_PAGE));
    expect(fake.batches).toHaveLength(5);
    expect((await siteRow(ahead)).static_stale).toBe(1);
    expect((await siteRow(same)).static_stale).toBe(0);
  }, 30_000);

  it("凍結中は runner が見送り、配信の依頼も印も出さない", async () => {
    const o = await setupOwner();
    const [a, f] = (await publishedSites(o, 2)) as [string, string];
    const fake = fakeDeployer();
    await aheadInDo(fake, f);
    await setStale(f, 0);
    const ba = await siteRow(a);
    await freeze();
    try {
      expect(await reconcile(withDeployer(fake))).toEqual([{ job: "static-reconcile", outcome: "skipped_frozen" }]);
    } finally {
      await unfreeze();
    }
    expect(fake.batches).toHaveLength(0);
    expect(await siteRow(a)).toEqual(ba);
    expect((await siteRow(f)).static_stale).toBe(0);
  });

  it("UPDATE の前の確かめ(beforeWrite)で凍結が見つかれば stopped_frozen で、世代を進めず送らない", async () => {
    const o = await setupOwner();
    const [a] = (await publishedSites(o, 1)) as [string];
    const fake = fakeDeployer();
    const ba = await siteRow(a);
    const job = withAssert(async () => {
      throw new CronFrozen();
    });
    expect(await reconcile(withDeployer(fake), [job])).toEqual([{ job: "static-reconcile", outcome: "stopped_frozen" }]);
    expect(await siteRow(a)).toEqual(ba);
    expect(fake.batches).toHaveLength(0);
    expect(await requestsOf(a)).toBe(0);
  });

  it("記録の INSERT の前の凍結は停止の例外のまま伝わり、記録を書かず送らない(CX-High-5)", async () => {
    const o = await setupOwner();
    const [a] = (await publishedSites(o, 1)) as [string];
    const fake = fakeDeployer();
    const log = errorLog();
    let calls = 0;
    const job = withAssert(async () => {
      if (++calls === 2) throw new CronFrozen(); // 1 回目(UPDATE の前)は通し、2 回目(記録の INSERT の前)で凍結
    });
    expect(await reconcile(withDeployer(fake), [job])).toEqual([{ job: "static-reconcile", outcome: "stopped_frozen" }]);
    expect(calls).toBe(2);
    expect(await requestsOf(a)).toBe(0);
    expect(fake.batches).toHaveLength(0);
    expect(log.messages()).not.toContain("static deploy request record failed");

    // beforeWrite は通したまま、UPDATE の後・INSERT の直前に凍結が入った: NOT_FROZEN_SQL で記録を書かない
    const hooked = beforeD1Query(env.DB, /insert into static_deploy_requests/i, freeze);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await reconcile(withDeployer(fake, { DB: hooked.db }), [withAssert(async () => undefined)]);
      expect(hooked.ran()).toBe(true);
      expect(await requestsOf(a)).toBe(0);
      expect(fake.batches).toHaveLength(0);
    } finally {
      await unfreeze();
    }
  });

  it("binding が無ければ何もせず、instanceStatus が失敗すれば console.error して ran(次のジョブを止めない)", async () => {
    const o = await setupOwner();
    const [a] = (await publishedSites(o, 1)) as [string];
    const ba = await siteRow(a);
    expect(await reconcile(testEnv)).toEqual(RAN);
    expect(await siteRow(a)).toEqual(ba);

    const log = errorLog();
    let next = 0;
    const nextJob: CronJob = { name: "next", cadence: { every: "tick" }, writesControl: true, run: async () => void next++ };
    expect(await reconcile(withDeployer(fakeDeployer("throw")), [staticReconcileJob, nextJob])).toEqual([...RAN, { job: "next", outcome: "ran" }]);
    expect(next).toBe(1);
    expect(log.messages()).toContain("cron static-reconcile: reading the deployer status failed; retrying on the next run");
    expect(await siteRow(a)).toEqual(ba);
  });

  it("突き合わせの 3 件が残りに収まらなければ何もせず continued", async () => {
    const o = await setupOwner();
    const [a] = (await publishedSites(o, 1)) as [string];
    const fake = fakeDeployer();
    let asked = 0;
    const counting = { ...fake, instanceStatus: async () => (asked++, fake.instanceStatus()) };
    const ba = await siteRow(a);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await reconcile(withDeployer(counting), [withBudget(2)])).toEqual([{ job: "static-reconcile", outcome: "continued" }]);
    expect(asked).toBe(0);
    expect(fake.batches).toHaveLength(0);
    expect(await siteRow(a)).toEqual(ba);
  });

  // CL-4: 予約は段ごと(突き合わせ 3 → 作り直し 13 → 印を立てる 2 → 印を下ろす 2 の累計)。足りない段から先は行わず continued
  describe("段の途中で予算が尽きると、前の段は行い、残りは continued になる(CL-4)", () => {
    /** 依頼し直す 1 件(a)・印を立てる 1 件(f)・印を下ろす 1 件(c)がそろった状態 */
    async function scenario() {
      const o = await setupOwner();
      const [a, f, c] = (await publishedSites(o, 3)) as [string, string, string];
      const fake = fakeDeployer();
      await aheadInDo(fake, f);
      await setStale(f, 0);
      await settled(fake, c);
      let asked = 0;
      const counting = { ...fake, instanceStatus: async () => (asked++, fake.instanceStatus()) };
      vi.spyOn(console, "log").mockImplementation(() => {});
      return { a, f, c, fake, e: withDeployer(counting), asked: () => asked };
    }
    const stale = async (sid: string) => (await siteRow(sid)).static_stale;

    it("残り 10: 突き合わせだけ(作り直し・印は行わない)", async () => {
      const s = await scenario();
      expect(await reconcile(s.e, [withBudget(10)])).toEqual([{ job: "static-reconcile", outcome: "continued" }]);
      expect(s.asked()).toBe(1);
      expect(s.fake.batches).toHaveLength(0);
      expect([await stale(s.f), await stale(s.c)]).toEqual([0, 1]);
    });
    it("残り 16: 突き合わせと作り直し(印は立てず、下ろさない)", async () => {
      const s = await scenario();
      expect(await reconcile(s.e, [withBudget(16)])).toEqual([{ job: "static-reconcile", outcome: "continued" }]);
      expect(sentIds(s.fake)).toEqual([s.a]);
      expect([await stale(s.f), await stale(s.c)]).toEqual([0, 1]);
    });
    it("残り 18: 印を立てるまで(印は下ろさない)", async () => {
      const s = await scenario();
      expect(await reconcile(s.e, [withBudget(18)])).toEqual([{ job: "static-reconcile", outcome: "continued" }]);
      expect(sentIds(s.fake)).toEqual([s.a]);
      expect([await stale(s.f), await stale(s.c)]).toEqual([1, 1]);
    });
    it("残り 20: すべての段を行い ran", async () => {
      const s = await scenario();
      expect(await reconcile(s.e, [withBudget(STATIC_RECONCILE_QUERIES)])).toEqual(RAN);
      expect(sentIds(s.fake)).toEqual([s.a]);
      expect([await stale(s.f), await stale(s.c)]).toEqual([1, 0]);
    });
  });

  it("CRON_JOBS の最後から 3 番目(B129 Task 9 の audit-retention・B68 の asset-housekeeping の前)に、配分を持たない 15 分ごとのジョブとして登録する", () => {
    expect(CRON_JOBS.at(-3)).toBe(staticReconcileJob);
    expect(staticReconcileJob).toMatchObject({ name: "static-reconcile", cadence: { every: "tick" }, writesControl: true });
    expect(staticReconcileJob.queryShare).toBeUndefined();
  });
});
