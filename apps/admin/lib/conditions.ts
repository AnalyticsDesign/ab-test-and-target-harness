/**
 * 条件の種類・選択肢・要約・保存の前の確認(決定 49、設計書 §3・§12)。オーディエンスの作成画面とエクスペリエンスの配信条件で共通。
 * 表記は日本語(設計書 §2)。値の最終的な検査は control が行う(ここは入力漏れを保存の前に知らせるだけ)
 */
import type { Browser, Device, Os } from "@wtt/core";
import { checkRegex } from "./regex-assist";
import { PAGE_OP_OPTIONS, PAGE_PART_LABELS, partOf } from "./page-match";
import { audienceTreeFromDsl, hh, newId, type Cond, type CondType, type Group, type TreeNode, type Weekday } from "./targeting-tree";
import type { Audience, Goal } from "./types";

export const COND_META: Record<CondType, { label: string; cat: "page" | "visitor" | "audience"; glyph: string }> = {
  url: { label: "ページの URL", cat: "page", glyph: "⌁" },
  host: { label: "ページのホスト", cat: "page", glyph: "⌂" },
  path: { label: "ページのパス", cat: "page", glyph: "/" },
  query: { label: "クエリパラメータ", cat: "page", glyph: "?" },
  device: { label: "端末", cat: "page", glyph: "▭" },
  viewport: { label: "画面の幅", cat: "page", glyph: "↔" },
  browser: { label: "ブラウザ", cat: "page", glyph: "◎" },
  os: { label: "OS", cat: "page", glyph: "◇" },
  referrer: { label: "リファラー", cat: "page", glyph: "↩" },
  time: { label: "曜日・時間帯", cat: "page", glyph: "◷" },
  visited: { label: "閲覧したページ", cat: "visitor", glyph: "▤" },
  goal: { label: "目標・コンバージョン", cat: "visitor", glyph: "◉" },
  elapsed: { label: "初回の訪問からの経過", cat: "visitor", glyph: "↻" },
  audience: { label: "オーディエンス", cat: "audience", glyph: "◍" },
};
export const PAGE_TYPES: CondType[] = ["url", "host", "path", "query", "device", "viewport", "browser", "os", "referrer", "time"];
export const VISITOR_TYPES: CondType[] = ["visited", "goal", "elapsed"];

export type Option = { value: string; label: string };
const o = (value: string, label: string): Option => ({ value, label });
export const URL_OPS: Option[] = [o("contains", "を含む"), o("equals", "と完全一致"), o("startsWith", "で始まる"), o("notContains", "を含まない"), o("notEquals", "と一致しない")];
export const PATH_OPS: Option[] = [o("contains", "を含む"), o("equals", "と完全一致"), o("startsWith", "で始まる"), o("regex", "に一致(正規表現)"), o("notContains", "を含まない"), o("notEquals", "と一致しない"), o("notRegex", "に一致しない(正規表現)")];
export const HOST_OPS: Option[] = [o("equals", "と完全一致"), o("endsWith", "で終わる(サブドメインを含む)"), o("contains", "を含む"), o("regex", "に一致(正規表現)"), o("notEquals", "と一致しない"), o("notRegex", "に一致しない(正規表現)")];
export const QUERY_OPS: Option[] = [o("equals", "が次の値"), o("contains", "が次の値を含む"), o("notEquals", "が次の値ではない"), o("exists", "が存在する"), o("notExists", "が存在しない")];
export const REF_OPS: Option[] = [o("contains", "を含む"), o("equals", "と完全一致"), o("notContains", "を含まない"), o("isEmpty", "が空(直接の流入)"), o("notEmpty", "が空ではない")];
export const DEVICE_LABELS: Record<Device, string> = { mobile: "モバイル", tablet: "タブレット", desktop: "デスクトップ" };
export const BROWSER_LABELS: Record<Browser, string> = { chrome: "Chrome", safari: "Safari", edge: "Edge", firefox: "Firefox", samsung: "Samsung Internet", other: "その他" };
export const OS_LABELS: Record<Os, string> = { ios: "iOS", android: "Android", windows: "Windows", macos: "macOS", chromeos: "ChromeOS", linux: "Linux", other: "その他" };
export const DAY_LABELS: Array<[Weekday, string]> = [["mon", "月"], ["tue", "火"], ["wed", "水"], ["thu", "木"], ["fri", "金"], ["sat", "土"], ["sun", "日"]];
export const VALUE_LABELS: Record<"device" | "browser" | "os", Record<string, string>> = { device: DEVICE_LABELS, browser: BROWSER_LABELS, os: OS_LABELS };

