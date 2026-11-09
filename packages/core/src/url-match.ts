/**
 * 対象 URL(urlMatch)の正規化・検査・正規の形(B69)。含める行 / 除く行 = ページの一致 + パラメータの AND。
 * 照合そのもの(matchTargetUrl)は zod を使わない page.ts にある(runtime が import するため)。ここは control・compile・管理画面用。
 * 保存の形・配る形の schema(UrlMatchInputSchema・CompiledUrlMatchSchema)は schema.ts にある(import を url-match → schema の一方向にするため)
 */
import { compileRegex, type RegexIssue } from "./regex-compile";
import { normalizePageMatch, pageMatchIssue, type PageMatchInput } from "./page-normalize";
import type { UrlMatch, UrlRow } from "./page";
import { LIMITS } from "./schema";
import type { Path } from "./targeting";

/** 保存の形。行の page は PageMatchInput(命令列を持たない) */
export type UrlMatchInput = UrlMatch<PageMatchInput>;

/**
 * 正規化(保存の前): 各行の page と and の各要素を normalizePageMatch に通し、空の exclude・and・params を省く。
 * 行・and・パラメータの順は変えない。行のキーは page → and → params の順にする
 */
export function normalizeUrlMatch(m: UrlMatchInput): UrlMatchInput {
  const rows = (rs: UrlRow<PageMatchInput>[]) =>
    rs.map((r) => ({ page: normalizePageMatch(r.page), ...(r.and?.length ? { and: r.and.map(normalizePageMatch) } : {}), ...(r.params?.length ? { params: r.params } : {}) }));
  return { include: rows(m.include), ...(m.exclude?.length ? { exclude: rows(m.exclude) } : {}) };
}

/**
 * 保存の検査の問題。正規表現の誤りは index / length(式の中の位置)と、書き換えの例があれば hint を持つ
 * (control は正規表現の 422 と同じ封筒にする)。url_match_too_large は path が [] で index / length を持たない
 */
export type UrlMatchIssue = { code: string; message: string; path: Path; hint?: string; index?: number; length?: number };

/**
 * URL 全体の正規表現を断るときの追記。and(1 行の「かつ」の条件)を持てるのは対象 URL の行だけなので、共通の pageMatchIssue
 * (目標・オーディエンスにも返る)には入れず、この保存の検査だけで足す
 */
const URL_REGEX_AND_GUIDE = "。ホストも絞る必要があるときは、パスの条件に置き換えたうえで、同じ行の「かつ」の条件(and)にホストの条件を足してください";

/** 1 つのページの一致の検査: 正規表現の誤りか、正規表現の命令数(正規表現でなければ 0)。pageMatchIssue と同じ判定を、コンパイル 1 回で */
function pageMatchCheck(p: PageMatchInput): RegexIssue | number {
  if (p.op !== "regex") return 0;
  if ((p.part ?? "url") === "url") return pageMatchIssue(p) ?? 0; // URL 全体の正規表現(コンパイルせずに断る)
  const c = compileRegex(p.value);
  return c.ok ? c.instructions : c.issue;
}

/**
 * 保存の検査(正規化の後に呼ぶ)。page と and の各要素を 1 回の走査で 1 回だけコンパイルし、最初の正規表現の誤りか、
 * 全行の正規表現の命令数の合計が上限を超えたこと(超えた時点で止め、残りはコンパイルしない)を返す。
 * サイト全体の上限は compile のときだけ効くため、対象 URL の分だけ早く断る。問題が無ければ null。
 * path は [key, 行, "page", "value"] か [key, 行, "and", j, "value"]
 */
