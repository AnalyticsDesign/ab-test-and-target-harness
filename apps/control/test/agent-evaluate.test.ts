import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { active, call, createExperiment, createSite, expectEnvelope, inviteAndJoin, json, publishRes, runDirect, setupOwner, siteRow, testEnv, TEXT_CHANGE } from "./helpers";
import { getDb } from "../src/db";
import { publishSite } from "../src/publish";

type EvaluateItem = {
  experimentId: string;
  /** Desired Status(D1 experiments.status そのまま。決定 39 (7)) */
  status: "draft" | "running" | "paused" | "archived";
  /** 公開 config にこの Experiment が載っているか(決定 39 (7)) */
  published: boolean;
  eligible: boolean;
  reason?: string;
  weights: Array<{ variantId: string; weight: number }>;
  variantId?: string;
};
type EvaluateBody = { source: "published" | "draft"; version: number | null; experiments: EvaluateItem[] };
const evaluate = async (
  token: string,
  sid: string,
  body: unknown,
): Promise<{ res: Response; body: EvaluateBody | null; items: EvaluateItem[] }> => {
  const res = await call("POST", `/sites/${sid}/evaluate`, { token, body });
  const parsed = res.status === 200 ? await json<EvaluateBody>(res) : null;
  return { res, body: parsed, items: parsed?.experiments ?? [] };
};
const of = (items: EvaluateItem[], id: string): EvaluateItem => items.find((i) => i.experimentId === id)!;

