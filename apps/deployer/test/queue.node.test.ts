import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DEPLOY_HISTORY_DAYS, DEPLOY_HISTORY_LIMIT, parseCompiledConfig, SITE_REMOVED_SEQ, staticInputDigest, staticPaths, type CompiledConfig } from "@wtt/core";
import type { DeployInput } from "../src/cf-api";
import { DeployQueueLogic, REBAKE_ALARM_MS, RETRY_DELAYS_MS, SAFETY_ALARM_MS, type QueueStorage, type RuntimeBundle } from "../src/queue";

/** DO の storage の代わり(KV の API と alarm だけ) */
class MemStorage implements QueueStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(k: string) { return structuredClone(this.data.get(k)) as T | undefined; }
  async put<T>(k: string, v: T) { this.data.set(k, structuredClone(v)); }
  async delete(k: string) { return this.data.delete(k); }
  async getAlarm() { return this.alarm; }
  async setAlarm(at: number) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
}

const CONFIG: CompiledConfig = {
  schemaVersion: 2, version: 1, siteId: "site_a", siteSalt: "s", needsProfile: false,
  patterns: {}, prehide: {}, exposureSelectors: {}, goals: [], experiments: [], exposurePayloads: {},
};
const cfgOf = (siteId: string, version: number): CompiledConfig => ({ ...CONFIG, siteId, version });
const settingsOf = (siteId: string) => ({ settingsVersion: 1, siteId });
const req = (siteId: string, epoch: number, seq: number, version = seq) => ({
  protocol: 1 as const, siteId, generation: { epoch, seq }, config: cfgOf(siteId, version), settings: settingsOf(siteId), apiBase: "https://edge.example",
});
/** まとめた依頼(redeploySites)の通常の要素(protocol と force を持たない) */
const el = (siteId: string, epoch: number, seq: number, version = seq) => {
  const { protocol: _protocol, ...site } = req(siteId, epoch, seq, version);
  return site;
};
/** req(siteId, …, version) で送った入力の digest(7o K23) */
const dig = (siteId: string, version: number) => staticInputDigest({ config: cfgOf(siteId, version), settings: settingsOf(siteId), apiBase: "https://edge.example" });
const RT: RuntimeBundle = { source: "/*RT1*/", hash: "rt1", previewSource: "/*PV1*/", previewHash: "pv1" };
const RT2: RuntimeBundle = { source: "/*RT2*/", hash: "rt2", previewSource: "/*PV2*/", previewHash: "pv2" };

let storage: MemStorage;
let deploys: DeployInput[];
let failNext: number;
let now: number;
/** 偽の API の応答を止めておく(gate が解けるまで deploy が返らない)。deployStarted は API の呼び出しに入ったときに呼ぶ */
let gate: Promise<void> | null;
let deployStarted: (() => void) | null;
let errSpy: MockInstance<typeof console.error>;
function makeQueue(runtime = RT, rebakeBatch = 2) {
  return new DeployQueueLogic({
    storage, runtime, rebakeBatch, now: () => now,
    deploy: async (input) => {
      deployStarted?.();
      if (gate) await gate;
      if (failNext > 0) { failNext--; throw new Error("HTTP 503"); }
      deploys.push(input);
      return { uploadedFiles: 0, buckets: 0, apiCalls: 2 };
    },
  });
}
/** 最後のデプロイの manifest から、Site のファイルの中身(焼いた bootstrap)を読む */
async function servedText(siteId: string): Promise<string | null> {
  const last = deploys.at(-1);
  const e = last?.manifest[staticPaths.site(siteId)];
  if (!e) return null;
  return Buffer.from(await last!.contentOf(e.hash), "base64").toString("utf8");
}

/** 更新前の DO の形にする: index・deployed・履歴の記録から digest を消す(7o K23 の古い記録) */
function stripDigests(): void {
  const strip = <T extends object>(v: T) => { const { digest: _d, ...rest } = v as T & { digest?: string }; return rest; };
  const index = storage.data.get("index") as Array<[string, object]>;
  storage.data.set("index", index.map(([id, e]) => [id, strip(e)]));
  const deployed = storage.data.get("deployed") as { key: string | null; sites: Array<[string, object]> } | undefined;
  if (deployed) storage.data.set("deployed", { ...deployed, sites: deployed.sites.map(([id, d]) => [id, strip(d)]) });
  for (const [k, v] of storage.data) {
    if (k.startsWith("history:")) { const h = v as { entries: object[]; truncated: boolean }; storage.data.set(k, { ...h, entries: h.entries.map(strip) }); }
  }
}

beforeEach(() => {
  storage = new MemStorage(); deploys = []; failNext = 0; now = 1_000_000; gate = null; deployStarted = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); // 配置の失敗のログ(K15)をテストの出力に出さない
});
afterEach(() => vi.restoreAllMocks());

