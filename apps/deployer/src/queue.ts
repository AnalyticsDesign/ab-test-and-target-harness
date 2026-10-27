import {
  bakeBootstrap,
  compareGeneration,
  DEPLOY_HISTORY_DAYS,
  DEPLOY_HISTORY_LIMIT,
  parseCompiledConfig,
  parseSiteSettings,
  STATIC_HEADERS_FILE,
  STATIC_SCRIPT_COMPATIBILITY_DATE,
  STATIC_SCRIPT_SOURCE,
  StaticBatchDeployRequestSchema,
  StaticDeployRequestSchema,
  staticInputDigest,
  staticPaths,
  StaticRemoveRequestSchema,
  type StaticBatchDeployResult,
  type StaticDeployResult,
  type StaticGeneration,
  type StaticInstanceStatus,
  type StaticSiteStatus,
} from "@wtt/core";
import { assetHash, manifestKey, toBase64, type Manifest } from "./assets";
import type { DeployInput, DeployOutcome } from "./cf-api";

/**
 * 決定 52 (4): 配信専用の Worker のデプロイを 1 本ずつ流す。DO(queue-do.ts)はこのクラスの薄い殻で、ここは DO に依存しない
 * (Node でテストする)。デプロイは全 Site の manifest で版を丸ごと置き換えるので、各デプロイは最新の全 Site の一覧から作る。
 *
 * - 状態の読み書き(index・Site の記録・ファイル)は stateLock、API の呼び出しを含むデプロイは deployLock で直列にする。
 *   API の待ちの間にも次の依頼を受け付けて焼いておけるので、続けて届いた依頼は次の 1 回のデプロイにまとまる
 * - 入力(control が渡した config と settings)は Site ごとに保存し、runtime が変わったら焼き直す(plan K6)
 * - ファイルの中身は `file:<hash>`(内容で決まるキー)に置く。デプロイの最中に Site が書き換わっても、送る中身はずれない
 * - Site ID をキーにする記録(index・デプロイ済みの記録)は Map にし、storage には [siteId, 値] の配列で置く。
 *   Site ID の規則は `__proto__`・`constructor` なども許すので、ふつうのオブジェクトの辞書では継承したプロパティを記録と取り違える
 * - 7o K23: 受け付けた入力の digest(`staticInputDigest`)を index の項目に、配った入力の digest を `deployed` の記録と履歴に持つ。
 *   同じ世代番号で中身が違うこと(D1 を戻して seq が同じ値に戻った)を control が見分けるため。digest の無い古い項目は、
 *   保存済みの入力(`site:<id>`)から補う
 */

export interface QueueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export type RuntimeBundle = { source: string; hash: string; previewSource: string; previewHash: string };
export type QueueDeps = {
  storage: QueueStorage;
  deploy: (input: DeployInput) => Promise<DeployOutcome>;
  runtime: RuntimeBundle;
  now: () => number;
  /** 1 回の起動で焼き直す Site の数(Task 1 の関門で決めた値。判定は「計測で打ち切られない」こと。5 件で約 34 ms) */
  rebakeBatch: number;
};

/**
 * Task 1 の関門の結果(docs/dev/static_bootstrap_spike_v1.md §5)。Workers Free の DO の起動は 12〜103 ms の CPU でも打ち切られず、
 * 5 件ずつなら最後の焼き直しの 1 回 + 全 Site のデプロイで約 34 ms に収まる(ユーザー決定 2026-10-07)
 */
export const REBAKE_BATCH = 5;
/** 失敗の後の再試行の間隔。最後の値で打ち止め(毎時の Cron と同じ間隔) */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000] as const;
/** 依頼を受けたら置く保険の alarm(デプロイの途中で起動が終わっても、この時刻に続きを流す) */
export const SAFETY_ALARM_MS = 30_000;
/** 焼き直しの続き */
export const REBAKE_ALARM_MS = 1_000;

