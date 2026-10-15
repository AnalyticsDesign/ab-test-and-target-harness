import { z } from "zod";
import { isExactOrigin, SITE_ID_RE } from "./settings";

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
 * deployedAt = `deployed` の世代をデプロイし終えた時刻(`deployed` が null なら null)
 */
export type StaticDeployResult = {
  state: "deployed" | "pending" | "rejected";
  accepted: StaticGeneration | null;
  deployed: StaticGeneration | null;
  deployedAt: string | null;
  error?: string;
};

/** 配った世代とデプロイし終えた時刻(UTC、ISO 8601) */
export type StaticDeployHistoryEntry = { generation: StaticGeneration; deployedAt: string };
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
 * D9 の届く定義の `delivered_from` は history と historyFrom から取る(plan「D9 への申し送り」)
 */
export type StaticSiteStatus = {
  accepted: StaticGeneration | null;
  deployed: StaticGeneration | null;
  deployedAt: string | null;
  history: StaticDeployHistoryEntry[];
  historyFrom: string | null;
  pending: boolean;
  lastError: string | null;
};

/** control の `DEPLOYER` binding(RPC)の形。デプロイ専用の Worker の `Deployer` 入口がこれを実装する */
export interface StaticDeployer {
  redeploySite(req: StaticDeployRequest): Promise<StaticDeployResult>;
  removeSite(req: StaticRemoveRequest): Promise<StaticDeployResult>;
  siteStatus(siteId: string): Promise<StaticSiteStatus>;
}
