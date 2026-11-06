import { ApiClientError, describeError } from "./client";
import type { AssetProblem, PublishResult, Status } from "./types";

/**
 * B68(spec §22.5): 公開できない画像(見つからない画像・別のサイトの画像)の一覧。
 * 公開の確認の窓(publish-preview の assetProblems)・公開の失敗の応答・状態を変えるボタンの開始・再開の 409 が同じ形で出す。
 * 名前は画面が既に持っているもの(publish-preview のエクスペリエンスの一覧・開いているエクスペリエンス)から引き、無ければ ID(読みは足さない)
 */

export const ASSET_PROBLEMS_TITLE = "公開できない画像があります";

const REASON_TEXT: Record<AssetProblem["reason"], string> = { missing: "見つからない画像", other_site: "別のサイトの画像" };

export type AssetProblemRow = { key: string; reason: string; url: string; shortUrl: string; label: string; href: string; experimentId: string; variantId: string };

/** 長い URL は最後の区切りから後ろだけにする(全文は title で見せる) */
export function shortAssetUrl(url: string, max = 40): string {
  if (url.length <= max) return url;
  const i = url.lastIndexOf("/");
  const tail = i >= 0 ? url.slice(i + 1) : url;
  return `…/${tail.length > max ? tail.slice(-max) : tail}`;
}

export function assetProblemRows(
  problems: readonly AssetProblem[],
  ctx: { wid: string; siteId: string; experimentName?: (id: string) => string | undefined; variantName?: (experimentId: string, variantId: string) => string | undefined },
): AssetProblemRow[] {
  return problems.map((p, i) => ({
    key: `${p.experimentId}/${p.variantId}/${p.changeId}/${i}`,
    reason: REASON_TEXT[p.reason],
    url: p.url,
    shortUrl: shortAssetUrl(p.url),
    label: `${ctx.experimentName?.(p.experimentId) ?? p.experimentId} / ${ctx.variantName?.(p.experimentId, p.variantId) ?? p.variantId}`,
    href: `/w/${ctx.wid}/sites/${ctx.siteId}/experiments/${encodeURIComponent(p.experimentId)}?tab=variants&variant=${encodeURIComponent(p.variantId)}`,
    experimentId: p.experimentId,
    variantId: p.variantId,
  }));
}

/**
 * 今開いているエクスペリエンスの行なら、遷移せずに画面の中で開くタブとパターン(エクスペリエンスの画面は tab・variant を URL から読み直す)。
 * ほかのエクスペリエンスの行は null(今のまま AppLink で移る)
 */
export function inPlaceTarget(row: Pick<AssetProblemRow, "experimentId" | "variantId">, currentExperimentId: string | undefined): { tab: "variants"; variant: string } | null {
  return currentExperimentId !== undefined && row.experimentId === currentExperimentId ? { tab: "variants", variant: row.variantId } : null;
}

const isProblem = (v: unknown): v is AssetProblem => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.url === "string" &&
    (o.reason === "missing" || o.reason === "other_site") &&
    typeof o.experimentId === "string" &&
    typeof o.variantId === "string" &&
    typeof o.changeId === "string"
  );
};

/** 応答の assetProblems を正しい形の項目だけにする(古い control・形の違う値は空) */
export function parseAssetProblems(v: unknown): AssetProblem[] {
  return Array.isArray(v) ? v.filter(isProblem) : [];
}

/** 公開の失敗の応答に載った assetProblems(成功・ほかの失敗は空) */
export function publishFailureProblems(r: PublishResult | null | undefined): AssetProblem[] {
  if (!r || r.ok) return [];
  return parseAssetProblems(r.assetProblems);
}

const GUARD_CODES = new Set(["asset_missing", "asset_other_site"]);

/**
 * 状態を変える口の開始・再開(to = running)が CAS の前に断った 409 なら、状態が変わっていない旨(control の message・hint)と一覧を返す。
 * 一時停止・終了は control が画像を確かめないので、この分岐に入れない(null)
 */
export function assetGuardRejection(e: unknown, to: Status): { text: string; problems: AssetProblem[] } | null {
  if (to !== "running") return null;
  if (!(e instanceof ApiClientError) || e.status !== 409 || !GUARD_CODES.has(e.code)) return null;
  return { text: describeError(e), problems: parseAssetProblems(e.extra.assetProblems) };
}
