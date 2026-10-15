import { compileRegex } from "../src/regex-compile";
import { runProgram } from "../src/regex-run";

/**
 * 正規表現の照合の最悪の時間(設計書 §10.2 の上限の確定用。結果は docs/dev/audience_spike_v1.md の S5)。
 * 入力は「一致しかけて最後で失敗する」256 字と 1,024 字のパス("/aaa…")。1 ページの最悪 = サイト全体 500 命令近くをすべて照合したとき。
 * 参考(plan 作成時の試作、Node 24): 196 命令 × 256 字 = 0.41 ms、1 ページの最悪(490 命令)= 0.50 ms
 */
export function runRegexBench(): Array<{ src: string; instructions: number; len: number; ms: number }> {
  const cases = [".{0,98}b", "[a-z]{1,49}[a-z]{1,49}9", "(a|aa|aaa|aaaa|aaaaa|aaaaaa|aaaaaaa|aaaaaaaa|aaaaaaaaa)*b", "^/products/\\d+/?$", ".*a*b"];
  const out: Array<{ src: string; instructions: number; len: number; ms: number }> = [];
  for (const src of cases) {
    const r = compileRegex(src);
    if (!r.ok) throw new Error(`${src}: ${r.issue.code}`);
    for (const len of [256, 1024]) {
      const input = "/" + "a".repeat(len - 1);
      const n = 50;
      const t0 = performance.now();
      for (let k = 0; k < n; k++) runProgram(r.prog, input, 200);
      out.push({ src, instructions: r.instructions, len, ms: (performance.now() - t0) / n });
    }
  }
  // 1 ページの最悪: 198 + 196 + 65 + 31 = 490 命令を 256 字のパスで全部照合(入力に b も 9 も無い = どれも最後まで一致しかけて失敗する)
  const page = [".{0,98}b", "[a-z]{1,49}[a-z]{1,49}9", "(a|aa|aaa|aaaa|aaaaa|aaaaaa|aaaaaaa|aaaaaaaa|aaaaaaaaa)*b", "[a-z]{1,15}9"].map((s) => compileRegex(s)).map((r) => (r.ok ? r : null)!);
  const total = page.reduce((a, r) => a + r.instructions, 0);
  const input = "/" + "a".repeat(255);
  const t0 = performance.now();
  for (let k = 0; k < 50; k++) for (const r of page) runProgram(r.prog, input, 200);
  out.push({ src: "(1 ページの最悪)", instructions: total, len: 256, ms: (performance.now() - t0) / 50 });
  return out;
}

(globalThis as unknown as { runRegexBench?: typeof runRegexBench }).runRegexBench = runRegexBench;
