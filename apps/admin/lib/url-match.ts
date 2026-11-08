/**
 * 対象 URL(urlMatch)の入力の値と表示(B69、spec §2.1・§7.2・§7.4)。保存の形は control の API と同じ
 * `{ include: 行[1..10], exclude?: 行[0..10] }`、行 = `{ page, params? }`(行どうしは OR、行の中の page と params は AND)。
 * 送る値の最終的な検査は control が行う(ここは入力漏れを保存の前に知らせ、文にするだけ)。
 * 比べるときは core の canonicalUrlMatch(行・パラメータの順と、空の exclude・params を問わない)
 */
import { canonicalUrlMatch, isOldUrlMatch, LIMITS, type ParamMatch } from "@wtt/core";
import { DEFAULT_PAGE_MATCH, describePageMatch, PAGE_OP_OPTIONS, type PageMatchValue } from "./page-match";
import { checkRegex } from "./regex-assist";

export type { ParamMatch };
/** 画面の 1 行(op は PageMatchValue のまま文字列。保存できない組み合わせも「(使えません)」で見せるため) */
export type UrlRowValue = { page: PageMatchValue; params?: ParamMatch[] };
export type UrlMatchValue = { include: UrlRowValue[]; exclude?: UrlRowValue[] };
export type UrlRowKind = "include" | "exclude";

/** 新しく作るときの既定(含める 1 行、パスで始まる・空) */
export const DEFAULT_URL_MATCH: UrlMatchValue = { include: [{ page: DEFAULT_PAGE_MATCH }] };

export const URL_ROWS_MAX: Record<UrlRowKind, number> = { include: LIMITS.urlIncludeMax, exclude: LIMITS.urlExcludeMax };
export const URL_PARAMS_MAX = LIMITS.urlParamsMax;
export const URL_ROW_KIND_JA: Record<UrlRowKind, string> = { include: "含める", exclude: "除く" };

/** パラメータの一致の仕方(画面の選択肢。先頭が既定) */
export const PARAM_OP_OPTIONS: Array<{ op: ParamMatch["op"]; label: string }> = [
  { op: "equals", label: "が次に一致" },
  { op: "contains", label: "が次を含む" },
  { op: "exists", label: "がある(値は問わない)" },
];

/** 一致の仕方を変えたときのパラメータ(exists は value を持たない。control の形は厳密なので、送る形のまま持つ) */
export function withParamOp(p: ParamMatch, op: ParamMatch["op"]): ParamMatch {
  if (op === "exists") return { name: p.name, op };
  return { name: p.name, op, value: "value" in p ? p.value : "" };
}

/** 比べるときの文字列(行・パラメータの順と、空の exclude・params を問わない) */
export const urlMatchKey = (m: UrlMatchValue): string => canonicalUrlMatch(m);

const paramText = (p: ParamMatch): string =>
  p.op === "exists" ? `パラメータ ${p.name} がある` : `パラメータ ${p.name} が「${p.value}」${p.op === "equals" ? "に一致" : "を含む"}`;
const rowText = (r: UrlRowValue): string => [describePageMatch(r.page), ...(r.params ?? []).map(paramText)].join(" かつ ");

/** 含める・除くの各行の文(例: 「パス が「/lp/」で始まる かつ パラメータ utm_source が「news」に一致」) */
export function describeUrlMatch(m: UrlMatchValue): { include: string[]; exclude: string[] } {
  return { include: m.include.map(rowText), exclude: (m.exclude ?? []).map(rowText) };
}

/** 1 文の要約(変更履歴の値): 「A または B(ただし C を除く)」 */
export function urlMatchSentence(m: UrlMatchValue): string {
  const d = describeUrlMatch(m);
  return `${d.include.join(" または ")}${d.exclude.length ? `(ただし ${d.exclude.join(" または ")} を除く)` : ""}`;
}

// ---- 保存値の形の確かめ(一覧・変更履歴は古い形・壊れた値でも例外を出さない) ----

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** describePageMatch に渡せる形(part は知っている値か省略・op と value は文字列) */
const isPage = (v: unknown): v is PageMatchValue =>
  isObj(v) && typeof v.op === "string" && typeof v.value === "string" && (v.part === undefined || (typeof v.part === "string" && Object.hasOwn(PAGE_OP_OPTIONS, v.part)));
const isParam = (v: unknown): v is ParamMatch =>
  isObj(v) && typeof v.name === "string" && (v.op === "exists" || ((v.op === "equals" || v.op === "contains") && typeof v.value === "string"));
const isRows = (v: unknown): v is UrlRowValue[] =>
  Array.isArray(v) && v.every((r) => isObj(r) && isPage(r.page) && (r.params === undefined || (Array.isArray(r.params) && r.params.every(isParam))));
/** 行の形の対象 URL か(含めるが 1 行以上) */
export const isUrlMatchValue = (v: unknown): v is UrlMatchValue =>
  isObj(v) && isRows(v.include) && v.include.length > 0 && (v.exclude === undefined || isRows(v.exclude));

/**
 * エクスペリエンスの一覧の対象 URL の列(spec §7.4): 含めるの 1 行目 +「ほか N 件」+「・除く M 件」。
 * 行の形に変わる前の値(古い形)は describePageMatch の文、どちらでもなければ JSON
 */
export function urlMatchListText(m: unknown): string {
  if (isUrlMatchValue(m)) {
    const rest = m.include.length - 1;
    const out = m.exclude?.length ?? 0;
    return `${rowText(m.include[0]!)}${rest > 0 ? ` ほか ${rest} 件` : ""}${out > 0 ? `・除く ${out} 件` : ""}`;
  }
  if (isOldUrlMatch(m) && isPage(m)) return describePageMatch(m);
  return JSON.stringify(m) ?? String(m);
}

/** 変更履歴の前後の値: 行の形は 1 文の要約、それ以外(古い形・壊れた値)は JSON */
export function urlMatchAuditText(v: unknown): string | null {
  if (isUrlMatchValue(v)) return urlMatchSentence(v);
  return JSON.stringify(v) ?? null;
}

// ---- 保存の前の確認 ----

const empty = (s: string) => s.trim() === "";

/** 1 行の入力漏れ(ページの値の空・正規表現・パラメータの名前の空・「次を含む」の値の空)。問題が無ければ null */
export function urlRowProblem(r: UrlRowValue): string | null {
  if (empty(r.page.value)) return "値を入力してください";
  if (r.page.op === "regex" && checkRegex(r.page.value) !== null) return "正規表現を直してください";
  return paramsProblem(r.params ?? []);
}

/** パラメータの行の入力漏れ(行の下に出す。ページの値の空は欄の placeholder と保存の前の確認に任せる) */
export function paramsProblem(params: ParamMatch[]): string | null {
  for (const p of params) {
    if (empty(p.name)) return "パラメータの名前を入力してください";
    if (p.op === "contains" && p.value === "") return `パラメータ ${p.name} の値を入力してください`;
  }
  return null;
}

/** 保存の前の確認(最初の 1 つを、行の位置を添えて返す)。問題が無ければ null */
export function urlMatchProblem(m: UrlMatchValue): string | null {
  for (const kind of ["include", "exclude"] as const) {
    for (const [i, r] of (m[kind] ?? []).entries()) {
      const p = urlRowProblem(r);
      if (p) return `対象 URL(${URL_ROW_KIND_JA[kind]} ${i + 1} 行目): ${p}`;
    }
  }
  return null;
}