type SiteInput = { config: unknown; settings: unknown; apiBase: string | null };
type SiteRecord = { input: SiteInput | null };
/** digest = 受け付けた入力の digest(7o K23。削除の項目と、この変更の前に受け付けた項目には無い。後者は読むときに補う) */
type IndexEntry = { gen: StaticGeneration; removed: boolean; hash: string | null; size: number; runtimeHash: string | null; digest?: string };
type Index = Map<string, IndexEntry>;
type PreviewEntry = { previewHash: string; hash: string; size: number };
/** gen = いま配られている(デプロイ済みの)この Site の世代。at = それをデプロイし終えた時刻(ms)。digest = 配った入力の digest(7o K23。古い記録には無い) */
type DeployedSite = { gen: StaticGeneration; at: number; digest?: string };
/**
 * 配った世代とデプロイし終えた時刻(ms)。新しい順、DEPLOY_HISTORY_DAYS 以内かつ最大 DEPLOY_HISTORY_LIMIT 件で、先頭が gen
 * (`siteStatus().history` の元。plan K21)。1 つの値の上限(2 MB)に当たらないよう、`deployed` のキーではなく Site ごとのキー `history:<siteId>` に置く
 */
type HistoryEntry = { gen: StaticGeneration; at: number; digest?: string }; // digest = 配った入力の digest(7o K24。古い項目には無い)
/** history:<siteId> に置く形。truncated = 一度でも記録を捨てたか(siteStatus の historyFrom の判断に使う) */
type HistoryRecord = { entries: HistoryEntry[]; truncated: boolean };
/** key = 前回デプロイした manifest(null = まだデプロイしていない、またはデプロイの失敗で捨てた) */
type Deployed = { key: string | null; sites: Map<string, DeployedSite> };
/** storage に置く形(Map は [siteId, 値] の配列にする) */
type DeployedStored = { key: string | null; sites: Array<[string, DeployedSite]> };
/**
 * lastDeployedAt = Cloudflare の API でのデプロイが最後に成功した時刻(ms。API を呼ばなかった flush では動かさない。7o K9)。
 * forceNext = 次の tick の配置を force にする印(force の redeploySites が立てる。7o K10)。読み書きはすべて stateLock の中。
 * forceSeq = forceNext を立てた回数。flush の snapshot の後(API の待ちのあいだ)に立て直された印を、その flush の成功で消さないために比べる
 * (forceNext だけでは「snapshot の前から立っていた」と「snapshot の後にもう一度立った」を見分けられない)。
 * 足した 3 つは古い記録には無く、無ければ undefined として読む
 */
type Meta = { failures: number; lastError: string | null; files: string[]; lastDeployedAt?: number; forceNext?: boolean; forceSeq?: number };
type Baked = { hash: string; size: number; b64: string };

const K = {
  index: "index",
  previews: "previews",
  deployed: "deployed",
  meta: "meta",
  site: (id: string) => `site:${id}`,
  history: (id: string) => `history:${id}`,
  file: (h: string) => `file:${h}`,
} as const;

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

/**
 * 応答に足す digest(7o K23。あるときだけ)。deployedDigest は、配った世代が index の世代と同じなら index の(補った)digest、
 * 違えば配った記録の digest。どちらも無ければ返さない(digest が分からないことを「配った」の根拠にしない)
 */
function digestsOf(entry: IndexEntry | undefined, site: DeployedSite | undefined): { acceptedDigest?: string; deployedDigest?: string } {
  const deployedDigest = site && entry && compareGeneration(site.gen, entry.gen) === 0 ? entry.digest : site?.digest;
  return {
    ...(entry?.digest !== undefined ? { acceptedDigest: entry.digest } : {}),
    ...(deployedDigest !== undefined ? { deployedDigest } : {}),
  };
}

/** force = 同じ manifest でも API を呼ぶ。useForceNext(tick だけ)= snapshot で forceNext が立っていれば force にする */
type FlushOptions = { force?: boolean; useForceNext?: boolean };

export class DeployQueueLogic {
  private readonly stateLock = new Mutex();
  private readonly deployLock = new Mutex();
  constructor(private readonly deps: QueueDeps) {}

  async redeploySite(raw: unknown): Promise<StaticDeployResult> {
    const req = StaticDeployRequestSchema.safeParse(raw);
    // 形が不正なら Site ID も信用できないので accepted は null
    if (!req.success) return { state: "rejected", accepted: null, deployed: null, deployedAt: null, error: "invalid_request" };
    const { siteId, generation } = req.data;
    const input: SiteInput = { config: req.data.config, settings: req.data.settings, apiBase: req.data.apiBase };
    const baked = await this.bake(siteId, input); // CPU の重い部分はロックの外
    if (!baked) return { state: "rejected", accepted: (await this.index()).get(siteId)?.gen ?? null, ...(await this.deployedOf(siteId)), error: "invalid_payload" };
    const digest = await staticInputDigest(input); // bake が通った入力なので parse できる
    const accepted = await this.stateLock.run(() => this.accept(siteId, generation, input, baked, digest));
    if (accepted) await this.arm(this.deps.now() + SAFETY_ALARM_MS);
    if (await this.runtimeOutdated()) await this.arm(this.deps.now() + REBAKE_ALARM_MS);
    // 同期の flush は forceNext では force にしない(7o K10)。API を呼んで成功すれば、snapshot にあった forceNext はこの配置が兼ねて消える
    return this.resultFor(siteId, generation, await this.flush({ force: req.data.force === true }));
  }