export function urlMatchIssue(m: UrlMatchInput): UrlMatchIssue | null {
  let total = 0;
  for (const key of ["include", "exclude"] as const) {
    for (const [i, r] of (m[key] ?? []).entries()) {
      const items: Array<[PageMatchInput, Path]> = [[r.page, [key, i, "page", "value"]], ...(r.and ?? []).map((p, j): [PageMatchInput, Path] => [p, [key, i, "and", j, "value"]])];
      for (const [p, path] of items) {
        const c = pageMatchCheck(p);
        if (typeof c !== "number")
          return { code: c.code, message: c.code === "regex_not_allowed_on_url" ? `${c.message}${URL_REGEX_AND_GUIDE}` : c.message, path, ...(c.example !== undefined ? { hint: `書き換えの例: ${c.example}` } : {}), index: c.index, length: c.length };
        total += c;
        if (total > LIMITS.urlInstructionsMax)
          return {
            code: "url_match_too_large",
            message: `対象 URL の正規表現の命令の数の合計 ${total} が上限 ${LIMITS.urlInstructionsMax} を超えています`,
            path: [],
            hint: "行や、行の「かつ」の条件を減らすか、正規表現を「で始まる」「を含む」などに置き換えてください",
          };
      }
    }
  }
  return null;
}

/** キーの順を揃えた JSON(オブジェクトのキーを辞書順に並べる) */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const bySt = (a: unknown, b: unknown): number => (stable(a) < stable(b) ? -1 : 1);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const isObjArray = (v: unknown): boolean => Array.isArray(v) && v.every(isObj);
/** 行の並びの形(行 = { page, and?, params? }。page と and の要素は何でもよい。中身の検査は schema の仕事) */
const isRows = (v: unknown): v is UrlRow<unknown>[] =>
  Array.isArray(v) &&
  v.every((r) => isObj(r) && onlyKeys(r, ["page", "and", "params"]) && isObj(r.page) && (r.and === undefined || isObjArray(r.and)) && (r.params === undefined || isObjArray(r.params)));

const KNOWN_PARTS: unknown[] = ["url", "host", "path"];
const KNOWN_OPS: unknown[] = ["equals", "contains", "startsWith", "endsWith", "regex"];
/** 比べるための page。保存の形(part・op・value だけ、値は文字列)なら保存のときと同じ normalizePageMatch に通す(part の省略と "url" を同じにする)。
 *  形が合わない page はそのまま(比べる側では例外を投げない) */
const pageKey = (p: unknown): unknown =>
  isObj(p) && onlyKeys(p, ["part", "op", "value"]) && typeof p.value === "string" && KNOWN_OPS.includes(p.op) && (p.part === undefined || KNOWN_PARTS.includes(p.part))
    ? normalizePageMatch(p as PageMatchInput)
    : p;

/**
 * 正規の形(比べるとき。重なりの警告・届いた定義の比較・管理画面の変更の判定用)。各行の page と and の要素を保存のときと同じに正規化し、
 * 含める・除くの行と各行の and・params を JSON の文字列の順に並べ、exclude・and・params が無いのと空を同じにする
 * (行どうしは OR、and・パラメータどうしは AND なので順は意味を変えない)。page と and の要素の入れ替えは別の形と見る
 * (画面は並びを固定していて入れ替えは起きない。B69 追補 §2.4)。and の無い行の文字列は and を足す前と同じ。
 * 形が合わなければ JSON.stringify(m)(undefined なども文字列にする)。
 * 届いた定義の definition_hash はこの関数を使わない(hash は変えない)
 */
export function canonicalUrlMatch(m: unknown): string {
  if (!isObj(m) || !onlyKeys(m, ["include", "exclude"]) || !isRows(m.include) || !(m.exclude === undefined || isRows(m.exclude))) return String(JSON.stringify(m));
  const rows = (rs: UrlRow<unknown>[]) =>
    rs.map((r) => ({ page: pageKey(r.page), ...(r.and?.length ? { and: r.and.map(pageKey).sort(bySt) } : {}), ...(r.params?.length ? { params: [...r.params].sort(bySt) } : {}) })).sort(bySt);
  return stable({ include: rows(m.include), ...(m.exclude?.length ? { exclude: rows(m.exclude) } : {}) });
}

/** 版 2 までの古い形か(一番外側に op・value・part のどれかがあり、include が無い)。422 で新しい形を案内する・読み替えるときの判定 */
export function isOldUrlMatch(raw: unknown): boolean {
  if (!isObj(raw) || "include" in raw) return false;
  return ["op", "value", "part"].some((k) => k in raw);
}
