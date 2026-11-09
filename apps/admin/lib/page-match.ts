/**
 * ページの一致(対象 URL・目標の PAGEVIEW)の入力欄の選択肢と表示(決定 49)。保存する形は control の API と同じ
 * `{ part?, op, value }`(part 省略 = URL)。見た目をそろえたプルダウン部品と日本語の表記の見直しは別の作業(B34 の plan ② / B35)
 */
import { compileRegex, matchTargetUrl, normalizePageMatch, normalizeRegexInput, pageOf, type PageMatch, type PageMatchInput } from "@wtt/core";
import type { UrlMatchValue } from "./url-match";

export type PagePart = "url" | "path" | "host";
export type PageMatchValue = { part?: PagePart; op: string; value: string };

export const PAGE_PART_LABELS: Record<PagePart, string> = { path: "パス", host: "ホスト", url: "URL" };

/** part ごとの一致の仕方。先頭が既定。URL 全体には正規表現を使えない(パスとホストに分けて書く) */
export const PAGE_OP_OPTIONS: Record<PagePart, Array<{ op: string; label: string }>> = {
  path: [
    { op: "startsWith", label: "で始まる" },
    { op: "contains", label: "を含む" },
    { op: "equals", label: "と完全一致" },
    { op: "regex", label: "に一致(正規表現)" },
  ],
  host: [
    { op: "equals", label: "と完全一致" },
    { op: "endsWith", label: "で終わる(サブドメインを含む)" },
    { op: "contains", label: "を含む" },
    { op: "regex", label: "に一致(正規表現)" },
  ],
  url: [
    { op: "contains", label: "を含む" },
    { op: "equals", label: "と完全一致" },
    { op: "startsWith", label: "で始まる" },
  ],
};

/** 新しく作るときの既定(パスで始まる) */
export const DEFAULT_PAGE_MATCH: PageMatchValue = { part: "path", op: "startsWith", value: "" };

export const partOf = (m: PageMatchValue): PagePart => m.part ?? "url";

/** part を変えたとき: 今の一致の仕方がその part で使えなければ、その part の既定にする */
export function withPart(m: PageMatchValue, part: PagePart): PageMatchValue {
  const op = PAGE_OP_OPTIONS[part].some((o) => o.op === m.op) ? m.op : PAGE_OP_OPTIONS[part][0]!.op;
  return { part, op, value: m.value };
}

/** 一覧などに出す 1 行の説明(例: 「パス が「/lp/」で始まる」)。知らない組み合わせは op をそのまま出す */
export function describePageMatch(m: PageMatchValue): string {
  const part = partOf(m);
  const label = PAGE_OP_OPTIONS[part].find((o) => o.op === m.op)?.label ?? m.op;
  return `${PAGE_PART_LABELS[part]} が「${m.value}」${label}`;
}

/** 1 つのページの一致から組み立てる URL。パスかURL の「完全一致 / で始まる」のときだけ(パスは Site のドメインに付け、URL は http(s) のときだけそのまま) */
function pageUrlOf(domain: string, m: PageMatchValue): string | null {
  if (m.op !== "equals" && m.op !== "startsWith") return null;
  const part = partOf(m);
  if (part === "path") return m.value.startsWith("/") ? `https://${domain}${m.value}` : null;
  if (part === "url") return /^https?:\/\//.test(m.value) ? m.value : null;
  return null;
}

/** URL にパラメータの「次に一致」(equals)をクエリとして足す。URL として読めなければ足さずにそのまま返す(画面を落とさない) */
function withEqualsParams(base: string, params: UrlMatchValue["include"][number]["params"]): string {
  const equals = (params ?? []).filter((p) => p.op === "equals");
  if (equals.length === 0) return base;
  try {
    const u = new URL(base);
    for (const p of equals) u.searchParams.append(p.name, p.value);
    return u.toString();
  } catch {
    return base;
  }
}

