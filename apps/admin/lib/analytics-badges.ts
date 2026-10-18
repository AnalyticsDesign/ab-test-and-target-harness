import type { Variant } from "./types";

/**
 * B77(設計書 Q19〜Q22): 外部計測のカードの見出しの印と、「出力するキー n / 20」の数。
 * 件数 = 名前の指定 1 + このカードの追加の値のキー数。上書き = 本来出力される値を置き換えたもの
 * (名前の指定と、エクスペリエンスと同じキーの追加の値)。新しいキーの追加は上書きに数えない。
 * キーが空の行は入力中なので数えない(datalayer-preview と同じ)
 */
const keysOf = (extra: Record<string, string>): string[] => Object.keys(extra).filter((k) => k !== "");
type VariantLike = Pick<Variant, "id" | "analytics">;
const extraOf = (v: VariantLike): Record<string, string> => v.analytics?.extra ?? {};

export function variantAnalyticsBadge(variantName: string, variantExtra: Record<string, string>, experimentExtra: Record<string, string>): { count: number; overridden: boolean } {
  const own = keysOf(variantExtra);
  const exp = keysOf(experimentExtra);
  return { count: (variantName ? 1 : 0) + own.length, overridden: variantName !== "" || own.some((k) => exp.includes(k)) };
}

/**
 * エクスペリエンスの見出しの件数と「上書き」の印。上書き = エクスペリエンス名の指定(本来出力される ID を置き換える。モックと設計書 Q19 / Q20)。
 * エクスペリエンスの追加の値は置き換える元が無いので上書きに数えない
 */
export function experimentAnalyticsBadge(experimentName: string, experimentExtra: Record<string, string>): { count: number; overridden: boolean } {
  return { count: (experimentName ? 1 : 0) + keysOf(experimentExtra).length, overridden: experimentName !== "" };
}

/** 1 つのパターンで出力する追加の値のキー数(エクスペリエンスとパターンを合わせ、同じキーは 1 と数える。上限 20 と比べる) */
export function outputKeyCount(experimentExtra: Record<string, string>, variantExtra: Record<string, string>): number {
  return new Set([...keysOf(experimentExtra), ...keysOf(variantExtra)]).size;
}

/** エクスペリエンス側の「出力するキー 最大 n / 20(パターンの分を含む)」の n */
export function experimentOutputKeyMax(experimentExtra: Record<string, string>, variants: VariantLike[]): number {
  return Math.max(keysOf(experimentExtra).length, ...variants.map((v) => outputKeyCount(experimentExtra, extraOf(v))));
}

/** エクスペリエンスの追加の値のキーごとに、同じキーを持って上書きしているパターンの ID(「上書き n 件」の印とツールチップ) */
export function overrideCountByKey(experimentExtra: Record<string, string>, variants: VariantLike[]): Record<string, string[]> {
  return Object.fromEntries(keysOf(experimentExtra).map((k) => [k, variants.filter((v) => keysOf(extraOf(v)).includes(k)).map((v) => v.id)]));
}

/** 外部計測のカードを最初に開いて出すか(設定 = 名前の指定、または追加の値が 1 つ以上。設計書 Q30b) */
export function analyticsCardOpenInitially(name: string, extra: Record<string, string>): boolean {
  return name !== "" || keysOf(extra).length > 0;
}
