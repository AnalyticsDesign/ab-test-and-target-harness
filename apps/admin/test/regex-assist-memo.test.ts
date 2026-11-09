// @vitest-environment happy-dom
/**
 * B69 追補 §4 の最後(最終レビュー FR-Medium-2): 正規表現の入力補助(RegexAssist)は、式ごとに 1 回だけコンパイルし、
 * 構文の案内と試す欄の照合で同じ結果を使う。試す値だけの変更・関係の無い親の再描画ではコンパイルし直さない。
 * 再描画を実際に起こすため、この file だけ happy-dom で createRoot を使う(happy-dom は packages/runtime の devDependency で、
 * pnpm の隠れた hoist から読める)
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileRegex, urlMatchIssue, type UrlMatchInput } from "@wtt/core";
import { RegexAssist } from "@/components/targeting/RegexAssist";
import { TargetUrlField } from "@/components/TargetUrlField";
import { checkRegex, compileAssist, testCompiled } from "@/lib/regex-assist";
import type { UrlMatchValue } from "@/lib/url-match";

vi.mock("@wtt/core", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@wtt/core")>();
  return { ...mod, compileRegex: vi.fn(mod.compileRegex) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const compileSpy = vi.mocked(compileRegex);

/** 親: 式と、式に関係の無い状態(tick)を持つ。外から setter を呼んで再描画させる */
let setValue: (v: string) => void = () => {};
let bump: () => void = () => {};
function Parent({ initial }: { initial: string }) {
  const [value, sv] = useState(initial);
  const [tick, st] = useState(0);
  setValue = sv;
  bump = () => st((t) => t + 1);
  return createElement("div", { "data-tick": tick }, createElement(RegexAssist, { value, part: "path", replaced: false, onApply: () => {} }));
}

/** React の制御された input に値を入れる(value の setter を直接呼んでから input を送る) */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("RegexAssist のコンパイルの回数(B69 and FR-Medium-2)", () => {
  let host: HTMLElement;
  let root: Root;
  beforeEach(() => {
    compileSpy.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("regex_assist_compiles_once_per_expression", () => {
    act(() => root.render(createElement(Parent, { initial: "^/products/\\d+$" })));
    expect(compileSpy).toHaveBeenCalledTimes(1); // 構文の案内と試す欄で 1 回を共有する
    // 試す欄を開き、試す値だけを変える → コンパイルし直さない(照合の結果は変わる)
    act(() => (host.querySelector("button[aria-expanded]") as HTMLButtonElement).click());
    const sample = host.querySelector('input[aria-label="試すパス"]') as HTMLInputElement;
    expect(host.textContent).toContain("✓ 一致します");
    act(() => typeInto(sample, "/products/abc"));
    expect(host.textContent).toContain("✗ 一致しません");
    expect(compileSpy).toHaveBeenCalledTimes(1);
    // 関係の無い親の再描画 → コンパイルし直さない
    act(() => bump());
    act(() => bump());
    expect(host.querySelector("[data-tick]")?.getAttribute("data-tick")).toBe("2");
    expect(compileSpy).toHaveBeenCalledTimes(1);
    // 式を変える → 1 回だけコンパイルし直す。誤りの案内と試す欄の両方が新しい式の結果になる
    act(() => setValue("^/a{2,}$"));
    expect(compileSpy).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain("(正規表現を直すと試せます)");
    // 誤りの式のまま試す値を変えても、コンパイルし直さない
    act(() => typeInto(host.querySelector('input[aria-label="試すパス"]') as HTMLInputElement, "/aa"));
    expect(compileSpy).toHaveBeenCalledTimes(2);
    // 空の式はコンパイルしない
    act(() => setValue(""));
    expect(compileSpy).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("入力補助の部品(B69 and FR-Medium-2)", () => {
  beforeEach(() => {
    compileSpy.mockClear(); // 戻り値(spy 自体)を返すと後始末の関数として呼ばれるので、ブロックで書く
  });

  it("regex_assist_seam_compile_once_test_without_compile", () => {
    const ok = compileAssist("^/products/\\d+$");
    expect(ok.check).toBeNull();
    const bad = compileAssist("^/a{2,}$");
    expect(bad.check?.issue.code).toBe("regex_unbounded_repeat");
    expect(compileSpy).toHaveBeenCalledTimes(2);
    // 試す欄の照合はコンパイルしない(testRegex と同じ結果)
    expect(testCompiled(ok, "path", "/products/123")).toBe("match");
    expect(testCompiled(ok, "path", "/products/abc")).toBe("nomatch");
    expect(testCompiled(ok, "path", `/${"x".repeat(256)}`)).toBe("skipped");
    expect(testCompiled(bad, "path", "/aa")).toBe("invalid");
    expect(compileSpy).toHaveBeenCalledTimes(2);
    // 今までの checkRegex と同じ案内・「この形にする」の値
    expect(bad.check).toEqual(checkRegex("^/a{2,}$"));
  });

  it("target_url_field_ssr_compiles_each_regex_once", () => {
    // 保存できる最大の個数: 含める 10 行 + 除く 10 行、各行 page + and 5 個 = 正規表現 120 個。1 個 = 192 字の文字の集合(^[…]$ = 4 命令)で
    // 合計 480 命令(上限 500)。保存の検査(urlMatchIssue)を通ること = 実際に保存できる入力であることを先に確かめる
    const chars = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter((c) => !"\\]^-[".includes(c));
    const cls = (k: number) => {
      const rot = chars.slice(k % chars.length).concat(chars.slice(0, k % chars.length)).join("");
      return (rot + rot + rot).slice(0, 190);
    };
    let n = 0;
    const re = () => ({ part: "path" as const, op: "regex" as const, value: `^[${cls(n++)}]$` });
    const row = () => ({ page: re(), and: Array.from({ length: 5 }, re) });
    const value: UrlMatchValue = { include: Array.from({ length: 10 }, row), exclude: Array.from({ length: 10 }, row) };
    expect(n).toBe(120);
    expect(urlMatchIssue(value as UrlMatchInput)).toBeNull();
    compileSpy.mockClear();
    renderToStaticMarkup(createElement(TargetUrlField, { value, onChange: () => {} }));
    expect(compileSpy).toHaveBeenCalledTimes(120); // 1 個の式につき 1 回(分ける前は構文の案内と試す欄で 240 回)
  });
});