  /**
   * 7o K10: 5 サイトまでをまとめて受け付ける。通常の要素はロックの外で焼き、stateLock の中で 1 件ずつ accept に渡す
   * (index に入る世代は必ず焼いてある。焼けなかった要素は index に入れない)。削除の要素は焼かずに削除として受け付ける
   * (removeSite のような同期の配置はしない)。配置は待たずに返し、alarm で 1 回にまとめる
   */
  async redeploySites(raw: unknown): Promise<StaticBatchDeployResult> {
    const req = StaticBatchDeployRequestSchema.safeParse(raw);
    if (!req.success) return { state: "rejected", sites: [], error: "invalid_request" };
    type Prepared = { siteId: string; gen: StaticGeneration; ok: boolean; input: SiteInput | null; baked: Baked | null; digest?: string };
    const prepared: Prepared[] = [];
    for (const s of req.data.sites) {
      if ("remove" in s) {
        prepared.push({ siteId: s.siteId, gen: s.generation, ok: true, input: null, baked: null });
        continue;
      }
      const input: SiteInput = { config: s.config, settings: s.settings, apiBase: s.apiBase };
      const baked = await this.bake(s.siteId, input); // CPU の重い部分はロックの外
      if (!baked) {
        console.error("static batch site rejected", s.siteId); // 7o K15。config・settings は出さない
        prepared.push({ siteId: s.siteId, gen: s.generation, ok: false, input: null, baked: null });
        continue;
      }
      prepared.push({ siteId: s.siteId, gen: s.generation, ok: true, input, baked, digest: await staticInputDigest(input) });
    }
    const { anyAccepted, sites } = await this.stateLock.run(async () => {
      let anyAccepted = false;
      for (const p of prepared) if (p.ok && (await this.accept(p.siteId, p.gen, p.input, p.baked, p.digest))) anyAccepted = true;
      if (anyAccepted && req.data.force === true) await this.markForceNext();
      // accepted = 処理の後に受け付け済みのその Site の世代(捨てた要素・形の不正の要素も、今の世代か null)
      const index = await this.index();
      const sites = prepared.map((p) => ({ siteId: p.siteId, accepted: index.get(p.siteId)?.gen ?? null, ...(p.ok ? {} : { error: "invalid_payload" as const }) }));
      return { anyAccepted, sites };
    });
    if (anyAccepted) await this.arm(this.deps.now() + (req.data.flush === "soon" ? REBAKE_ALARM_MS : SAFETY_ALARM_MS));
    return { state: "accepted", sites };
  }

  async removeSite(raw: unknown): Promise<StaticDeployResult> {
    const req = StaticRemoveRequestSchema.safeParse(raw);
    if (!req.success) return { state: "rejected", accepted: null, deployed: null, deployedAt: null, error: "invalid_request" };
    const { siteId, generation } = req.data;
    const accepted = await this.stateLock.run(() => this.accept(siteId, generation, null, null, undefined));
    if (accepted) await this.arm(this.deps.now() + SAFETY_ALARM_MS);
    return this.resultFor(siteId, generation, await this.flush());
  }

  async siteStatus(siteId: string): Promise<StaticSiteStatus> {
    const entry = (await this.stateLock.run(() => this.indexWithDigests())).get(siteId);
    const accepted = entry?.gen ?? null;
    const site = (await this.deployed()).sites.get(siteId);
    const deployed = site?.gen ?? null;
    const rec = await this.history(siteId);
    // digest は、ある項目だけ(この変更の前に配った項目には無い。7o K24)
    const history = rec.entries.map((h) => ({ generation: h.gen, deployedAt: new Date(h.at).toISOString(), ...(h.digest !== undefined ? { digest: h.digest } : {}) }));
    const meta = await this.meta();
    return {
      accepted,
      deployed,
      deployedAt: site ? new Date(site.at).toISOString() : null,
      history,
      // 履歴は先頭に足して古い方から捨てるだけなので、残っている最も古い記録から先は欠けが無い。一度も捨てていなければ null(欠けが無い)
      historyFrom: rec.truncated ? (history.at(-1)?.deployedAt ?? null) : null,
      pending: accepted !== null && (deployed === null || compareGeneration(deployed, accepted) < 0),
      lastError: meta.lastError,
      ...digestsOf(entry, site),
    };
  }

