/**
 * 正規表現の案内(決定 49、設計書 §10.4 の 1〜3)。検査は control の保存時と同じ core の compileRegex、試す欄は本番(runtime・edge)と
 * 同じ照合対象の正規化(pageOf)と照合器(runProgram)を使う。画面・API・エージェントで同じ説明を出す
 */
import { compileRegex, pageOf, REGEX_RUN_LIMITS, runProgram, type RegexIssue, type RegexProgram } from "@wtt/core";

/** 書き換えの例を問題の箇所に当てはめると意味が通る理由のコード(ほかは例を文字で見せるだけ。例: 空の選択肢の例 a? は箇所の置き換えにならない) */
const FIXABLE = new Set(["regex_unbounded_repeat", "regex_repeat_too_large"]);

/** 「この形にする」の値。当てはめて意味が通らない例(式全体の例・形の違う例)は null */
export function applyExample(src: string, issue: RegexIssue): string | null {
  if (issue.example === undefined) return null;
  const escapesOneChar = issue.length === 1 && issue.example.length === 2 && issue.example.startsWith("\\");
  if (!FIXABLE.has(issue.code) && !escapesOneChar) return null;
  return src.slice(0, issue.index) + issue.example + src.slice(issue.index + issue.length);
}

export function checkRegex(src: string): { issue: RegexIssue; fix: string | null } | null {
  return compileAssist(src).check;
}

/**
 * 入力補助(RegexAssist)が 1 つの式について使う結果。式を 1 回だけコンパイルし、構文の案内(check)と試す欄の照合(testCompiled)で
 * 同じ結果を使う(B69 追補 §4: 画面は式が変わったときだけこれを呼び直す。試す値の変更・親の再描画ではコンパイルしない)
 */
export type CompiledAssist = { check: { issue: RegexIssue; fix: string | null } | null; prog: RegexProgram | null };

export function compileAssist(src: string): CompiledAssist {
  const r = compileRegex(src);
  return r.ok ? { check: null, prog: r.prog } : { check: { issue: r.issue, fix: applyExample(src, r.issue) }, prog: null };
}

/**
 * 試す値を本番の照合対象と同じ形にする(core の pageOf: ホストは小文字・末尾のドットを除く・日本語のドメインは punycode、
 * パスは percent-encoding)。URL として読めなければ null(本番でも判定できない)
 */
export function sampleValue(part: "path" | "host", sample: string): string | null {
  const page = pageOf(part === "host" ? `https://${sample}/` : `https://example.invalid${sample.startsWith("/") ? "" : "/"}${sample}`);
  return part === "host" ? page.host : page.path;
}

/** 試す欄: 部分一致。正規化した値(sampleValue)で長さの上限を見てから照合する。パスは 256 字を超えたら・読めない値は判定しない(本番と同じ) */
export function testRegex(src: string, part: "path" | "host", sample: string): SampleResult {
  return testCompiled(compileAssist(src), part, sample);
}

export type SampleResult = "match" | "nomatch" | "skipped" | "invalid";

/** testRegex のコンパイル済みの版(コンパイルしない)。試す値だけが変わったときはこちらだけを呼び直す */
export function testCompiled(compiled: CompiledAssist, part: "path" | "host", sample: string): SampleResult {
  if (compiled.prog === null) return "invalid";
  const s = sampleValue(part, sample);
  if (s === null || s.length > (part === "host" ? REGEX_RUN_LIMITS.hostMax : REGEX_RUN_LIMITS.pathMax)) return "skipped";
  return runProgram(compiled.prog, s) === true ? "match" : "nomatch";
}
