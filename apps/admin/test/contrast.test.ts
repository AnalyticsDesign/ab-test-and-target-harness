import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// B31 ⑨: 状態の印(StatusPill)とバッジの文字色は、12px の文字なので背景との比が 4.5:1 以上(WCAG AA)。
// トークンの正は globals.css。ライト(:root)とダーク([data-theme="dark"])の両方を読む
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} が globals.css に無い`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// 文字色と背景の組(StatusPill.tsx の tone と、globals.css の .badge / .badge-ok / .badge-warn)
const PAIRS: Array<[string, string]> = [
  ["ok", "ok-soft"],
  ["warn", "warn-soft"],
  ["gray", "gray-soft"],
  ["danger", "danger-soft"],
  ["accent", "accent-soft"],
  ["muted", "gray-soft"],
];

// ダークの値は [data-theme="dark"] と、OS の設定に従う @media の中の :root の 2 か所に同じ写しがある。片方だけ直すとずれる
it("ダークの値の 2 つの写し([data-theme=dark] と @media の :root)が同じ", () => {
  const forced = block('[data-theme="dark"]');
  const media = block(':root:not([data-theme="light"])');
  for (const [fg, bg] of PAIRS) {
    expect(media[fg], `--${fg}`).toBe(forced[fg]);
    expect(media[bg], `--${bg}`).toBe(forced[bg]);
  }
});

describe.each([
  ["ライト", ":root"],
  ["ダーク", '[data-theme="dark"]'],
])("状態の印の文字色のコントラスト(%s)", (_name, selector) => {
  const t = block(selector);
  it.each(PAIRS)("--%s / --%s が 4.5:1 以上", (fg, bg) => {
    expect(t[fg], `--${fg}`).toBeDefined();
    expect(t[bg], `--${bg}`).toBeDefined();
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});