  /**
   * 7o K9: index の全サイト(削除の墓標を含む)の世代と digest、配置の失敗の記録。index・deployed・meta を stateLock の中で 1 回ずつ読む
   * (digest の無い古い項目があるあいだは、その数だけ `site:<id>` を読んで補い、index に書き戻す)
   */
  async instanceStatus(): Promise<StaticInstanceStatus> {
    return this.stateLock.run(async () => {
      const index = await this.indexWithDigests();
      const deployed = await this.deployed();
      const meta = await this.meta();
      return {
        sites: [...index].map(([siteId, e]) => {
          const site = deployed.sites.get(siteId);
          return { siteId, accepted: e.gen, deployed: site?.gen ?? null, removed: e.removed, ...digestsOf(e, site) };
        }),
        failures: meta.failures,
        lastError: meta.lastError,
        lastDeployedAt: meta.lastDeployedAt !== undefined ? new Date(meta.lastDeployedAt).toISOString() : null,
      };
    });
  }

  /** alarm と毎時の Cron。プレビューの更新 → 焼き直し(バッチ)→ 残りがあれば続きの alarm、無ければデプロイ */
  async tick(): Promise<void> {
    const remaining = await this.stateLock.run(async () => {
      await this.ensurePreviews();
      return this.rebakeSome();
    });
    if (remaining > 0) {
      await this.deps.storage.setAlarm(this.deps.now() + REBAKE_ALARM_MS);
      return;
    }
    await this.flush({ useForceNext: true }); // snapshot で forceNext が立っていれば force で配置する(7o K10)
  }

  // ---- 内部 ----

  /** config と settings を core のスキーマで検証して焼く。Site ID が食い違えば null(別 Site のファイルを書かない) */
  private async bake(siteId: string, input: SiteInput): Promise<Baked | null> {
    const config = parseCompiledConfig(input.config);
    const settings = parseSiteSettings(input.settings);
    if (!config || !settings || config.siteId !== siteId || settings.siteId !== siteId) return null;
    const rt = this.deps.runtime;
    const { b64, size } = toBase64(bakeBootstrap(config, settings, rt.source, { apiBase: input.apiBase, runtimeHash: rt.hash }));
    return { hash: await assetHash(b64, "js"), size, b64 };
  }

  /**
   * stateLock の中で呼ぶ。保存済みより新しい世代だけ受ける(順不同の依頼・削除の墓標。plan K2)。
   * digest = 受け付ける入力の digest(削除は undefined)。捨てた依頼では index も `site:<id>` も書かないので、digest は前の入力のまま(7o K23)
   */
  private async accept(siteId: string, gen: StaticGeneration, input: SiteInput | null, baked: Baked | null, digest: string | undefined): Promise<boolean> {
    await this.ensurePreviews();
    const index = await this.index();
    const cur = index.get(siteId);
    if (cur && compareGeneration(gen, cur.gen) <= 0) return false;
    if (baked) await this.putFile(baked);
    await this.deps.storage.put<SiteRecord>(K.site(siteId), { input });
    index.set(siteId, {
      gen, removed: input === null, hash: baked?.hash ?? null, size: baked?.size ?? 0, runtimeHash: baked ? this.deps.runtime.hash : null,
      ...(digest !== undefined ? { digest } : {}),
    });
    await this.saveIndex(index);
    return true;
  }

