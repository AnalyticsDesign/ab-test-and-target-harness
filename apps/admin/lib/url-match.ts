/**
 * 対象 URL(urlMatch)の入力の値と表示(B69、spec §2.1・§7.2・§7.4)。保存の形は control の API と同じ
 * `{ include: 行[1..10], exclude?: 行[0..10] }`、行 = `{ page, and?, params? }`(行どうしは OR、行の中の page・and の各要素・params は AND。
 * and は B69 追補: page と同じ形のページの一致の配列)。送る値の最終的な検査は control が行う(ここは入力漏れを保存の前に知らせ、文にするだけ)。
 * 比べるときは core の canonicalUrlMatch(行・パラメータ・and の順と、空の exclude・and・params を問わない)
 */
import { canonicalUrlMatch, isOldUrlMatch, LIMITS, type ParamMatch } from "@wtt/core";
import { DEFAULT_PAGE_MATCH, describePageMatch, PAGE_OP_OPTIONS, PAGE_PART_LABELS, partOf, type PageMatchValue, type PagePart } from "./page-match";
import { checkRegex } from "./regex-assist";

export type { ParamMatch };
/** 画面の 1 行(op は PageMatchValue のまま文字列。保存できない組み合わせも「(使えません)」で見せるため)。並びは page → and → params に固定(追補 §7) */
export type UrlRowValue = { page: PageMatchValue; and?: PageMatchValue[]; params?: ParamMatch[] };
export type UrlMatchValue = { include: UrlRowValue[]; exclude?: UrlRowValue[] };
export type UrlRowKind = "include" | "exclude";

/** 新しく作るときの既定(含める 1 行、パスで始まる・空) */
export const DEFAULT_URL_MATCH: UrlMatchValue = { include: [{ page: DEFAULT_PAGE_MATCH }] };

export const URL_ROWS_MAX: Record<UrlRowKind, number> = { include: LIMITS.urlIncludeMax, exclude: LIMITS.urlExcludeMax };
export const URL_PARAMS_MAX = LIMITS.urlParamsMax;
export const URL_AND_MAX = LIMITS.urlAndMax;
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
const rowText = (r: UrlRowValue): string => [describePageMatch(r.page), ...(r.and ?? []).map(describePageMatch), ...(r.params ?? []).map(paramText)].join(" かつ ");

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
  Array.isArray(v) &&
  v.every(
    (r) =>
      isObj(r) &&
      isPage(r.page) &&
      (r.and === undefined || (Array.isArray(r.and) && r.and.every(isPage))) &&
      (r.params === undefined || (Array.isArray(r.params) && r.params.every(isParam))),
  );
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

/** 最初の条件(page)の値が空のときの案内(× で値を空にした行・足したばかりの行。行の下と保存の前の確認に出す) */
export const EMPTY_FIRST_CONDITION = "ページの条件を入れてください(すべてのページなら『パスが / で始まる』)";

/**
 * 1 行の入力漏れ(最初の条件の値の空・正規表現・and の各条件の値の空と正規表現・パラメータの名前の空・「次を含む」の値の空)。問題が無ければ null。
 * regex: false は正規表現の確かめを省く(画面の行の下に出すとき。正規表現の誤りは欄の下の案内(RegexAssist)が詳しく出す)
 */
export function urlRowProblem(r: UrlRowValue, { regex = true }: { regex?: boolean } = {}): string | null {
  if (empty(r.page.value)) return EMPTY_FIRST_CONDITION;
  if (regex && r.page.op === "regex" && checkRegex(r.page.value) !== null) return "正規表現を直してください";
  for (const c of r.and ?? []) {
    if (empty(c.value)) return `${PAGE_PART_LABELS[partOf(c)]}の条件の値を入力してください`;
    if (regex && c.op === "regex" && checkRegex(c.value) !== null) return "正規表現を直してください";
  }
  return paramsProblem(r.params ?? []);
}

/** パラメータの行の入力漏れ */
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

// ---- 行の中の「かつ」の条件の編集(B69 追補 §7。画面は page → and → params の順に並べ、並べ替えはしない) ----

/** 条件の種類(ページの一致の部分 + パラメータ) */
export type ConditionKind = PagePart | "param";
/** 条件の並び(and = ページの条件、params = パラメータの条件) */
export type ConditionList = "and" | "params";
const PAGE_KINDS = ["path", "host", "url"] as const;