/** 条件の種類のプルダウン(エクスペリエンスではオーディエンスを先頭に) */
export function typeOptions(allowAudience: boolean) {
  const item = (t: CondType) => ({ value: t, label: COND_META[t].label });
  return [
    ...(allowAudience ? [{ group: "オーディエンス", options: [item("audience")] }] : []),
    { group: "このページ(今回の表示)", options: PAGE_TYPES.map(item) },
    { group: "この訪問者(これまで)", options: VISITOR_TYPES.map(item) },
  ];
}

/** 種類を選んだときの初期値。目標とオーディエンスは先頭の候補(無ければ空 = 保存の前の確認で止める) */
export function defaultCond(type: CondType, ctx: { goal?: string; audience?: string } = {}, id: string = newId()): Cond {
  switch (type) {
    case "url":
      return { id, kind: "cond", type, op: "contains", value: "" };
    case "path":
      return { id, kind: "cond", type, op: "startsWith", value: "" };
    case "host":
      return { id, kind: "cond", type, op: "equals", value: "" };
    case "query":
      return { id, kind: "cond", type, name: "", op: "equals", value: "" };
    case "device":
      return { id, kind: "cond", type, neg: false, values: ["mobile"] };
    case "browser":
      return { id, kind: "cond", type, neg: false, values: ["safari"] };
    case "os":
      return { id, kind: "cond", type, neg: false, values: ["ios"] };
    case "viewport":
      return { id, kind: "cond", type, op: "lt", min: 768, max: 768 };
    case "referrer":
      return { id, kind: "cond", type, op: "contains", value: "" };
    case "time":
      return { id, kind: "cond", type, days: ["mon", "tue", "wed", "thu", "fri"], allDay: false, from: 9, to: 18 };
    case "visited":
      return { id, kind: "cond", type, neg: false, page: { part: "path", op: "startsWith", value: "" }, min: 1, within: null };
    case "goal":
      return { id, kind: "cond", type, neg: false, goal: ctx.goal ?? "", within: null };
    case "elapsed":
      return { id, kind: "cond", type, op: "gte", n: 24, unit: "hours" };
    case "audience":
      return { id, kind: "cond", type, neg: false, audience: ctx.audience ?? "" };
  }
}

export type Names = { goal: (id: string) => string; audience: (id: string) => string };
export function makeNames(goals: Goal[], audiences: Audience[]): Names {
  return { goal: (id) => goals.find((g) => g.id === id)?.name ?? id, audience: (id) => audiences.find((a) => a.id === id)?.name ?? id };
}

const q = (s: string) => `「${s}」`;
const label = (opts: Option[], v: string) => opts.find((x) => x.value === v)?.label ?? v;
const dayIndex = (d: Weekday) => DAY_LABELS.findIndex(([k]) => k === d);

export function dayText(days: Weekday[]): string {
  if (days.length === 7) return "毎日";
  const s = [...days].sort((a, b) => dayIndex(a) - dayIndex(b));
  const name = (d: Weekday) => DAY_LABELS[dayIndex(d)]?.[1] ?? d;
  const contiguous = s.length >= 3 && s.every((d, i) => i === 0 || dayIndex(d) === dayIndex(s[i - 1]!) + 1);
  return contiguous ? `${name(s[0]!)}〜${name(s[s.length - 1]!)}` : s.map(name).join("・") || "(曜日なし)";
}

