import { z } from "zod";
import { bootPayload } from "./bake";
import { parseCompiledConfig } from "./config-read";
import { isExactOrigin, parseSiteSettings, SITE_ID_RE } from "./settings";

/**
 * 決定 52: bootstrap を配信専用の Worker の静的アセットから配る。control → デプロイ専用の Worker の依頼と結果の形、
 * asset のパス・ヘッダ・配信専用の Worker のスクリプトを 1 か所に置く(control・deployer・fixture の CLI・admin の E2E の偽の API が共有)
 */

/** asset のパス。設置タグの URL と同じ形で、先頭の / を含む(Cloudflare の manifest のキー) */
export const staticPaths = {
  site: (siteId: string) => `/s/${siteId}.js`,
  preview: (previewHash: string) => `/s/preview/${previewHash}.js`,
} as const;

/** `_headers`。今の edge の bootstrap と同じ 3 つ。プレビューも同じ 60 秒(plan K9: 規則を 1 つにして同じヘッダの連結を避ける) */
export const STATIC_HEADERS_FILE =
  "/s/*\n  Cache-Control: public, max-age=60\n  Content-Type: text/javascript; charset=utf-8\n  X-Content-Type-Options: nosniff\n";

/** 配信専用の Worker のスクリプト。asset に一致しない要求(未 Publish の Site・古いプレビュー)だけがここに来る */
export const STATIC_SCRIPT_SOURCE =
  'export default { fetch() { return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }); } };\n';
export const STATIC_SCRIPT_COMPATIBILITY_DATE = "2026-08-01";

/**
 * 出し直しの世代。epoch = max(sites.created_at, sites.static_epoch)(作り直した Site を区別。削除の墓標に負けた Site は墓標 + 1 に進める)、
 * seq = sites.static_seq(依頼のたびに D1 で進める)
 */
export type StaticGeneration = { epoch: number; seq: number };
const GenerationSchema = z.strictObject({ epoch: z.number().int().min(0), seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });

export function compareGeneration(a: StaticGeneration, b: StaticGeneration): number {
  return a.epoch !== b.epoch ? a.epoch - b.epoch : a.seq - b.seq;
}

/** Site の削除の墓標の seq。削除の前に出た依頼は必ずこれより小さい */
export const SITE_REMOVED_SEQ = Number.MAX_SAFE_INTEGER;

const SiteId = z.string().regex(SITE_ID_RE);

/** 出し直しの依頼。config / settings の中身はデプロイ専用の Worker が parseCompiledConfig / parseSiteSettings で検証する */
export const StaticDeployRequestSchema = z.strictObject({
  protocol: z.literal(1),
  siteId: SiteId,
  generation: GenerationSchema,
  config: z.unknown(),
  settings: z.unknown(),
  apiBase: z.string().refine(isExactOrigin).nullable(),
  /** true なら前回と同じ manifest でも API を呼ぶ(管理画面の「配信ファイルを作り直す」。実物が記録とずれたときの直し) */
  force: z.boolean().optional(),
});
export type StaticDeployRequest = z.infer<typeof StaticDeployRequestSchema>;

export const StaticRemoveRequestSchema = z.strictObject({ protocol: z.literal(1), siteId: SiteId, generation: GenerationSchema });
export type StaticRemoveRequest = z.infer<typeof StaticRemoveRequestSchema>;

/**
 * accepted = 依頼を処理した後に、デプロイ専用の Worker(DO)が受け付け済みのこの Site の世代(形の不正で Site が分からなければ null)。
 * 削除は、これがちょうど送った墓標の世代のときだけ進む(より新しい通常の世代に追い越された墓標を削除の成功と取り違えない。plan K23)。
 * deployed = いま配られている(デプロイ済みの)この Site の世代。依頼の世代以上なら、依頼の中身かそれより新しい中身が配られている。
 * deployedAt = `deployed` の世代をデプロイし終えた時刻(`deployed` が null なら null)。
 * acceptedDigest / deployedDigest = それぞれの世代の入力の digest(`staticInputDigest`。対象は boot payload。7o K23)。
 * 同じ世代番号で中身が違うこと(D1 を戻して seq が同じ値に戻った場合)を見分けるために持つ。
 * デプロイ専用の Worker は digest の無い古い index の項目を保存済みの入力から補うので、`acceptedDigest` は受け付けた削除でない項目に必ず入り、
 * `deployedDigest` が無いのは、配った世代が今の受け付けより古いとき(その履歴の記録に digest が無いとき)だけ。
 * どちらも任意の項目なので、古いデプロイ専用の Worker の応答にも無いことがある
 */
