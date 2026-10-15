/**
 * 保存するページの一致の正規化と検査(決定 49、設計書 §4.1.2)。control(保存時)・compile・fixture・管理画面が使う。runtime には入れない
 */
import { compileRegex, normalizeRegexInput, type RegexIssue } from "./regex-compile";
import type { PageOp, PagePart } from "./page";

/** 保存する形(命令列を持たない)。`part` は既定の url なら省く */
export type PageMatchInput = { part?: PagePart; op: PageOp; value: string };

/** ホスト: 小文字化・前後の空白と末尾のドットを除く・IDN は punycode(URL の解析と同じ形) */
export function normalizeHostValue(v: string): string {
  let out = v.trim().toLowerCase().replace(/\.+$/, "");
  if (/[^\x00-\x7f]/.test(out)) {
    try {
      out = new URL(`http://${out}`).hostname;
    } catch {
      // URL として解釈できないホストはそのまま(どのページにも一致しない)
    }
  }
  return out;
}

/** パス: 日本語などと、URL の解析が pathname でエンコードする記号(空白 " < > ` { })を percent-encoding する(%XX は大文字) */
export function normalizePathValue(v: string): string {
  try {
    return v.replace(/[^\x21-\x7e]|["<>`{}]/gu, (c) => encodeURIComponent(c));
  } catch {
    return v; // 対になっていないサロゲートなど(エンコードできない)はそのまま
  }
}

/**
 * 正規化(§4.1.2): 文字列の演算子はホスト・パスの値を正規化、正規表現は円記号と全角の置き換えだけ(式の意味を変えない)、
 * URL は今の判定と同じ文字列のまま。`part: "url"` は既定値なので省く
 */
export function normalizePageMatch(m: PageMatchInput): PageMatchInput {
  const part = m.part ?? "url";
  const value = m.op === "regex" ? normalizeRegexInput(m.value) : part === "host" ? normalizeHostValue(m.value) : part === "path" ? normalizePathValue(m.value) : m.value;
  return part === "url" ? { op: m.op, value } : { part, op: m.op, value };
}

/** 正規表現の検査(正規化の後に呼ぶ)。url の正規表現は使えない(設計書 §10.1)。問題が無ければ null */
export function pageMatchIssue(m: PageMatchInput): RegexIssue | null {
  if (m.op !== "regex") return null;
  if ((m.part ?? "url") === "url")
    return {
      code: "regex_not_allowed_on_url",
      message: "URL 全体には正規表現を使えません。ホストとパスに分け、パスの正規表現で書きます",
      index: 0,
      length: 0,
      example: '{ "part": "path", "op": "regex", "value": "^/products/\\\\d+$" }',
    };
  const r = compileRegex(m.value);
  return r.ok ? null : r.issue;
}