export function condText(c: Cond, names: Names): string {
  switch (c.type) {
    case "url":
      return `URL が${q(c.value)}${label(URL_OPS, c.op)}`;
    case "path":
      return `パスが${q(c.value)}${label(PATH_OPS, c.op)}`;
    case "host":
      return `ホストが${q(c.value)}${label(HOST_OPS, c.op).replace("(サブドメインを含む)", "")}`;
    case "query":
      return `クエリ ${c.name} ${c.op === "exists" || c.op === "notExists" ? label(QUERY_OPS, c.op) : label(QUERY_OPS, c.op).replace("次の値", q(c.value))}`;
    case "device":
    case "browser":
    case "os": {
      const shown = c.values.map((v) => VALUE_LABELS[c.type][v] ?? v);
      return `${COND_META[c.type].label}が ${shown.join("・") || "(未選択)"}${c.neg ? " のいずれでもない" : shown.length > 1 ? " のいずれか" : ""}`;
    }
    case "viewport":
      return c.op === "gte" ? `画面の幅が ${c.min}px 以上` : c.op === "lt" ? `画面の幅が ${c.max}px 未満` : `画面の幅が ${c.min}〜${c.max}px`;
    case "referrer":
      return c.op === "isEmpty" || c.op === "notEmpty" ? `リファラー${label(REF_OPS, c.op)}` : `リファラーが${q(c.value)}${label(REF_OPS, c.op)}`;
    case "time":
      return c.allDay ? `${dayText(c.days)}(終日)` : `${dayText(c.days)} の ${hh(c.from)}〜${c.to <= c.from ? "翌 " : ""}${hh(c.to)}`;
    case "visited": {
      const part = partOf(c.page);
      const how = (PAGE_OP_OPTIONS[part].find((x) => x.op === c.page.op)?.label ?? c.page.op).replace("に一致(正規表現)", "に一致する");
      const page = `${PAGE_PART_LABELS[part]}が${q(c.page.value)}${how}ページ`;
      return c.neg ? `${page}を${c.within ? `過去 ${c.within} 日に` : ""}閲覧していない` : `${page}を${c.min > 1 ? ` ${c.min} 回以上` : ""}閲覧${c.within ? `(最後の閲覧が ${c.within} 日以内)` : ""}`;
    }
    case "goal":
      return `目標${q(names.goal(c.goal))}${c.neg ? `が未達成${c.within ? `(過去 ${c.within} 日)` : ""}` : `を達成済み${c.within ? `(最後の達成が ${c.within} 日以内)` : ""}`}`;
    case "elapsed":
      return `初回の訪問から ${c.n} ${c.unit === "hours" ? "時間" : "日"}${c.op === "gte" ? "以上" : "未満"}`;
    case "audience":
      return `オーディエンス${q(names.audience(c.audience))}${c.neg ? "に含まれない" : "に含まれる"}`;
  }
}

/** グループの要約(top = 一番外側。条件が無ければ「全員」) */
export function groupText(g: Group, names: Names, top = false): string {
  const parts = g.children.map((x) => (x.kind === "group" ? (x.children.length ? `(${groupText(x, names)})` : "") : condText(x, names))).filter(Boolean);
  if (parts.length === 0) return top ? "全員" : "(条件なし)";
  const body = parts.join(g.logic === "and" ? " かつ " : " または ");
  return g.exclude ? `次を除く[${body}]` : body;
}

/** 保存値の要約。画面で表せない・想定外の値でも例外を出さない(一覧・候補の表示を落とさない。plan ② P16) */
export function summarizeDsl(dsl: unknown, names: Names): string {
  if (dsl === null || dsl === undefined) return "全員";
  try {
    const tree = audienceTreeFromDsl(dsl);
    return tree ? groupText(tree, names, true) : "(この画面で表せない条件)";
  } catch {
    return "(この画面で表せない条件)";
  }
}