export type StaticDeployResult = {
  state: "deployed" | "pending" | "rejected";
  accepted: StaticGeneration | null;
  deployed: StaticGeneration | null;
  deployedAt: string | null;
  error?: string;
  acceptedDigest?: string;
  deployedDigest?: string;
};

/**
 * 配った世代とデプロイし終えた時刻(UTC、ISO 8601)。
 * digest = 配った入力の digest(`staticInputDigest`。7o K24)。D9 の配信の確認が、同じ世代番号の別の中身(D1 を戻した後の依頼)を
 * 古い配信の証拠にしないために使う。この変更より前に配った項目には無い
 */
export type StaticDeployHistoryEntry = { generation: StaticGeneration; deployedAt: string; digest?: string };
/** Site ごとに持つ配った世代の履歴の保持: 7 日以内、かつ最大 100 件(plan K21) */
export const DEPLOY_HISTORY_DAYS = 7;
export const DEPLOY_HISTORY_LIMIT = 100;
/**
 * deployedAt = `deployed` の世代をデプロイし終えた時刻(UTC、ISO 8601)。DO の状態に持ち、Cloudflare には問い合わせ直さない。
 * 世代が進んだときだけ更新し、他の Site のためのデプロイや runtime の焼き直し(世代は同じ)では動かさない。`deployed` が null なら null。
 * history = 配った世代と時刻(新しい順、DEPLOY_HISTORY_DAYS 以内かつ最大 DEPLOY_HISTORY_LIMIT 件)。追い越されて一度も配られなかった世代は入らない。
 * historyFrom = 履歴を切り詰めたことがあれば残っている最も古い記録の時刻、一度も切り詰めていなければ null(履歴に欠けが無い)。
 * これより前に依頼した世代は、history に無くても配られなかったとは言えない。null なら、history に無い世代は一度も配られていない
 * (最初のデプロイの前に追い越された世代も含む)。
 * D9 の届く定義の `delivered_from` は history と historyFrom から取る(plan「D9 への申し送り」)。
 * acceptedDigest / deployedDigest は `StaticDeployResult` と同じ意味(7o K23)
 */
export type StaticSiteStatus = {
  accepted: StaticGeneration | null;
  deployed: StaticGeneration | null;
  deployedAt: string | null;
  history: StaticDeployHistoryEntry[];
  historyFrom: string | null;
  pending: boolean;
  lastError: string | null;
  acceptedDigest?: string;
  deployedDigest?: string;
};

/** 1 回の `redeploySites` で受け付けるサイトの上限。デプロイ専用の Worker が 1 回の起動で同期で焼く件数(焼き直しの 1 回の件数 REBAKE_BATCH と同じ。7o K10) */
export const STATIC_BATCH_MAX = 5;

/**
 * まとめた出し直しの依頼(7o K10)。各要素は `StaticDeployRequestSchema` から protocol と force を除いた形(まとめた依頼の側に force を 1 つだけ持つ)か、
 * 削除の要素(`remove: true`。config などは持たない。焼かずに削除として受け付ける)。
 * flush = 受け付けた後の配置の急ぎ方: "soon" は短い待ちで配置、"later" は保険の遅い alarm(control は 5 件ずつ送り、最後の 1 回だけ "soon")。
 * 配置は待たずに返す
 */
const { protocol: _protocol, force: _force, ...StaticSiteDeployFields } = StaticDeployRequestSchema.shape;
const StaticBatchSiteSchema = z.union([
  z.strictObject(StaticSiteDeployFields),
  z.strictObject({ siteId: SiteId, generation: GenerationSchema, remove: z.literal(true) }),
]);
export const StaticBatchDeployRequestSchema = z.strictObject({
  protocol: z.literal(1),
  sites: z.array(StaticBatchSiteSchema).min(1).max(STATIC_BATCH_MAX),
  /** true なら前回と同じ manifest でも API を呼ぶ(管理画面の「配信ファイルを作り直す」) */
  force: z.boolean().optional(),
  flush: z.enum(["soon", "later"]),
});
export type StaticBatchDeployRequest = z.infer<typeof StaticBatchDeployRequestSchema>;