/** running な Experiment を 1 つ持ち Publish 済みの Site を作る */
async function publishedSite() {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_lp", urlMatch: { op: "contains", value: "/lp/" } });
  await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
  expect((await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
  return { owner, sid, eid };
}

describe("POST /sites/:sid/evaluate (spec §13.10 / 決定 39 (2) (7))", () => {
  it("evaluate_returns_reason_for_ineligible_experiment", async () => {
    const { owner, sid } = await publishedSite();
    // ID 非依存の段: URL 不一致
    const miss = await evaluate(owner.token, sid, { url: "https://www.example.com/" });
    expect(miss.res.status).toBe(200);
    // 評価した版が応答トップに出る(決定 39 (7))
    expect(miss.body!.source).toBe("published");
    expect(miss.body!.version).toBeGreaterThan(0);
    expect(of(miss.items, "exp_lp")).toMatchObject({
      eligible: false,
      reason: "url_mismatch",
      status: "running",
      published: true,
      weights: [{ variantId: "a", weight: 50 }, { variantId: "b", weight: 50 }],
    });
    expect(of(miss.items, "exp_lp").variantId).toBeUndefined();

    // URL 一致 + visitorId 無し → eligible だが variantId は返さない(決定 39 (2))
    const hit = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/" });
    expect(of(hit.items, "exp_lp")).toMatchObject({ eligible: true });
    expect(of(hit.items, "exp_lp").variantId).toBeUndefined();
    expect(of(hit.items, "exp_lp").reason).toBeUndefined();

    // visitorId を渡すと Variant まで返る(a か b のどちらか = 本番と同じハッシュ割当)
    const withId = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/", visitorId: "visitor-1" });
    expect(["a", "b"]).toContain(of(withId.items, "exp_lp").variantId);

    // traffic 1% → 除外理由(除外される visitorId を総当たりで探す)
    await call("PATCH", `/sites/${sid}/experiments/exp_lp`, { token: owner.token, body: { trafficPercentage: 1 } });
    await publishRes(owner.token, sid);
    const excluded = [] as string[];
    for (const v of ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"]) {
      const r = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/", visitorId: v });
      if (of(r.items, "exp_lp").reason === "traffic_excluded") excluded.push(v);
    }
    expect(excluded.length, "1% traffic で除外される visitorId が 1 つも無い").toBeGreaterThan(0);

    // 履歴条件は history 未指定なら needs_history、渡せば評価される
    await call("PATCH", `/sites/${sid}/experiments/exp_lp`, {
      token: owner.token,
      body: { trafficPercentage: 100, targeting: { hist: "visited", page: { op: "contains", value: "/pricing" } } },
    });
    await publishRes(owner.token, sid);
    const noHist = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/" });
    expect(of(noHist.items, "exp_lp").reason).toBe("needs_history");
    const withHist = await evaluate(owner.token, sid, {
      url: "https://www.example.com/lp/",
      history: { pages: [{ page: { op: "contains", value: "/pricing" }, count: 2 }] },
    });
    expect(of(withHist.items, "exp_lp").eligible).toBe(true);
    const otherHist = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/", history: { pages: [] } });
    expect(of(otherHist.items, "exp_lp").reason).toBe("targeting_false");

    // Pause すると not_running(配信中の config から消える)
    expect((await call("POST", `/sites/${sid}/experiments/exp_lp/status`, { token: owner.token, body: { status: "paused" } })).status).toBe(200);
    const paused = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/", history: { pages: [{ page: { op: "contains", value: "/pricing" }, count: 2 }] } });
    expect(of(paused.items, "exp_lp")).toMatchObject({ eligible: false, reason: "not_running", status: "paused" });
    // draft: true なら paused も評価される(未公開の下書きを見る口)
    const asDraft = await evaluate(owner.token, sid, {
      url: "https://www.example.com/lp/",
      history: { pages: [{ page: { op: "contains", value: "/pricing" }, count: 2 }] },
      draft: true,
    });
    expect(asDraft.body!.source).toBe("draft");
    expect(of(asDraft.items, "exp_lp").eligible).toBe(true);

    // (a) 未 Publish の Site: D1 が running でも配っていない = not_published(決定 39 (7))
    // /setup は初回のみ(setup_closed)なので、既存 owner の別 Workspace として新しい Site を作る
    const wsFresh = (await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Fresh" } })));
    const { id: sid2 } = await createSite(owner.token, wsFresh.id);
    const { id: eid2 } = await createExperiment(owner.token, sid2, { id: "exp_unpublished", urlMatch: { op: "contains", value: "/lp/" } });
    await call("PUT", `/sites/${sid2}/experiments/${eid2}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    // Start は自動 Publish を伴うので、「未 Publish の running」は D1 の status を直接書いて作る
    await sql`update experiments set status = 'running' where site_id = ${sid2} and id = ${eid2}`.execute(getDb(env));
    const unpublished = await evaluate(owner.token, sid2, { url: "https://www.example.com/lp/" });
    expect(unpublished.body).toMatchObject({ source: "published", version: null }); // 未 Publish は version null
    expect(of(unpublished.items, "exp_unpublished")).toMatchObject({
      eligible: false,
      reason: "not_published",
      status: "running",
      published: false,
    });

    // (b) Publish 済みの Site でも、D1 が running なのに公開 config に無ければ not_published
    const { id: extra } = await createExperiment(owner.token, sid, { id: "exp_extra", urlMatch: { op: "contains", value: "/lp/" } });
    await call("PUT", `/sites/${sid}/experiments/${extra}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
    await sql`update experiments set status = 'running' where site_id = ${sid} and id = ${extra}`.execute(getDb(env));
    const drifted = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/" });
    expect(drifted.body!.version).not.toBeNull();
    expect(of(drifted.items, "exp_extra")).toMatchObject({
      eligible: false,
      reason: "not_published",
      status: "running",
      published: false,
    });
    // draft: true は D1 の現状を評価するので eligible(published は false のまま返る)
    const driftedDraft = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/", draft: true });
    expect(of(driftedDraft.items, "exp_extra")).toMatchObject({ eligible: true, published: false });
  });

  it("draft: true は未公開の変更を見る / draft: false は配信中の config を見る", async () => {
    const { owner, sid } = await publishedSite();
    // 公開後に URL 条件だけ書き換える(Publish しない)
    await call("PATCH", `/sites/${sid}/experiments/exp_lp`, { token: owner.token, body: { urlMatch: { op: "contains", value: "/new/" } } });
    const published = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/" });
    expect(of(published.items, "exp_lp").eligible).toBe(true); // 配信中はまだ /lp/
    const draft = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/", draft: true });
    expect(of(draft.items, "exp_lp").reason).toBe("url_mismatch"); // 下書きは /new/
  });

  it("VIEWER は評価でき、非メンバーは 404、未知フィールドは 422 封筒", async () => {
    const { owner, sid } = await publishedSite();
    const viewer = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await call("POST", `/sites/${sid}/evaluate`, { token: viewer.token, body: { url: "https://a.test/lp/" } })).status).toBe(200);
    // 存在しない Site は 404(テナント越しに存在を漏らさない)、無認証は 401
    expect((await call("POST", "/sites/site_nope/evaluate", { token: owner.token, body: { url: "https://a.test/" } })).status).toBe(404);
    expect((await call("POST", `/sites/${sid}/evaluate`, { body: { url: "https://a.test/" } })).status).toBe(401);
    const bad = await call("POST", `/sites/${sid}/evaluate`, { token: owner.token, body: { url: "https://a.test/", evil: 1 } });
    expect(bad.status).toBe(422);
    expect(await expectEnvelope(bad)).toMatchObject({ error: "validation_failed" });
  });

  it("API キーでも同じ結果を返す(決定 34)", async () => {
    const { owner, sid } = await publishedSite();
    const { key } = (await json(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "agent", workspaceId: owner.workspaceId } }))) as { key: string };
    const r = await evaluate(key, sid, { url: "https://www.example.com/lp/", visitorId: "visitor-1" });
    expect(r.res.status).toBe(200);
    expect(of(r.items, "exp_lp").eligible).toBe(true);
  });

  it("evaluate_uses_d1_active_version_and_never_touches_kv", async () => {
    // 決定 39 (7): 評価するのは **D1 に記録された active な公開 config**。KV active とずれていても D1 の版を返し、KV には触れない。
    // KV active 1 / D1 active_version 7 の作り方は publish.test.ts の
    // "cleanup keeps the version kv active points at even when d1 disagrees" と同じ(`:active` の put を握りつぶす KV)
    const { owner, sid } = await publishedSite(); // Start の自動 Publish で v1(KV active = "1")
    expect(await active(sid)).toBe("1");
    const db = getDb(env);
    const t0 = 1_800_000_000_000;
    const droppedActivePut = new Proxy(env.CONFIG_KV, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p !== "put") return typeof v === "function" ? v.bind(t) : v;
        return async (k: string, ...rest: unknown[]) => {
          if (/:active$/.test(k)) return; // 書いたことにして捨てる
          return (t.put as (...a: unknown[]) => unknown).apply(t, [k, ...rest]);
        };
      },
    }) as KVNamespace;
    const stuck = { ...testEnv, CONFIG_KV: droppedActivePut };
    for (let i = 1; i <= 6; i++) expect((await publishSite(stuck, db, await siteRow(sid), owner.userId, t0 + i * 1000)).ok).toBe(true); // v2..v7
    expect(await active(sid)).toBe("1"); // KV はまだ v1 を指している
    expect((await siteRow(sid)).active_version).toBe(7); // D1 だけが先に進んだ

    const keysBefore = (await env.CONFIG_KV.list()).keys.map((k) => k.name).sort();
    const r = await evaluate(owner.token, sid, { url: "https://www.example.com/lp/" });
    expect(r.res.status).toBe(200);
    expect(r.body!.source).toBe("published");
    expect(r.body!.version).toBe(7); // KV の 1 ではなく D1 の 7
    expect(of(r.items, "exp_lp")).toMatchObject({ eligible: true, status: "running", published: true });
    // 読取系の口は KV を読みも書きもしない(§13.10): キー一覧も active の値も前後で不変
    expect((await env.CONFIG_KV.list()).keys.map((k) => k.name).sort()).toEqual(keysBefore);
    expect(await active(sid)).toBe("1");
  });
});