  /**
   * 最新の全 Site の一覧でデプロイする。前回と中身が同じなら API を呼ばずに世代だけ進める(force なら同じでも API を呼ぶ)。
   * forceNext は snapshot と一緒に読む。消すのは、snapshot で立っていて API を呼んで成功した flush だけ
   * (snapshot の後に立て直された印は forceSeq の違いで残す。API を呼ばなかった flush・失敗した flush も消さない。7o K10)
   */
  private flush(opts: FlushOptions = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.deployLock.run(async () => {
      const snap = await this.stateLock.run(async () => {
        const meta = await this.meta();
        return { index: await this.indexWithDigests(), previews: await this.previews(), forceNext: meta.forceNext === true, forceSeq: meta.forceSeq ?? 0 };
      });
      const manifest = buildManifest(snap.index, snap.previews);
      const key = manifestKey(manifest);
      const deployed = await this.deployed();
      const callApi = opts.force === true || (opts.useForceNext === true && snap.forceNext) || deployed.key !== key;
      if (callApi) {
        try {
          await this.deps.deploy({
            manifest,
            contentOf: async (h) => {
              const b64 = await this.deps.storage.get<string>(K.file(h));
              if (b64 === undefined) throw new Error(`missing file ${h}`);
              return b64;
            },
            headersFile: STATIC_HEADERS_FILE,
            scriptSource: STATIC_SCRIPT_SOURCE,
            compatibilityDate: STATIC_SCRIPT_COMPATIBILITY_DATE,
          });
        } catch (e) {
          const error = errorText(e);
          const failures = await this.stateLock.run(async () => {
            // 失敗の後は実物の状態が分からない(PUT がサーバー側で適用済みで、こちらには失敗に見えただけかもしれない)。
            // 前回の manifest の記録を捨て、次の flush では同じ中身(前回成功した manifest に戻る依頼を含む)でも API を呼ばせる
            await this.saveDeployed({ ...deployed, key: null });
            return this.scheduleRetry(error);
          });
          // 7o K15。error は errorText の後の文(CfApiError の message はトークンを含まない)。config・settings は出さない
          console.error("static deploy failed", { failures, error });
          return { ok: false as const, error };
        }
      }
      await this.stateLock.run(async () => {
        // 世代が変わった Site だけ記録と履歴の先頭を更新する。他の Site のためのデプロイ・runtime の焼き直し(世代は同じ)では前の記録を残す
        // (deployLock の中なので、上で読んだ deployed が直前の記録)
        const at = this.deps.now();
        const sites = new Map<string, DeployedSite>();
        for (const [id, e] of snap.index) {
          const prev = deployed.sites.get(id);
          if (prev && compareGeneration(prev.gen, e.gen) === 0) {
            sites.set(id, prev);
            continue;
          }
          // 配った入力の digest を写す(snapshot の index は古い項目も補ってある。7o K23・K24)
          sites.set(id, { gen: e.gen, at, ...(e.digest !== undefined ? { digest: e.digest } : {}) });
          await this.appendHistory(id, e.gen, at, e.digest);
        }
        await this.saveDeployed({ key, sites });
        const meta = await this.meta();
        // forceNext は snapshot で立っていて、API を呼んで成功し、その後に立て直されていない(forceSeq が同じ)ときだけ消す
        const clearForce = callApi && snap.forceNext && (meta.forceSeq ?? 0) === snap.forceSeq;
        await this.deps.storage.put<Meta>(K.meta, {
          ...meta, failures: 0, lastError: null,
          ...(callApi ? { lastDeployedAt: at } : {}),
          ...(clearForce ? { forceNext: false } : {}),
        });
        await this.gcFiles();
        if (await this.isClean()) await this.deps.storage.deleteAlarm();
      });
      return { ok: true as const };
    });
  }

  private async resultFor(siteId: string, gen: StaticGeneration, r: { ok: true } | { ok: false; error: string }): Promise<StaticDeployResult> {
    // accepted = 依頼を処理した後に受け付け済みのこの Site の世代(control の削除は、これが送った墓標のときだけ進む。plan K23)
    const entry = (await this.stateLock.run(() => this.indexWithDigests())).get(siteId);
    const accepted = entry?.gen ?? null;
    const site = (await this.deployed()).sites.get(siteId);
    const deployed = site?.gen ?? null;
    const deployedAt = site ? new Date(site.at).toISOString() : null;
    const digests = digestsOf(entry, site);
    if (deployed && compareGeneration(deployed, gen) >= 0) return { state: "deployed", accepted, deployed, deployedAt, ...digests };
    return { state: "pending", accepted, deployed, deployedAt, ...(r.ok ? {} : { error: r.error }), ...digests };
  }