describe("DeployQueueLogic", () => {
  it("1 Site の依頼を焼いてデプロイし、deployed を返す。manifest にはプレビューのファイルも入る", async () => {
    const q = makeQueue();
    const r = await q.redeploySite(req("site_a", 10, 1));
    const d = await dig("site_a", 1);
    expect(r).toEqual({ state: "deployed", accepted: { epoch: 10, seq: 1 }, deployed: { epoch: 10, seq: 1 }, deployedAt: new Date(now).toISOString(), acceptedDigest: d, deployedDigest: d });
    expect(Object.keys(deploys[0]!.manifest).sort()).toEqual([staticPaths.preview("pv1"), staticPaths.site("site_a")].sort());
    const text = (await servedText("site_a"))!;
    expect(text.startsWith("/* AB Test and Target Harness bootstrap (site site_a, config v1, runtime rt1) */")).toBe(true);
    expect(text).toContain('"apiBase":"https://edge.example"');
    expect(text.endsWith("/*RT1*/")).toBe(true);
  });

  it("static_requests_out_of_order_keep_newest", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 2, 2)); // 新しい方が先に届く
    const late = await q.redeploySite(req("site_a", 10, 1, 1)); // 古い依頼が遅れて届く
    const d2 = await dig("site_a", 2); // 残った(新しいほうの)入力の digest。捨てた古い依頼の digest ではない(triage S2-F2)
    expect(late).toEqual({ state: "deployed", accepted: { epoch: 10, seq: 2 }, deployed: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString(), acceptedDigest: d2, deployedDigest: d2 }); // 新しい中身が配られている
    expect(await q.siteStatus("site_a")).toMatchObject({ acceptedDigest: d2, deployedDigest: d2 });
    expect(await servedText("site_a")).toContain("config v2");
    expect(deploys).toHaveLength(1); // 古い依頼ではデプロイしない(中身が変わらない)
  });

  it("中身が同じなら API を呼ばずに世代だけ進める", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1));
    const r = await q.redeploySite(req("site_a", 10, 2, 1)); // 同じ config(設定の保存で bootstrap に焼く値が変わらなかった等)
    const d = await dig("site_a", 1);
    expect(r).toEqual({ state: "deployed", accepted: { epoch: 10, seq: 2 }, deployed: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString(), acceptedDigest: d, deployedDigest: d });
    expect(deploys).toHaveLength(1);
  });

  it("並行した依頼は直列に流れ、最後のデプロイに両方の Site が入る", async () => {
    const q = makeQueue();
    const [a, b] = await Promise.all([q.redeploySite(req("site_a", 10, 1)), q.redeploySite(req("site_b", 20, 1))]);
    expect(a.state).toBe("deployed");
    expect(b.state).toBe("deployed");
    expect(Object.keys(deploys.at(-1)!.manifest)).toEqual(expect.arrayContaining([staticPaths.site("site_a"), staticPaths.site("site_b")]));
  });

  it("deploy_failure_schedules_retry_and_retry_succeeds", async () => {
    const q = makeQueue();
    failNext = 1;
    const r = await q.redeploySite(req("site_a", 10, 1));
    expect(r.state).toBe("pending");
    expect(r.deployed).toBeNull();
    expect(r.error).toContain("503");
    expect(storage.alarm).toBe(now + RETRY_DELAYS_MS[0]!);
    expect(r.accepted).toEqual({ epoch: 10, seq: 1 }); // 受け付けは済んでいる(alarm で再試行する)
    const d = await dig("site_a", 1);
    expect(await q.siteStatus("site_a")).toEqual({ accepted: { epoch: 10, seq: 1 }, deployed: null, deployedAt: null, history: [], historyFrom: null, pending: true, lastError: expect.stringContaining("503"), acceptedDigest: d }); // 配っていないので deployedDigest は無い
    now += RETRY_DELAYS_MS[0]!;
    await q.tick(); // alarm
    // deployedAt は依頼の時刻ではなく、デプロイが成功した時刻
    const at = new Date(now).toISOString();
    expect(await q.siteStatus("site_a")).toEqual({ accepted: { epoch: 10, seq: 1 }, deployed: { epoch: 10, seq: 1 }, deployedAt: at, history: [{ generation: { epoch: 10, seq: 1 }, deployedAt: at, digest: d }], historyFrom: null, pending: false, lastError: null, acceptedDigest: d, deployedDigest: d }); // 切り詰めていないので null
    expect(storage.alarm).toBeNull(); // 片づいたら alarm を消す
  });

  it("static_status_deployed_at_follows_deployed_generation", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1));
    const t1 = new Date(now).toISOString();
    expect((await q.siteStatus("site_a")).deployedAt).toBe(t1);

    now += 60_000;
    await q.redeploySite(req("site_b", 20, 1)); // 他の Site のためのデプロイ。site_a の世代は同じなので時刻は動かない
    expect((await q.siteStatus("site_a")).deployedAt).toBe(t1);
    expect((await q.siteStatus("site_b")).deployedAt).toBe(new Date(now).toISOString());

    now += 60_000;
    failNext = 1;
    await q.redeploySite(req("site_a", 10, 2, 2)); // デプロイの失敗では、配られている世代も時刻も前のまま
    expect(await q.siteStatus("site_a")).toMatchObject({ deployed: { epoch: 10, seq: 1 }, deployedAt: t1, pending: true });

    now += 60_000;
    await q.tick(); // 再試行で成功 → 新しい世代の時刻で上書き
    expect(await q.siteStatus("site_a")).toMatchObject({ deployed: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString(), pending: false });
    // 履歴には配った 2 つの世代が新しい順に残る(他の Site のためのデプロイでは足さない)
    expect((await q.siteStatus("site_a")).history).toEqual([
      { generation: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString(), digest: await dig("site_a", 2) },
      { generation: { epoch: 10, seq: 1 }, deployedAt: t1, digest: await dig("site_a", 1) },
    ]);
    expect((await q.siteStatus("site_c")).deployedAt).toBeNull(); // 知らない Site
    expect((await q.siteStatus("site_c")).history).toEqual([]);
  });

  it("失敗が続くと再試行の間隔を延ばし、最後は 1 時間ごと", async () => {
    const q = makeQueue();
    failNext = 10;
    await q.redeploySite(req("site_a", 10, 1));
    for (const d of RETRY_DELAYS_MS.slice(1)) { await q.tick(); expect(storage.alarm).toBe(now + d); }
    await q.tick();
    expect(storage.alarm).toBe(now + RETRY_DELAYS_MS.at(-1)!);
  });

  it("removed_site_tombstone_blocks_older_but_not_recreated_site", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 3));
    expect(await q.removeSite({ protocol: 1, siteId: "site_a", generation: { epoch: 10, seq: SITE_REMOVED_SEQ } })).toEqual({ state: "deployed", accepted: { epoch: 10, seq: SITE_REMOVED_SEQ }, deployed: { epoch: 10, seq: SITE_REMOVED_SEQ }, deployedAt: new Date(now).toISOString() });
    expect(await servedText("site_a")).toBeNull(); // ファイルが消えた
    // 同じ墓標をもう一度送っても accepted はその墓標のまま(冪等。ワークスペースの削除のやり直しで使う)
    expect(await q.removeSite({ protocol: 1, siteId: "site_a", generation: { epoch: 10, seq: SITE_REMOVED_SEQ } })).toMatchObject({ accepted: { epoch: 10, seq: SITE_REMOVED_SEQ } });
    await q.redeploySite(req("site_a", 10, 4)); // 削除の前に出た依頼が遅れて届いても復活しない
    expect(await servedText("site_a")).toBeNull();
    const re = await q.redeploySite(req("site_a", 11, 1)); // 同じ ID で作り直した Site(created_at が大きい)
    expect(re.state).toBe("deployed");
    expect(await servedText("site_a")).toContain("config v1");
  });

  it("壊れた依頼(形・config・settings・Site ID の食い違い)は rejected で、何も変えない", async () => {
    const q = makeQueue();
    expect((await q.redeploySite({ protocol: 1 })).state).toBe("rejected");
    expect((await q.redeploySite({ ...req("site_a", 10, 1), config: { nope: 1 } })).state).toBe("rejected");
    expect((await q.redeploySite({ ...req("site_a", 10, 1), settings: { settingsVersion: 1, siteId: "site_x" } })).state).toBe("rejected");
    expect((await q.redeploySite({ ...req("site_a", 10, 1), config: cfgOf("site_x", 1) })).state).toBe("rejected");
    expect(deploys).toHaveLength(0);
    expect((await q.siteStatus("site_a")).accepted).toBeNull();
  });

  it("runtime_change_rebakes_all_sites", async () => {
    const q1 = makeQueue(RT, 2);
    for (const s of ["site_a", "site_b", "site_c"]) await q1.redeploySite(req(s, 10, 1));
    const atBefore = (await q1.siteStatus("site_a")).deployedAt;
    now += 60_000;
    const q2 = makeQueue(RT2, 2); // 新しい runtime を同梱したデプロイ専用の Worker(DO の作り直し)
    const before = deploys.length;
    await q2.tick(); // 1 回目: 2 件焼き直し、残りがあるので続きの alarm だけ置く(デプロイしない)
    expect(deploys.length).toBe(before);
    expect(storage.alarm).toBe(now + 1_000);
    await q2.tick(); // 2 回目: 残り 1 件を焼き直してデプロイ
    expect(deploys.length).toBe(before + 1);
    for (const s of ["site_a", "site_b", "site_c"]) expect((await servedText(s))!.endsWith("/*RT2*/")).toBe(true);
    expect((await q2.siteStatus("site_a")).deployedAt).toBe(atBefore); // 焼き直しは世代が同じ(届く定義は変わらない)なので時刻を動かさない
  });

  it("rebake_strips_legacy_names", async () => {
    // 名前付き・conversionPayloads 無しの古い config を、古い runtime の hash で保存する(B77、K6)
    const legacy: CompiledConfig = {
      ...CONFIG,
      goals: [{ id: "g_buy", name: "購入完了", type: "CUSTOM", config: {} }],
      experiments: [{
        id: "exp1", name: "社内のヒーロー検証", trafficPercentage: 100, persistAssignment: true, urlMatch: { op: "contains", value: "/lp/" },
        variants: [{ id: "a", name: "A案", weight: 50, changes: [] }, { id: "b", name: "B案", weight: 50, changes: [] }],
      }],
    };
    await makeQueue(RT).redeploySite({ ...req("site_a", 10, 1), config: legacy });
    now += 60_000;
    await makeQueue(RT2, 10).tick(); // runtime の hash が変わったので焼き直す
    const text = (await servedText("site_a"))!;
    expect(text.endsWith("/*RT2*/")).toBe(true);
    expect(text).not.toContain('"name":');
    const boot = JSON.parse(text.slice(text.indexOf("self.__WTT_BOOT__=") + "self.__WTT_BOOT__=".length, text.lastIndexOf(";\n")));
    expect(boot.config.conversionPayloads.g_buy).toEqual({ goalId: "g_buy", goalName: "購入完了" }); // 名前だった値は payload にだけ残る
    expect(boot.config.exposurePayloads.exp1.b).toMatchObject({ experimentName: "社内のヒーロー検証", variantName: "B案" });
  });

  it("previews_keep_current_and_previous", async () => {
    await makeQueue(RT).redeploySite(req("site_a", 10, 1));
    await makeQueue(RT2, 10).tick();
    const RT3: RuntimeBundle = { source: "/*RT3*/", hash: "rt3", previewSource: "/*PV3*/", previewHash: "pv3" };
    await makeQueue(RT3, 10).tick();
    const paths = Object.keys(deploys.at(-1)!.manifest);
    expect(paths).toContain(staticPaths.preview("pv3"));
    expect(paths).toContain(staticPaths.preview("pv2"));
    expect(paths).not.toContain(staticPaths.preview("pv1"));
  });

  it("依頼の時に runtime の変化に気づいたら、焼き直しの alarm を 1 秒後に置く", async () => {
    await makeQueue(RT).redeploySite(req("site_a", 10, 1));
    await makeQueue(RT).redeploySite(req("site_b", 20, 1));
    await makeQueue(RT2, 10).redeploySite(req("site_a", 10, 2));
    expect((await servedText("site_a"))!.endsWith("/*RT2*/")).toBe(true); // 依頼の Site は新しい runtime で焼く
    expect(storage.alarm).toBe(now + 1_000); // site_b は alarm で焼き直す
  });

  it("使われなくなったファイルの中身は storage から消える", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1));
    await q.redeploySite(req("site_a", 10, 2, 2));
    const fileKeys = [...storage.data.keys()].filter((k) => k.startsWith("file:"));
    expect(fileKeys).toHaveLength(2); // site_a の今のファイル + プレビュー
  });

  it("config の版 1 は焼かない(版 1 の読み取りは backlog B52 で削除。edge と同じく未知の版)", async () => {
    const v1 = { ...req("site_a", 10, 1).config, schemaVersion: 1 };
    expect(parseCompiledConfig(v1)).toBeNull();
    const q = makeQueue();
    const r = await q.redeploySite({ ...req("site_a", 10, 1), config: v1 });
    expect(r).toMatchObject({ state: "rejected", error: "invalid_payload" }); // 何も配らない
  });

  it("static_status_history_keeps_overtaken_generations_out", async () => {
    // seq 1 は受け付けたがデプロイに失敗し、再試行の前に seq 2 が届く(seq 1 は一度も配られていない)
    const q = makeQueue();
    failNext = 1;
    await q.redeploySite(req("site_a", 10, 1, 1));
    now += 1_000;
    await q.redeploySite(req("site_a", 10, 2, 2));
    expect((await q.siteStatus("site_a")).history).toEqual([{ generation: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString(), digest: await dig("site_a", 2) }]);
    expect((await q.siteStatus("site_a")).historyFrom).toBeNull(); // 切り詰めていないので、履歴に無い seq 1 は「一度も配られていない」と言える
    // 比べる: seq 1 が配られてから seq 2 が配られた Site は、両方が履歴に残る(最新の世代と時刻だけでは区別できない)
    const t1 = new Date(now).toISOString();
    await q.redeploySite(req("site_b", 20, 1, 1));
    now += 1_000;
    await q.redeploySite(req("site_b", 20, 2, 2));
    expect((await q.siteStatus("site_b")).history).toEqual([
      { generation: { epoch: 20, seq: 2 }, deployedAt: new Date(now).toISOString(), digest: await dig("site_b", 2) },
      { generation: { epoch: 20, seq: 1 }, deployedAt: t1, digest: await dig("site_b", 1) },
    ]);
  });

  it("履歴は Site ごとに新しい順で DEPLOY_HISTORY_LIMIT(100)件まで。historyFrom は残った最も古い記録の時刻", async () => {
    expect(DEPLOY_HISTORY_LIMIT).toBe(100);
    const q = makeQueue();
    for (let seq = 1; seq <= DEPLOY_HISTORY_LIMIT + 2; seq++) {
      now += 1_000;
      await q.redeploySite(req("site_a", 10, seq, seq));
    }
    const st = await q.siteStatus("site_a");
    const h = st.history;
    expect(h).toHaveLength(DEPLOY_HISTORY_LIMIT);
    expect(h[0]!.generation.seq).toBe(DEPLOY_HISTORY_LIMIT + 2);
    expect(h.at(-1)!.generation.seq).toBe(3); // 古い 2 件(seq 1・2)は捨てた
    expect(st.historyFrom).toBe(h.at(-1)!.deployedAt); // seq 1・2 の時刻より後。それより前の世代は「配られなかった」と言えない
  });

  it("履歴は DEPLOY_HISTORY_DAYS(7 日)より古い記録を捨てる", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1));
    now += DEPLOY_HISTORY_DAYS * 86_400_000 + 1;
    await q.redeploySite(req("site_a", 10, 2, 2));
    const st = await q.siteStatus("site_a");
    expect(st.history).toEqual([{ generation: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString(), digest: await dig("site_a", 2) }]); // 7 日より古い seq 1 は捨てた
    expect(st.historyFrom).toBe(new Date(now).toISOString());
  });

  it("site_ids_like_object_keys_are_isolated", async () => {
    // Site ID の規則は __proto__ なども許す。Site ごとの記録が辞書の継承したプロパティと取り違えない
    const q = makeQueue();
    const ids = ["__proto__", "constructor", "toString"];
    for (const [i, id] of ids.entries()) expect((await q.redeploySite(req(id, 10 + i, 1))).state).toBe("deployed");
    for (const [i, id] of ids.entries()) expect((await q.siteStatus(id)).deployed).toEqual({ epoch: 10 + i, seq: 1 });
    expect(Object.keys(deploys.at(-1)!.manifest)).toEqual(expect.arrayContaining(ids.map((id) => staticPaths.site(id))));
    expect((await q.siteStatus("site_unknown")).accepted).toBeNull(); // 知らない ID
  });

  it("force は前回と同じ manifest でも API を呼ぶ(配信専用の Worker の実物が記録とずれたときの作り直し)", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1));
    await q.redeploySite({ ...req("site_a", 10, 2, 1), force: true }); // 同じ config
    expect(deploys).toHaveLength(2);
  });

  it("失敗したデプロイの後は、中身が前回成功した manifest に戻る依頼でも API を呼ぶ(PUT がサーバー側で適用済みかもしれない)", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1)); // A が成功
    failNext = 1;
    await q.redeploySite(req("site_a", 10, 2, 2)); // B が失敗(実物は B かもしれない)
    expect(deploys).toHaveLength(1);
    const r = await q.redeploySite(req("site_a", 10, 3, 1)); // 中身は A に戻る
    expect(deploys).toHaveLength(2); // 「前回と同じ manifest」として API を省かない
    expect(await servedText("site_a")).toContain("config v1");
    expect(r.state).toBe("deployed");
  });

  it("force のデプロイが失敗した後の再試行は、同じ manifest でも API を呼ぶ", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1));
    failNext = 1;
    const r = await q.redeploySite({ ...req("site_a", 10, 2, 1), force: true }); // 同じ config で force、失敗
    expect(r.state).toBe("pending");
    expect(deploys).toHaveLength(1);
    now += RETRY_DELAYS_MS[0]!;
    await q.tick(); // alarm の再試行(force ではない)
    expect(deploys).toHaveLength(2);
    expect((await q.siteStatus("site_a")).deployed).toEqual({ epoch: 10, seq: 2 });
  });

  it("トークンが無い設定(deploy が not_configured で失敗する)では pending と理由を返す", async () => {
    const q = new DeployQueueLogic({
      storage, runtime: RT, rebakeBatch: 2, now: () => now,
      deploy: async () => { throw new Error("not_configured: CF_ACCOUNT_ID / CF_DEPLOY_TOKEN"); },
    });
    const r = await q.redeploySite(req("site_a", 10, 1));
    expect(r.state).toBe("pending");
    expect(r.error).toContain("not_configured");
    expect((await q.siteStatus("site_a")).lastError).toContain("not_configured");
  });

  // ---- 7o: instanceStatus・redeploySites・入力の digest・forceNext・ログ ----

  it("deployer_instance_status_reports_removed_and_pending", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1));
    const tA = new Date(now).toISOString();
    now += 1_000;
    // 墓標の受け付け(配るファイルが無いので manifest は変わらず、API を呼ばない)
    await q.removeSite({ protocol: 1, siteId: "site_b", generation: { epoch: 20, seq: SITE_REMOVED_SEQ } });
    now += 1_000;
    failNext = 1;
    await q.redeploySite(req("site_c", 30, 1));
    const da = await dig("site_a", 1);
    expect(await q.instanceStatus()).toEqual({
      sites: [
        { siteId: "site_a", accepted: { epoch: 10, seq: 1 }, deployed: { epoch: 10, seq: 1 }, removed: false, acceptedDigest: da, deployedDigest: da },
        { siteId: "site_b", accepted: { epoch: 20, seq: SITE_REMOVED_SEQ }, deployed: { epoch: 20, seq: SITE_REMOVED_SEQ }, removed: true },
        { siteId: "site_c", accepted: { epoch: 30, seq: 1 }, deployed: null, removed: false, acceptedDigest: await dig("site_c", 1) },
      ],
      failures: 1,
      lastError: "HTTP 503",
      lastDeployedAt: tA, // 墓標の flush は API を呼ばなかったので動かない
    });
    now += RETRY_DELAYS_MS[0]!;
    await q.tick(); // 再試行で成功
    const tC = new Date(now).toISOString();
    expect(await q.instanceStatus()).toMatchObject({ failures: 0, lastError: null, lastDeployedAt: tC });
    now += 60_000;
    const before = deploys.length;
    await q.tick(); // 中身が同じで API を呼ばない flush
    expect(deploys).toHaveLength(before);
    expect((await q.instanceStatus()).lastDeployedAt).toBe(tC);
  });

  it("配置の失敗のあいだに受け付けた墓標は removed で、deployed は accepted より古いまま(triage S2-F5)", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1));
    failNext = 1;
    await q.removeSite({ protocol: 1, siteId: "site_a", generation: { epoch: 10, seq: SITE_REMOVED_SEQ } });
    const st = await q.instanceStatus();
    expect(st.sites).toHaveLength(1);
    expect(st.sites[0]).toMatchObject({ siteId: "site_a", removed: true, accepted: { epoch: 10, seq: SITE_REMOVED_SEQ }, deployed: { epoch: 10, seq: 1 } });
    expect(st.lastError).toBe("HTTP 503");
    expect(st.failures).toBe(1);
  });

  it("deployer_batch_accepts_without_waiting_and_flushes_once", async () => {
    const q = makeQueue();
    const first = ["site_1", "site_2", "site_3", "site_4", "site_5"];
    const second = ["site_6", "site_7", "site_8"];
    const a = await q.redeploySites({ protocol: 1, sites: first.map((id) => el(id, 10, 1)), flush: "later" });
    expect(a).toEqual({ state: "accepted", sites: first.map((siteId) => ({ siteId, accepted: { epoch: 10, seq: 1 } })) });
    expect(storage.alarm).toBe(now + SAFETY_ALARM_MS);
    const b = await q.redeploySites({ protocol: 1, sites: second.map((id) => el(id, 10, 1)), flush: "soon" });
    expect(b).toEqual({ state: "accepted", sites: second.map((siteId) => ({ siteId, accepted: { epoch: 10, seq: 1 } })) });
    expect(deploys).toHaveLength(0); // 配置は待たない
    expect(storage.alarm).toBe(now + REBAKE_ALARM_MS);
    await q.tick();
    expect(deploys).toHaveLength(1); // 8 サイトを 1 回の配置で
    expect(Object.keys(deploys[0]!.manifest).sort()).toEqual([...first, ...second].map((id) => staticPaths.site(id)).concat(staticPaths.preview("pv1")).sort());
    expect(storage.alarm).toBeNull();
  });

  it("6 件のまとめた依頼は rejected で何も変えない。Site ID の食い違う件だけ invalid_payload で、他の件は受け付ける", async () => {
    const q = makeQueue();
    const six = ["s1", "s2", "s3", "s4", "s5", "s6"].map((id) => el(id, 10, 1));
    expect(await q.redeploySites({ protocol: 1, sites: six, flush: "soon" })).toEqual({ state: "rejected", sites: [], error: "invalid_request" });
    expect(storage.data.has("index")).toBe(false);
    expect(storage.alarm).toBeNull();

    await q.redeploySite(req("site_b", 20, 1));
    const r = await q.redeploySites({
      protocol: 1,
      sites: [el("site_a", 10, 1), { ...el("site_b", 20, 2), config: cfgOf("site_x", 2) }, { ...el("site_c", 30, 1), config: cfgOf("site_y", 1) }],
      flush: "soon",
    });
    expect(r).toEqual({
      state: "accepted",
      sites: [
        { siteId: "site_a", accepted: { epoch: 10, seq: 1 } },
        { siteId: "site_b", accepted: { epoch: 20, seq: 1 }, error: "invalid_payload" }, // 今の index の世代
        { siteId: "site_c", accepted: null, error: "invalid_payload" }, // index に無い
      ],
    });
    expect(errSpy).toHaveBeenCalledWith("static batch site rejected", "site_b");
    expect(errSpy).toHaveBeenCalledWith("static batch site rejected", "site_c");
  });

  it("まとめた依頼の削除の要素は焼かずに受け付け、同期の配置をしない", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1));
    await q.redeploySite(req("site_b", 20, 1));
    const before = deploys.length;
    const tomb = { epoch: 10, seq: SITE_REMOVED_SEQ };
    const r = await q.redeploySites({ protocol: 1, sites: [{ siteId: "site_a", generation: tomb, remove: true }, el("site_c", 30, 1)], flush: "soon" });
    expect(r).toEqual({ state: "accepted", sites: [{ siteId: "site_a", accepted: tomb }, { siteId: "site_c", accepted: { epoch: 30, seq: 1 } }] });
    expect(deploys).toHaveLength(before); // removeSite のような同期の配置は走らない
    await q.tick();
    expect(deploys).toHaveLength(before + 1);
    const paths = Object.keys(deploys.at(-1)!.manifest);
    expect(paths).not.toContain(staticPaths.site("site_a"));
    expect(paths).toEqual(expect.arrayContaining([staticPaths.site("site_b"), staticPaths.site("site_c")]));
    expect((await q.instanceStatus()).sites.find((s) => s.siteId === "site_a")).toMatchObject({ removed: true, accepted: tomb, deployed: tomb });
  });

  it("force の redeploySites の後の tick は同じ manifest でも API を呼び、成功で forceNext が消える。間の force なしの flush では消えない", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1));
    await q.redeploySite(req("site_b", 20, 1, 1));
    expect(deploys).toHaveLength(2);
    await q.redeploySites({ protocol: 1, sites: [el("site_a", 10, 2, 1)], force: true, flush: "soon" }); // 同じ中身
    expect(deploys).toHaveLength(2);
    await q.tick();
    expect(deploys).toHaveLength(3); // force の配置
    await q.tick();
    expect(deploys).toHaveLength(3); // forceNext は消えた
    expect(storage.alarm).toBeNull();

    await q.redeploySites({ protocol: 1, sites: [el("site_a", 10, 3, 1)], force: true, flush: "soon" });
    await q.redeploySite(req("site_b", 20, 2, 1)); // 別のサイトの force なしの依頼。manifest が変わらないので API を呼ばない
    expect(deploys).toHaveLength(3);
    expect(storage.alarm).not.toBeNull(); // forceNext が立っているので片づいていない(isClean が false)
    await q.tick();
    expect(deploys).toHaveLength(4); // forceNext は残っていた
  });

  it("force_request_received_during_flush_is_preserved", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1));
    await q.redeploySites({ protocol: 1, sites: [el("site_a", 10, 2, 1)], force: true, flush: "soon" });
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { deployStarted = r; });
    const ticking = q.tick(); // force の flush が API を待つ
    await started;
    deployStarted = null;
    const r = await q.redeploySites({ protocol: 1, sites: [el("site_a", 10, 3, 1)], force: true, flush: "soon" }); // snapshot の後に届いた force
    expect(r.state).toBe("accepted");
    gate = null;
    release();
    await ticking;
    expect(deploys).toHaveLength(2);
    expect((storage.data.get("meta") as { forceNext?: boolean }).forceNext).toBe(true); // 先の flush の成功では消さない
    expect(storage.alarm).not.toBeNull();
    await q.tick();
    expect(deploys).toHaveLength(3); // もう一度 force で API を呼ぶ
    await q.tick();
    expect(deploys).toHaveLength(3);
  });

  it("古い世代・同じ世代のまとめた依頼は捨て、acceptedDigest は前の入力のまま(K23)", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 2, 2));
    const old = await q.redeploySites({ protocol: 1, sites: [el("site_a", 10, 1, 1)], flush: "soon" });
    expect(old).toEqual({ state: "accepted", sites: [{ siteId: "site_a", accepted: { epoch: 10, seq: 2 } }] });
    const same = await q.redeploySites({ protocol: 1, sites: [el("site_a", 10, 2, 3)], flush: "soon" }); // 同じ世代・別の入力
    expect(same).toEqual({ state: "accepted", sites: [{ siteId: "site_a", accepted: { epoch: 10, seq: 2 } }] });
    expect(storage.alarm).toBeNull(); // 1 件も受け付けていないので alarm を置かない
    expect((await q.siteStatus("site_a")).acceptedDigest).toBe(await dig("site_a", 2));
  });

  it("古い形の storage(digest の無い index・deployed・履歴)は保存済みの入力から digest を補う(K23)", async () => {
    const q0 = makeQueue();
    await q0.redeploySite(req("site_a", 10, 1, 1));
    await q0.redeploySite(req("site_b", 20, 1, 1));
    failNext = 1;
    await q0.redeploySite(req("site_b", 20, 2, 2)); // site_b は配った世代が index の世代より古い
    stripDigests(); // 更新前の DO の形
    const q = makeQueue();
    const da = await dig("site_a", 1);
    const db2 = await dig("site_b", 2);
    const sa = await q.siteStatus("site_a");
    expect(sa).toMatchObject({ acceptedDigest: da, deployedDigest: da });
    expect(sa.history[0]).not.toHaveProperty("digest"); // 古い履歴の項目は digest の無いまま返る(K24)
    const sb = await q.siteStatus("site_b");
    expect(sb.acceptedDigest).toBe(db2);
    expect(sb).not.toHaveProperty("deployedDigest"); // 配った世代の digest は分からない
    const st = await q.instanceStatus();
    expect(st.sites).toEqual([
      { siteId: "site_a", accepted: { epoch: 10, seq: 1 }, deployed: { epoch: 10, seq: 1 }, removed: false, acceptedDigest: da, deployedDigest: da },
      { siteId: "site_b", accepted: { epoch: 20, seq: 2 }, deployed: { epoch: 20, seq: 1 }, removed: false, acceptedDigest: db2 },
    ]);
    // 補った digest は index に書き戻してあるので、次の読み取りは site:<id> を読まない
    const getSpy = vi.spyOn(storage, "get");
    await q.siteStatus("site_a");
    await q.instanceStatus();
    expect(getSpy.mock.calls.map(([k]) => k).filter((k) => k.startsWith("site:"))).toEqual([]);
    getSpy.mockRestore();
    // 同じ世代・別の入力の依頼は捨てられ、acceptedDigest は補った(前の入力の)値のまま
    const r = await q.redeploySite(req("site_a", 10, 1, 5));
    expect(r.acceptedDigest).toBe(da);
  });

  it("更新前に受け付けて配置待ちだった世代を更新後に配ると、履歴の項目に補った digest が入る(K24)", async () => {
    const q0 = makeQueue();
    failNext = 1;
    await q0.redeploySite(req("site_a", 10, 1, 1));
    stripDigests();
    const q = makeQueue();
    now += RETRY_DELAYS_MS[0]!;
    await q.tick();
    const d = await dig("site_a", 1);
    const st = await q.siteStatus("site_a");
    expect(st.history).toEqual([{ generation: { epoch: 10, seq: 1 }, deployedAt: new Date(now).toISOString(), digest: d }]);
    expect(st).toMatchObject({ acceptedDigest: d, deployedDigest: d });
  });

  it("保存済みの入力が読めない古い index の項目には digest を付けない", async () => {
    const q0 = makeQueue();
    await q0.redeploySite(req("site_a", 10, 1, 1));
    stripDigests();
    storage.data.set("site:site_a", { input: { config: { nope: 1 }, settings: settingsOf("site_a"), apiBase: null } });
    const q = makeQueue();
    const st = await q.instanceStatus();
    expect(st.sites[0]).toEqual({ siteId: "site_a", accepted: { epoch: 10, seq: 1 }, deployed: { epoch: 10, seq: 1 }, removed: false });
    expect(await q.siteStatus("site_a")).not.toHaveProperty("acceptedDigest");
  });

  it("配置の失敗と焼き直しの失敗をログに出す。config・settings・トークンは出さない(K15)", async () => {
    const token = "tok-SECRET-value";
    const failing = new DeployQueueLogic({
      storage, runtime: RT, rebakeBatch: 2, now: () => now,
      // 本番の deploy はトークンを閉じ込めて API を呼ぶ。失敗の文はトークンを含まない(CfApiError)
      deploy: async () => { void token; throw new Error("HTTP 503"); },
    });
    await failing.redeploySite(req("site_a", 10, 1));
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("static deploy failed", { failures: 1, error: "HTTP 503" });
    now += RETRY_DELAYS_MS[0]!;
    await makeQueue().tick(); // 再試行で成功
    storage.data.set("site:site_a", { input: { config: { nope: 1 }, settings: settingsOf("site_a"), apiBase: "https://edge.example" } });
    await makeQueue(RT2, 10).tick(); // 新しい runtime で焼き直せない
    expect(errSpy).toHaveBeenCalledWith("static rebake failed", "site_a");
    const logged = JSON.stringify(errSpy.mock.calls);
    for (const secret of [token, "siteSalt", "settingsVersion", "edge.example", "nope"]) expect(logged).not.toContain(secret);
  });
});