/** 履歴(訪問者の Profile)を使う条件を含むか(閲覧したページ・目標)。初回の訪問からの経過は訪問者 ID から判定するので含めない */
export function dslHasHistory(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const n = raw as Record<string, unknown>;
  if (typeof n.hist === "string") return true;
  return [...(Array.isArray(n.and) ? n.and : []), ...(Array.isArray(n.or) ? n.or : []), ...("not" in n ? [n.not] : [])].some(dslHasHistory);
}
export function usesHistory(c: Cond, audienceHasHistory: (id: string) => boolean): boolean {
  return c.type === "visited" || c.type === "goal" || (c.type === "audience" && audienceHasHistory(c.audience));
}

/**
 * 期間の確認。null(期間の指定なし)だけを検査しない。数値は日数の欄の値のままなので、整数でない(空欄の NaN・小数)・1 未満・3650 超・
 * Site の保存期間超を止める(空欄や 0 で期間を黙って消さない)
 */
export function periodProblem(within: number | null, retentionDays: number): string | null {
  if (within === null) return null;
  if (!Number.isInteger(within) || within < 1 || within > 3650) return "期間は 1〜3650 の整数で入力してください";
  return within > retentionDays ? `期間は訪問者データの保存期間(${retentionDays} 日)以下にしてください` : null;
}
const empty = (v: string) => v.trim() === "";
const regexBroken = (op: string, value: string) => (op === "regex" || op === "notRegex") && value !== "" && checkRegex(value) !== null;

/** 保存の前の確認(入力漏れ・範囲・期間の上限・正規表現)。問題が無ければ null */
export function condProblem(c: Cond, retentionDays: number): string | null {
  switch (c.type) {
    case "url":
    case "path":
    case "host":
      if (empty(c.value)) return "値を入力してください";
      return regexBroken(c.op, c.value) ? "正規表現を直してください" : null;
    case "query":
      if (empty(c.name)) return "パラメータ名を入力してください";
      return c.op === "contains" && empty(c.value) ? "値を入力してください" : null;
    case "device":
    case "browser":
    case "os":
      return c.values.length === 0 ? "1 つ以上選んでください" : null;
    case "viewport": {
      const bad = (n: number) => !Number.isInteger(n) || n < 1 || n > 10000;
      if ((c.op !== "lt" && bad(c.min)) || (c.op !== "gte" && bad(c.max))) return "幅は 1〜10000 の整数で入力してください";
      return c.op === "between" && c.min >= c.max ? "範囲は小さい幅から大きい幅の順にしてください" : null;
    }
    case "referrer":
      return (c.op === "contains" || c.op === "notContains") && empty(c.value) ? "値を入力してください" : null;
    case "time":
      if (c.days.length === 0) return "曜日を 1 つ以上選んでください";
      return !c.allDay && c.from === c.to ? "開始と終了を同じ時刻にはできません(1 日中にするときは「終日」を選びます)" : null;
    case "visited":
      if (empty(c.page.value)) return "ページの値を入力してください";
      if (regexBroken(c.page.op, c.page.value)) return "正規表現を直してください";
      if (!c.neg && (!Number.isInteger(c.min) || c.min < 1)) return "回数は 1 以上の整数で入力してください";
      return periodProblem(c.within, retentionDays);
    case "goal":
      return c.goal === "" ? "目標を選んでください" : periodProblem(c.within, retentionDays);
    case "elapsed": {
      const max = c.unit === "hours" ? 8760 : 3650;
      return !Number.isInteger(c.n) || c.n < 1 || c.n > max ? `1〜${max} の整数で入力してください` : null;
    }
    case "audience":
      return c.audience === "" ? "オーディエンスを選んでください" : null;
  }
}
export function treeProblem(nodes: TreeNode[], retentionDays: number): string | null {
  for (const n of nodes) {
    const p = n.kind === "group" ? treeProblem(n.children, retentionDays) : condProblem(n, retentionDays);
    if (p) return n.kind === "group" ? p : `「${COND_META[n.type].label}」の条件: ${p}`;
  }
  return null;
}

/** 検索付きプルダウンの候補(名前 + 条件の要約) */
export function audienceItems(audiences: Audience[], names: Names): Array<{ value: string; label: string; detail: string }> {
  return audiences.map((a) => ({ value: a.id, label: a.name, detail: summarizeDsl(a.definition, names) }));
}
