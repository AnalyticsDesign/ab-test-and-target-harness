import { beforeEach, describe, expect, it } from "vitest";
import { DEPLOY_HISTORY_DAYS, DEPLOY_HISTORY_LIMIT, parseCompiledConfig, SITE_REMOVED_SEQ, staticPaths, type CompiledConfig } from "@wtt/core";
import type { DeployInput } from "../src/cf-api";
import { DeployQueueLogic, RETRY_DELAYS_MS, type QueueStorage, type RuntimeBundle } from "../src/queue";

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
const RT: RuntimeBundle = { source: "/*RT1*/", hash: "rt1", previewSource: "/*PV1*/", previewHash: "pv1" };

let storage: MemStorage;
let deploys: DeployInput[];
let failNext: number;
let now: number;
function makeQueue(runtime = RT, rebakeBatch = 2) {
  return new DeployQueueLogic({
    storage, runtime, rebakeBatch, now: () => now,
    deploy: async (input) => {
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

beforeEach(() => { storage = new MemStorage(); deploys = []; failNext = 0; now = 1_000_000; });

describe("DeployQueueLogic", () => {
  it("1 Site の依頼を焼いてデプロイし、deployed を返す。manifest にはプレビューのファイルも入る", async () => {
    const q = makeQueue();
    const r = await q.redeploySite(req("site_a", 10, 1));
    expect(r).toEqual({ state: "deployed", accepted: { epoch: 10, seq: 1 }, deployed: { epoch: 10, seq: 1 }, deployedAt: new Date(now).toISOString() });
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
    expect(late).toEqual({ state: "deployed", accepted: { epoch: 10, seq: 2 }, deployed: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString() }); // 新しい中身が配られている
    expect(await servedText("site_a")).toContain("config v2");
    expect(deploys).toHaveLength(1); // 古い依頼ではデプロイしない(中身が変わらない)
  });

  it("中身が同じなら API を呼ばずに世代だけ進める", async () => {
    const q = makeQueue();
    await q.redeploySite(req("site_a", 10, 1, 1));
    const r = await q.redeploySite(req("site_a", 10, 2, 1)); // 同じ config(設定の保存で bootstrap に焼く値が変わらなかった等)
    expect(r).toEqual({ state: "deployed", accepted: { epoch: 10, seq: 2 }, deployed: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString() });
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
    expect(await q.siteStatus("site_a")).toEqual({ accepted: { epoch: 10, seq: 1 }, deployed: null, deployedAt: null, history: [], historyFrom: null, pending: true, lastError: expect.stringContaining("503") });
    now += RETRY_DELAYS_MS[0]!;
    await q.tick(); // alarm
    // deployedAt は依頼の時刻ではなく、デプロイが成功した時刻
    const at = new Date(now).toISOString();
    expect(await q.siteStatus("site_a")).toEqual({ accepted: { epoch: 10, seq: 1 }, deployed: { epoch: 10, seq: 1 }, deployedAt: at, history: [{ generation: { epoch: 10, seq: 1 }, deployedAt: at }], historyFrom: null, pending: false, lastError: null }); // 切り詰めていないので null
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
      { generation: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString() },
      { generation: { epoch: 10, seq: 1 }, deployedAt: t1 },
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
    const RT2: RuntimeBundle = { source: "/*RT2*/", hash: "rt2", previewSource: "/*PV2*/", previewHash: "pv2" };
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

  it("previews_keep_current_and_previous", async () => {
    await makeQueue(RT).redeploySite(req("site_a", 10, 1));
    const RT2: RuntimeBundle = { source: "/*RT2*/", hash: "rt2", previewSource: "/*PV2*/", previewHash: "pv2" };
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
    const RT2: RuntimeBundle = { source: "/*RT2*/", hash: "rt2", previewSource: "/*PV2*/", previewHash: "pv2" };
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
    expect((await q.siteStatus("site_a")).history).toEqual([{ generation: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString() }]);
    expect((await q.siteStatus("site_a")).historyFrom).toBeNull(); // 切り詰めていないので、履歴に無い seq 1 は「一度も配られていない」と言える
    // 比べる: seq 1 が配られてから seq 2 が配られた Site は、両方が履歴に残る(最新の世代と時刻だけでは区別できない)
    const t1 = new Date(now).toISOString();
    await q.redeploySite(req("site_b", 20, 1, 1));
    now += 1_000;
    await q.redeploySite(req("site_b", 20, 2, 2));
    expect((await q.siteStatus("site_b")).history).toEqual([
      { generation: { epoch: 20, seq: 2 }, deployedAt: new Date(now).toISOString() },
      { generation: { epoch: 20, seq: 1 }, deployedAt: t1 },
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
    expect(st.history).toEqual([{ generation: { epoch: 10, seq: 2 }, deployedAt: new Date(now).toISOString() }]); // 7 日より古い seq 1 は捨てた
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
});
