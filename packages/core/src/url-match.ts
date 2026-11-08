/**
 * 対象 URL(urlMatch)の正規化・検査・正規の形(B69)。含める行 / 除く行 = ページの一致 + パラメータの AND。
 * 照合そのもの(matchTargetUrl)は zod を使わない page.ts にある(runtime が import するため)。ここは control・compile・管理画面用。
 * 保存の形・配る形の schema(UrlMatchInputSchema・CompiledUrlMatchSchema)は schema.ts にある(import を url-match → schema の一方向にするため)
 */
import { compileRegex } from "./regex-compile";
import { normalizePageMatch, pageMatchIssue, type PageMatchInput } from "./page-normalize";
import type { UrlMatch, UrlRow } from "./page";
import { LIMITS } from "./schema";
import type { Path } from "./targeting";

/** 保存の形。行の page は PageMatchInput(命令列を持たない) */
export type UrlMatchInput = UrlMatch<PageMatchInput>;

/** 正規化(保存の前): 各行の page を normalizePageMatch に通し、空の exclude・params を省く。パラメータと行の順は変えない */
export function normalizeUrlMatch(m: UrlMatchInput): UrlMatchInput {
  const rows = (rs: UrlRow<PageMatchInput>[]) => rs.map((r) => ({ page: normalizePageMatch(r.page), ...(r.params?.length ? { params: r.params } : {}) }));
  return { include: rows(m.include), ...(m.exclude?.length ? { exclude: rows(m.exclude) } : {}) };
}

/**
 * 保存の検査(正規化の後に呼ぶ)。各行の pageMatchIssue(最初の 1 つ)と、全行の正規表現の命令数の合計が上限を超えるか。
 * 今の保存の検査は行ごとで、サイト全体の上限は compile のときだけ効くため、対象 URL の分だけ早く断る。問題が無ければ null
 */
export function urlMatchIssue(m: UrlMatchInput): { code: string; message: string; path: Path; hint?: string } | null {
  let total = 0;
  for (const key of ["include", "exclude"] as const) {
    for (const [i, r] of (m[key] ?? []).entries()) {
      const issue = pageMatchIssue(r.page);
      if (issue) return { code: issue.code, message: issue.message, path: [key, i, "page", "value"], ...(issue.example !== undefined ? { hint: `書き換えの例: ${issue.example}` } : {}) };
      const c = r.page.op === "regex" ? compileRegex(r.page.value) : null;
      if (c?.ok) total += c.instructions;
    }
  }
  return total > LIMITS.urlInstructionsMax
    ? { code: "url_match_too_large", message: `対象 URL の正規表現の命令の数の合計 ${total} が上限 ${LIMITS.urlInstructionsMax} を超えています`, path: [], hint: "行を減らすか、正規表現を「で始まる」「を含む」などに置き換えてください" }
    : null;
}

/** キーの順を揃えた JSON(オブジェクトのキーを辞書順に並べる) */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const bySt = (a: unknown, b: unknown): number => (stable(a) < stable(b) ? -1 : 1);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
/** 行の並びの形(行 = { page, params? }。page は何でもよい。中身の検査は schema の仕事) */
const isRows = (v: unknown): v is UrlRow<unknown>[] =>
  Array.isArray(v) && v.every((r) => isObj(r) && onlyKeys(r, ["page", "params"]) && isObj(r.page) && (r.params === undefined || (Array.isArray(r.params) && r.params.every(isObj))));

const KNOWN_PARTS: unknown[] = ["url", "host", "path"];
const KNOWN_OPS: unknown[] = ["equals", "contains", "startsWith", "endsWith", "regex"];
/** 比べるための page。保存の形(part・op・value だけ、値は文字列)なら保存のときと同じ normalizePageMatch に通す(part の省略と "url" を同じにする)。
 *  形が合わない page はそのまま(比べる側では例外を投げない) */
const pageKey = (p: unknown): unknown =>
  isObj(p) && onlyKeys(p, ["part", "op", "value"]) && typeof p.value === "string" && KNOWN_OPS.includes(p.op) && (p.part === undefined || KNOWN_PARTS.includes(p.part))
    ? normalizePageMatch(p as PageMatchInput)
    : p;

/**
 * 正規の形(比べるとき。重なりの警告・届いた定義の比較・管理画面の変更の判定用)。各行の page を保存のときと同じに正規化し、
 * 含める・除くの行と各行の params を JSON の文字列の順に並べ、exclude・params が無いのと空を同じにする
 * (行どうし・パラメータどうしは OR / AND なので順は意味を変えない)。形が合わなければ JSON.stringify(m)(undefined なども文字列にする)。
 * 届いた定義の definition_hash はこの関数を使わない(hash は変えない)
 */
export function canonicalUrlMatch(m: unknown): string {
  if (!isObj(m) || !onlyKeys(m, ["include", "exclude"]) || !isRows(m.include) || !(m.exclude === undefined || isRows(m.exclude))) return String(JSON.stringify(m));
  const rows = (rs: UrlRow<unknown>[]) => rs.map((r) => ({ page: pageKey(r.page), ...(r.params?.length ? { params: [...r.params].sort(bySt) } : {}) })).sort(bySt);
  return stable({ include: rows(m.include), ...(m.exclude?.length ? { exclude: rows(m.exclude) } : {}) });
}

/** 版 2 までの古い形か(一番外側に op・value・part のどれかがあり、include が無い)。422 で新しい形を案内する・読み替えるときの判定 */
export function isOldUrlMatch(raw: unknown): boolean {
  if (!isObj(raw) || "include" in raw) return false;
  return ["op", "value", "part"].some((k) => k in raw);
}