  /** いま配られている世代と、それをデプロイし終えた時刻 */
  private async deployedOf(siteId: string): Promise<{ deployed: StaticGeneration | null; deployedAt: string | null }> {
    const site = (await this.deployed()).sites.get(siteId);
    return { deployed: site?.gen ?? null, deployedAt: site ? new Date(site.at).toISOString() : null };
  }

  /**
   * stateLock の中で呼ぶ。Site ごとの履歴の先頭に足し、DEPLOY_HISTORY_DAYS より古い記録と DEPLOY_HISTORY_LIMIT を超えた記録を捨てる(plan K21)。
   * 足すときだけ切り詰めるので、先頭(いま配られている世代)は必ず残る
   */
  private async appendHistory(siteId: string, gen: StaticGeneration, at: number, digest: string | undefined): Promise<void> {
    const minAt = at - DEPLOY_HISTORY_DAYS * 86_400_000;
    const prev = await this.history(siteId);
    const head: HistoryEntry = { gen, at, ...(digest !== undefined ? { digest } : {}) };
    const kept = [head, ...prev.entries.filter((h) => h.at >= minAt)];
    const entries = kept.slice(0, DEPLOY_HISTORY_LIMIT);
    // 1 件でも捨てたら truncated(以後 historyFrom = 残っている最も古い記録の時刻)
    const truncated = prev.truncated || entries.length < prev.entries.length + 1;
    await this.deps.storage.put<HistoryRecord>(K.history(siteId), { entries, truncated });
  }