/**
 * `redeploySites` の応答(7o K10)。要素は依頼の順。受け付けなかった要素(古い世代・形が不正)も accepted は「受け付け済みのその Site の世代」
 * (Site が分からなければ null)。error は形の不正(config / settings の検証に失敗・Site ID の食い違い)のときだけ。
 * 依頼全体の形が不正なら state "rejected"(sites は空)
 */
export type StaticBatchDeployResult =
  | { state: "accepted"; sites: Array<{ siteId: string; accepted: StaticGeneration | null; error?: "invalid_payload" }> }
  | { state: "rejected"; sites: []; error: "invalid_request" };

/**
 * `instanceStatus()` の応答(7o K9)。デプロイ専用の Worker が持つ全サイトの状態を 1 回で返す。
 * - sites = index の全件。**削除の墓標を含む**(removed = true。墓標は gc されないので、削除済みのサイトも残る)
 * - accepted = 受け付け済みの世代、deployed = 配り終えた世代(まだ一度も配っていなければ null)。
 *   **deployed が accepted と違えば(null を含む)、受け付けた世代はまだ配り終えていない**
 * - acceptedDigest / deployedDigest = `StaticDeployResult` と同じ(7o K23。digest の対象は boot payload)。
 *   digest の無い古い index の項目は保存済みの入力から補うので、acceptedDigest は削除でない項目に必ず入る。
 *   deployedDigest が無いのは、配った世代が今の受け付けより古いときだけ
 * - lastDeployedAt = Cloudflare の API でのデプロイが最後に成功した時刻(ISO 8601)。中身が同じで API を呼ばなかった flush では動かさない。無ければ null
 * - failures / lastError = 配置の失敗の連続回数と最後のエラー
 */
export type StaticInstanceStatus = {
  sites: Array<{
    siteId: string;
    accepted: StaticGeneration;
    deployed: StaticGeneration | null;
    removed: boolean;
    acceptedDigest?: string;
    deployedDigest?: string;
  }>;
  failures: number;
  lastError: string | null;
  lastDeployedAt: string | null;
};

/**
 * 配る入力の digest(7o K23)。同じ世代番号の中身が違うこと(D1 を戻して seq が同じ値に戻った)を見分ける。
 * 対象は bake が作る boot payload(`bootPayload`)と同じもの: bake と同じく parse した config / settings から作るので、
 * bootstrap に関わらない設定(allowedOrigins・hosts・retentionDays など)の変更では変わらない。
 * キーを辞書順に並べた JSON の SHA-256(小文字 hex)。parse できない入力は例外にする(中身の無い digest を作らない)。
 * 依頼の記録・DO の index・履歴・control の判定が同じ値を作るための共通の関数で、runtime は import しない
 */
export async function staticInputDigest(input: { config: unknown; settings: unknown; apiBase: string | null }): Promise<string> {
  const config = parseCompiledConfig(input.config);
  const settings = parseSiteSettings(input.settings);
  if (!config) throw new Error("staticInputDigest: invalid compiled config");
  if (!settings) throw new Error("staticInputDigest: invalid site settings");
  const bytes = new TextEncoder().encode(canonicalJson(bootPayload(config, settings, input.apiBase)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** キーを辞書順に並べた JSON(再帰)。JSON.stringify と同じく undefined の値は落とす。キーの順だけが違う入力を同じ文字列にする */
function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
    const o = val as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  });
}

/** control の `DEPLOYER` binding(RPC)の形。デプロイ専用の Worker の `Deployer` 入口がこれを実装する */
export interface StaticDeployer {
  redeploySite(req: StaticDeployRequest): Promise<StaticDeployResult>;
  removeSite(req: StaticRemoveRequest): Promise<StaticDeployResult>;
  siteStatus(siteId: string): Promise<StaticSiteStatus>;
  /** 5 サイトまでのまとめた出し直し・削除の受け付け(配置は待たない。7o K10) */
  redeploySites(req: StaticBatchDeployRequest): Promise<StaticBatchDeployResult>;
  /** デプロイ専用の Worker が持つ全サイトの状態と配置の失敗の記録(読み取りだけ。7o K9) */
  instanceStatus(): Promise<StaticInstanceStatus>;
}