/** 行を組み立て直す(空の and・params は省く。保存される JSON の表示も保存の形と同じにするため。片方を変えてももう片方は落とさない) */
export function withRowParts(r: UrlRowValue, parts: { and?: PageMatchValue[]; params?: ParamMatch[] }): UrlRowValue {
  const and = parts.and ?? r.and ?? [];
  const params = parts.params ?? r.params ?? [];
  return { page: r.page, ...(and.length ? { and } : {}), ...(params.length ? { params } : {}) };
}

/** 種類の既定の条件(その種類の最初の一致の仕方・空の値) */
const newPageCondition = (part: PagePart): PageMatchValue => ({ part, op: PAGE_OP_OPTIONS[part][0]!.op, value: "" });
const newParam = (): ParamMatch => ({ name: "", op: "equals", value: "" });

/** 「+ 条件(かつ)」を出すか(and とパラメータのどちらかに空きがある) */
export const canAddCondition = (r: UrlRowValue): boolean => (r.and?.length ?? 0) < URL_AND_MAX || (r.params?.length ?? 0) < URL_PARAMS_MAX;

/**
 * 「+ 条件(かつ)」: and に空きがあれば、行の先頭がホストならパス・それ以外ならホストの条件を足す(ホストとパスの組み合わせが主な使い方)。
 * and が上限ならパラメータの条件を足す。どちらも上限なら行をそのまま返す
 */
export function addCondition(r: UrlRowValue): UrlRowValue {
  const and = r.and ?? [];
  const params = r.params ?? [];
  if (and.length < URL_AND_MAX) return withRowParts(r, { and: [...and, newPageCondition(partOf(r.page) === "host" ? "path" : "host")] });
  if (params.length < URL_PARAMS_MAX) return withRowParts(r, { params: [...params, newParam()] });
  return r;
}

/** 条件を 1 つ消す(and かパラメータ。最初の条件は removeFirstCondition) */
export function removeCondition(r: UrlRowValue, list: ConditionList, i: number): UrlRowValue {
  return list === "and" ? withRowParts(r, { and: (r.and ?? []).filter((_, j) => j !== i) }) : withRowParts(r, { params: (r.params ?? []).filter((_, j) => j !== i) });
}

/**
 * 最初の条件(page)の ×: and があれば先頭を page に繰り上げる(残りは順のまま。params はそのまま)。
 * and が無ければ値だけを空にする(種類・一致の仕方・params・行は残す。空のままでは保存できない)
 */
export function removeFirstCondition(r: UrlRowValue): UrlRowValue {
  const [first, ...rest] = r.and ?? [];
  if (first) return withRowParts({ ...r, page: first }, { and: rest });
  return { ...r, page: { ...r.page, value: "" } };
}

/**
 * 条件の種類を替える: 同じ並びの中(パス ↔ ホスト ↔ URL)はその場で、並びをまたぐとき(ページの条件 ↔ パラメータ)は移る先の最後に足す。
 * どれもその種類の既定の一致の仕方・空の値にする。移る先が上限なら行をそのまま返す(プルダウンでは選べない。conditionKindOptions)
 */
export function switchConditionKind(r: UrlRowValue, list: ConditionList, i: number, kind: ConditionKind): UrlRowValue {
  const and = r.and ?? [];
  const params = r.params ?? [];
  if (list === "and") {
    if (and[i] && kind === partOf(and[i])) return r; // 同じ種類の選び直しは変えない(値を消さない)
    if (kind !== "param") return withRowParts(r, { and: and.map((c, j) => (j === i ? newPageCondition(kind) : c)) });
    if (params.length >= URL_PARAMS_MAX) return r;
    return withRowParts(r, { and: and.filter((_, j) => j !== i), params: [...params, newParam()] });
  }
  if (kind === "param") return r;
  if (and.length >= URL_AND_MAX) return r;
  return withRowParts(r, { and: [...and, newPageCondition(kind)], params: params.filter((_, j) => j !== i) });
}

/** 条件の行の先頭のプルダウン「条件の種類」の選択肢(並びをまたぐ切り替えは、移る先が上限なら選べない) */
export function conditionKindOptions(r: UrlRowValue, list: ConditionList): Array<{ value: ConditionKind; label: string; disabled: boolean }> {
  const andFull = (r.and?.length ?? 0) >= URL_AND_MAX;
  const paramsFull = (r.params?.length ?? 0) >= URL_PARAMS_MAX;
  return [
    ...PAGE_KINDS.map((k) => ({ value: k, label: PAGE_PART_LABELS[k], disabled: list === "params" && andFull })),
    { value: "param" as const, label: "パラメータ", disabled: list === "and" && paramsFull },
  ];
}