  /** stateLock の中で呼ぶ。戻り値 = 足した後の連続の失敗回数 */
  private async scheduleRetry(error: string): Promise<number> {
    const meta = await this.meta();
    const failures = meta.failures + 1;
    await this.deps.storage.put<Meta>(K.meta, { ...meta, failures, lastError: error });
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1]!;
    await this.deps.storage.setAlarm(this.deps.now() + delay); // 保険の alarm より後でも、失敗の後は間隔をあける
    return failures;
  }

  /** stateLock の中で呼ぶ。次の tick の配置を force にする印(7o K10) */
  private async markForceNext(): Promise<void> {
    const meta = await this.meta();
    await this.deps.storage.put<Meta>(K.meta, { ...meta, forceNext: true, forceSeq: (meta.forceSeq ?? 0) + 1 });
  }

  /** いまの alarm より早いときだけ置き直す */
  private async arm(at: number): Promise<void> {
    const cur = await this.deps.storage.getAlarm();
    if (cur === null || cur > at) await this.deps.storage.setAlarm(at);
  }

  private async runtimeOutdated(): Promise<boolean> {
    const index = await this.index();
    return [...index.values()].some((e) => !e.removed && e.runtimeHash !== this.deps.runtime.hash);
  }

  /** stateLock の中で呼ぶ。runtime が古い Site を rebakeBatch 件まで焼き直す。戻り値 = まだ残っている数 */
  private async rebakeSome(): Promise<number> {
    const index = await this.index();
    const stale = [...index]
      .filter(([, e]) => !e.removed && e.runtimeHash !== this.deps.runtime.hash)
      .map(([id]) => id)
      .sort();
    for (const id of stale.slice(0, this.deps.rebakeBatch)) {
      const cur = index.get(id)!;
      const rec = await this.deps.storage.get<SiteRecord>(K.site(id));
      const baked = rec?.input ? await this.bake(id, rec.input) : null;
      if (baked) {
        await this.putFile(baked);
        index.set(id, { ...cur, hash: baked.hash, size: baked.size, runtimeHash: this.deps.runtime.hash });
      } else {
        // 保存した入力が新しい core で読めない(互換の規則では起きない)。古いファイルを残して止め、次の依頼で直す
        index.set(id, { ...cur, runtimeHash: this.deps.runtime.hash });
        const meta = await this.meta();
        await this.deps.storage.put<Meta>(K.meta, { ...meta, lastError: `rebake_failed: ${id}` });
        console.error("static rebake failed", id); // 7o K15。保存した入力は出さない
      }
    }
    await this.saveIndex(index);
    return Math.max(0, stale.length - this.deps.rebakeBatch);
  }

  /** stateLock の中で呼ぶ。プレビューのファイルを今の版 + 1 つ前の版にそろえる(plan K8) */
  private async ensurePreviews(): Promise<void> {
    const previews = await this.previews();
    const rt = this.deps.runtime;
    if (previews[0]?.previewHash === rt.previewHash) return;
    const { b64, size } = toBase64(rt.previewSource);
    const hash = await assetHash(b64, "js");
    await this.putFile({ hash, size, b64 });
    const next = [{ previewHash: rt.previewHash, hash, size }, ...previews.filter((p) => p.previewHash !== rt.previewHash)].slice(0, 2);
    await this.deps.storage.put(K.previews, next);
  }

  /**
   * forceNext が立っているあいだは片づいていない(7o K10。まとめた受け付けと alarm の間に別のサイトの同期の flush が走っても、
   * alarm を消して強制の配置を毎時の Cron まで遅らせない)
   */
  private async isClean(): Promise<boolean> {
    if ((await this.meta()).forceNext === true) return false;
    const manifest = buildManifest(await this.index(), await this.previews());
    return (await this.deployed()).key === manifestKey(manifest) && !(await this.runtimeOutdated());
  }

  private async putFile(f: Baked): Promise<void> {
    await this.deps.storage.put(K.file(f.hash), f.b64);
    const meta = await this.meta();
    if (!meta.files.includes(f.hash)) await this.deps.storage.put<Meta>(K.meta, { ...meta, files: [...meta.files, f.hash] });
  }

  /** stateLock の中で呼ぶ。index とプレビューから参照されないファイルの中身を消す */
  private async gcFiles(): Promise<void> {
    const used = new Set<string>();
    for (const e of (await this.index()).values()) if (e.hash) used.add(e.hash);
    for (const p of await this.previews()) used.add(p.hash);
    const meta = await this.meta();
    const keep = meta.files.filter((h) => used.has(h));
    for (const h of meta.files) if (!used.has(h)) await this.deps.storage.delete(K.file(h));
    if (keep.length !== meta.files.length) await this.deps.storage.put<Meta>(K.meta, { ...meta, files: keep });
  }

  private async index(): Promise<Index> {
    return new Map((await this.deps.storage.get<Array<[string, IndexEntry]>>(K.index)) ?? []);
  }
  /**
   * stateLock の中で呼ぶ。digest の無い削除でない項目(この変更の前に受け付けた項目)を、保存済みの入力から bake と同じく parse して補い、
   * 補えたら index に書き戻す(以後は `site:<id>` を読まない)。入力が parse できない項目は digest の無いまま(7o K23)
   */
  private async indexWithDigests(): Promise<Index> {
    const index = await this.index();
    let filled = false;
    for (const [id, e] of index) {
      if (e.removed || e.digest !== undefined) continue;
      const rec = await this.deps.storage.get<SiteRecord>(K.site(id));
      if (!rec?.input) continue;
      let digest: string;
      try {
        digest = await staticInputDigest(rec.input);
      } catch {
        continue; // 読めない入力の中身はログに出さない
      }
      index.set(id, { ...e, digest });
      filled = true;
    }
    if (filled) await this.saveIndex(index);
    return index;
  }
  private async saveIndex(index: Index): Promise<void> {
    await this.deps.storage.put<Array<[string, IndexEntry]>>(K.index, [...index]);
  }
  private async deployed(): Promise<Deployed> {
    const s = await this.deps.storage.get<DeployedStored>(K.deployed);
    return s ? { key: s.key, sites: new Map(s.sites) } : { key: null, sites: new Map() };
  }
  private async saveDeployed(d: Deployed): Promise<void> {
    await this.deps.storage.put<DeployedStored>(K.deployed, { key: d.key, sites: [...d.sites] });
  }
  private async history(siteId: string): Promise<HistoryRecord> {
    return (await this.deps.storage.get<HistoryRecord>(K.history(siteId))) ?? { entries: [], truncated: false };
  }
  private async previews(): Promise<PreviewEntry[]> {
    return (await this.deps.storage.get<PreviewEntry[]>(K.previews)) ?? [];
  }
  private async meta(): Promise<Meta> {
    return (await this.deps.storage.get<Meta>(K.meta)) ?? { failures: 0, lastError: null, files: [] };
  }
}

/** 削除されていない Site のファイルと、プレビューのファイル */
export function buildManifest(index: Index, previews: PreviewEntry[]): Manifest {
  const m: Manifest = {};
  for (const [siteId, e] of index) if (!e.removed && e.hash) m[staticPaths.site(siteId)] = { hash: e.hash, size: e.size };
  for (const p of previews) m[staticPaths.preview(p.previewHash)] = { hash: p.hash, size: p.size };
  return m;
}