/**
 * プレビューを開くページの URL(編集画面の「このページで確認」)。対象 URL の含めるの行のうち、最初に組み立てられる行から作り、
 * その行のパラメータの「次に一致」をクエリに足す(B69。「を含む」「がある」は値が決まらないので足さない)。除くの行は見ない
 */
export function previewPageUrl(domain: string, m: UrlMatchValue): string | null {
  for (const row of m.include) {
    // and の無い行は今までどおり(確かめを掛けない)
    if (!row.and?.length) {
      const base = pageUrlOf(domain, row.page);
      if (base !== null) return withEqualsParams(base, row.params);
      continue;
    }
    // and を持つ行は、クエリを足した最終の URL がページの条件(page と and)に一致するときだけ使う(B69 追補 §4)
    const built = andRowBaseUrl(domain, row.page, row.and);
    if (built === null) continue;
    const url = withEqualsParams(built.base, row.params);
    if (matchesConds(built.conds, url)) return url;
  }
  return null;
}

/** page と and の条件(正規化・正規表現は命令列つき)が URL に一致するか。パラメータの条件は見ない */
function matchesConds(conds: PageMatch[], url: string): boolean {
  const [head, ...rest] = conds;
  return matchTargetUrl({ include: [{ page: head!, and: rest }] }, pageOf(url));
}

/**
 * and を持つ行の URL(クエリを足す前)と、確かめに使う条件。page と and を保存のときと同じに正規化し(入力の途中のホストの大文字など)、正規表現は命令列にしてから、
 * URL の「完全一致 / で始まる」(http(s))があればそれを、無ければホスト(完全一致。無ければサイトのドメイン)とパス(完全一致を優先、無ければで始まる)から組み立てる。
 * 組み立てられない行、コンパイルできない式を持つ行は null。一致の確かめはクエリを足した最終の URL に対して呼び出し側が行う(パラメータの条件は今と同じく確かめない)
 */
function andRowBaseUrl(domain: string, page: PageMatchValue, and: PageMatchValue[]): { base: string; conds: PageMatch[] } | null {
  const conds: PageMatch[] = [];
  for (const c of [page, ...and]) {
    const n = normalizePageMatch(c as PageMatchInput);
    if (n.op !== "regex") {
      conds.push(n);
      continue;
    }
    const r = compileRegex(n.value);
    if (!r.ok) return null;
    conds.push({ ...n, prog: r.prog });
  }
  const first = (part: PagePart, op: string) => conds.find((c) => partOf(c) === part && c.op === op)?.value;
  const urlValue = [first("url", "equals"), first("url", "startsWith")].find((v) => v !== undefined && /^https?:\/\//.test(v));
  if (urlValue !== undefined) return { base: urlValue, conds };
  const path = [first("path", "equals"), first("path", "startsWith")].find((v) => v !== undefined && v.startsWith("/"));
  if (path === undefined) return null;
  return { base: `https://${first("host", "equals") ?? domain}${path}`, conds };
}

/**
 * 正規表現の値の入力の正規化(設計書 §10.4 の 4)。¥・￥・全角を core の normalizeRegexInput(control の保存値と同じ関数)で置き換える。
 * replaced = 置き換えたか(入力欄の下に「¥ を \ に置き換えました」と出す)。正規表現でなければそのまま
 */
export function normalizeRegexValue(m: PageMatchValue): { value: PageMatchValue; replaced: boolean } {
  if (m.op !== "regex") return { value: m, replaced: false };
  const v = normalizeRegexInput(m.value);
  return v === m.value ? { value: m, replaced: false } : { value: { ...m, value: v }, replaced: true };
}

/**
 * ホストの正規表現に大文字の英字があるか(設計書 §4.1.2 (c))。ホストは小文字にした値と照合するので、大文字を含む式は一致しない。
 * 式の意味を変えないため値は小文字化せず、保存も止めない。入力欄の下に案内を出すだけ
 */
export function hostRegexHasUppercase(m: PageMatchValue): boolean {
  return partOf(m) === "host" && m.op === "regex" && /[A-Z]/.test(m.value);
}