describe("evaluate の新しい入力(決定 49、設計書 §13)", () => {
  const IPAD_SAFARI = "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
  type Result = { version: number | null; experiments: Array<{ experimentId: string; eligible: boolean; reason?: string }> };

  it("User-Agent・画面の幅・判定時刻・初回の訪問で判定し、欠ければ input_missing", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await createExperiment(owner.token, sid, {
      id: "exp_new",
      targeting: { and: [{ ctx: "browser", op: "in", value: ["safari"] }, { ctx: "viewport", minWidth: 768 }, { ctx: "sinceFirstVisit", op: "lt", days: 1 }] },
    });
    const evaluate = async (extra: Record<string, unknown>) =>
      (await json<Result>(await call("POST", `/sites/${sid}/evaluate`, { token: owner.token, body: { url: "https://www.example.com/", draft: true, ...extra } }))).experiments[0];
    expect(await evaluate({})).toMatchObject({ eligible: false, reason: "input_missing" });
    const now = 1_800_000_000_000;
    expect(await evaluate({ userAgent: IPAD_SAFARI, viewportWidth: 1024, now, firstVisitAt: now - 3_600_000 })).toMatchObject({ eligible: true });
    expect(await evaluate({ userAgent: IPAD_SAFARI, viewportWidth: 1024, now, firstVisitAt: null })).toMatchObject({ eligible: false, reason: "targeting_false" }); // null = 古い訪問者
    expect(await evaluate({ browser: "safari", viewportWidth: 1024, now, firstVisitAt: now })).toMatchObject({ eligible: true }); // browser を直接指定
  });

  it("evaluate_without_device_or_ua_reports_input_missing_for_device_condition(device の既定 desktop はやめた。ユーザー決定 2026-10-02)", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await createExperiment(owner.token, sid, { id: "exp_dev", targeting: { ctx: "device", op: "in", value: ["desktop"] } });
    await createExperiment(owner.token, sid, { id: "exp_any" });
    const r = await json<Result>(await call("POST", `/sites/${sid}/evaluate`, { token: owner.token, body: { url: "https://www.example.com/", draft: true } }));
    // device も userAgent も無い = 端末は不明。端末の条件を含むものだけが input_missing、端末に依らないものは通常どおり評価する
    expect(r.experiments.find((e) => e.experimentId === "exp_dev")).toMatchObject({ eligible: false, reason: "input_missing" });
    expect(r.experiments.find((e) => e.experimentId === "exp_any")).toMatchObject({ eligible: true });
  });

  it("published の評価は版 1 の公開済み設定を読まない(未知の版 = 公開 config 無し → not_published。backlog B52)", async () => {
    // 版 1(v0.9 の内部版)の形。版 2 が公開の最初の版なので、D1 に残っていても edge と同じく未知の版として扱う
    const SCHEMA_V1_CONFIG = {
      schemaVersion: 1, version: 7, siteSalt: "salt_v1", needsProfile: true,
      patterns: { p_pricing: { op: "contains", value: "/pricing" } }, prehide: { exp_v1: [] }, exposureSelectors: { exp_v1: [] }, goals: [],
      experiments: [{
        id: "exp_v1", name: "v1", urlMatch: { op: "regex", value: "^https://a\\.example/(lp|top)/" },
        targeting: { hist: "page_view_count", pattern: "p_pricing", gte: 2 }, trafficPercentage: 100, persistAssignment: false,
        variants: [{ id: "vA", name: "A", weight: 0, changes: [] }, { id: "vB", name: "B", weight: 100, changes: [] }],
      }],
    };
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await createExperiment(owner.token, sid, { id: "exp_v1" });
    await runDirect(sid, "exp_v1");
    const now = Date.now();
    await getDb(env)
      .insertInto("publishes")
      .values({
        id: "pub_v1", site_id: sid, version: 7, status: "active", config_hash: "x", config_json: JSON.stringify({ ...SCHEMA_V1_CONFIG, siteId: sid }),
        needs_profile: 1, error: null, kv_deleted: 0, published_by: owner.userId, created_at: now, activated_at: now,
      })
      .execute();
    await sql`update sites set active_version = 7 where id = ${sid}`.execute(getDb(env));
    const r = await json<Result>(
      await call("POST", `/sites/${sid}/evaluate`, { token: owner.token, body: { url: "https://a.example/lp/x", history: { pages: [{ page: { op: "contains", value: "/pricing" }, count: 2 }] } } }),
    );
    expect(r.version).toBe(7);
    expect(r.experiments.find((e) => e.experimentId === "exp_v1")).toMatchObject({ eligible: false, reason: "not_published" });
  });

  it("history.pages の旧形(パターン ID をキーにした record)は 422 で、配列の形を案内する", async () => {
    const { owner, sid } = await publishedSite();
    const res = await call("POST", `/sites/${sid}/evaluate`, { token: owner.token, body: { url: "https://www.example.com/lp/", history: { pages: { p_pricing: { count: 2 } } } } });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ error: "validation_failed", path: ["history", "pages"], hint: expect.stringContaining('"page"') });
  });

  it("期間の what-if(配列の history.pages・epoch 秒の lastAt・epoch ミリ秒の now)。lastAt が無ければ肯定でも否定でも input_missing", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId); // retentionDays は既定の 90
    const PRICING = { part: "path", op: "startsWith", value: "/pricing/" };
    await createExperiment(owner.token, sid, { id: "exp_recent", targeting: { hist: "visited", page: PRICING, withinDays: 30 } });
    await createExperiment(owner.token, sid, { id: "exp_not_recent", targeting: { not: { hist: "visited", page: PRICING, withinDays: 30 } } });
    const now = 1_800_000_000_000; // epoch ミリ秒
    const DAY = 86_400_000;
    const items = async (entry: Record<string, unknown>) =>
      (await evaluate(owner.token, sid, { url: "https://www.example.com/", draft: true, now, history: { pages: [{ page: PRICING, count: 2, ...entry }] } })).items;
    const inside = await items({ lastAt: Math.floor((now - 29 * DAY) / 1000) }); // 境界内(epoch 秒)
    expect(of(inside, "exp_recent")).toMatchObject({ eligible: true });
    expect(of(inside, "exp_not_recent")).toMatchObject({ eligible: false, reason: "targeting_false" });
    const outside = await items({ lastAt: Math.floor((now - 31 * DAY) / 1000) }); // 境界外
    expect(of(outside, "exp_recent")).toMatchObject({ eligible: false, reason: "targeting_false" });
    expect(of(outside, "exp_not_recent")).toMatchObject({ eligible: true });
    const missing = await items({}); // lastAt の欠落 = 期間を判定できない
    expect(of(missing, "exp_recent")).toMatchObject({ eligible: false, reason: "input_missing" });
    expect(of(missing, "exp_not_recent")).toMatchObject({ eligible: false, reason: "input_missing" }); // 否定でも配信を広げない
  });
});
