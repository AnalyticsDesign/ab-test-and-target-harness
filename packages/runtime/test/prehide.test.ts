import { expect, it } from "vitest";
import { compileRegex, type CompiledConfig } from "@wtt/core";
import { injectPrehide, prehideSelectors, removePrehide } from "../src/prehide";
import { baseConfig } from "./fixtures"; // Task 5 で作る共有フィクスチャ(下記)

it("collects prehide selectors only for experiments matching the current url (spec §10.3)", () => {
  const config: CompiledConfig = {
    ...baseConfig,
    prehide: { exp_hero: [".hero-title", ".cta"], exp_other: [".other"] },
    experiments: [
      { ...baseConfig.experiments[0]!, id: "exp_hero", urlMatch: { include: [{ page: { op: "contains", value: "/pricing" } }] } },
      { ...baseConfig.experiments[0]!, id: "exp_other", urlMatch: { include: [{ page: { op: "contains", value: "/never" } }] } },
    ],
  };
  expect(prehideSelectors(config, "https://site.test/pricing?utm=x")).toEqual([".hero-title", ".cta"]);
});

it("prehide_respects_params_and_exclude: パラメータの条件と除くの行もプリハイドの範囲に効く(B69 spec §3.3)", () => {
  const config: CompiledConfig = {
    ...baseConfig,
    prehide: { exp_hero: [".hero-title"] },
    experiments: [{
      ...baseConfig.experiments[0]!,
      urlMatch: {
        include: [{ page: { part: "path", op: "startsWith", value: "/lp/" }, params: [{ name: "utm_source", op: "equals", value: "news" }] }],
        exclude: [{ page: { part: "path", op: "startsWith", value: "/lp/old/" } }],
      },
    }],
  };
  expect(prehideSelectors(config, "https://site.test/lp/?utm_source=news")).toEqual([".hero-title"]);
  expect(prehideSelectors(config, "https://site.test/lp/")).toEqual([]);
  expect(prehideSelectors(config, "https://site.test/lp/old/?utm_source=news")).toEqual([]);
});

it("prehide_excludes_on_null_exclude_row: 除くの行が判定できない(257 字のパスでパスの正規表現)なら隠さない(B69 spec §3.1)", () => {
  const prog = compileRegex("^/lp/old/");
  if (!prog.ok) throw new Error("fixture regex");
  const config: CompiledConfig = {
    ...baseConfig,
    prehide: { exp_hero: [".hero-title"] },
    experiments: [{
      ...baseConfig.experiments[0]!,
      urlMatch: { include: [{ page: { op: "contains", value: "/" } }], exclude: [{ page: { part: "path", op: "regex", value: "^/lp/old/", prog: prog.prog } }] },
    }],
  };
  expect(prehideSelectors(config, "https://site.test/lp/new/")).toEqual([".hero-title"]); // 除くの行が false なら対象
  const longPath = "/lp/" + "a".repeat(253);
  expect(longPath.length).toBe(257);
  expect(prehideSelectors(config, `https://site.test${longPath}`)).toEqual([]);
});

it("injects opacity:0 !important style and removes it by id (spec §10.3)", () => {
  injectPrehide(document, [".hero-title"], null);
  const style = document.getElementById("__ab_prehide");
  expect(style?.textContent).toBe(".hero-title{opacity:0 !important}");
  removePrehide(document);
  expect(document.getElementById("__ab_prehide")).toBeNull();
  removePrehide(document); // 二重解除は no-op
});

it("injects nothing when there is no matching selector", () => {
  injectPrehide(document, [], null);
  expect(document.getElementById("__ab_prehide")).toBeNull();
});

it("drops selectors that would break out of the prehide rule (r1 CX-Medium-2)", () => {
  // compiled config の selector 検証は長さ 500 字のみ(core schema)。CSS へ無検証で連結すると、
  // TEXT Change の selector 欄から任意の CSS ルールを注入でき、Code Change(ADMIN の Publish 経由)を迂回できる
  injectPrehide(document, [".hero-title", ".x{display:block}body", "@import url(https://evil.test/x.css);a"], null);
  const style = document.getElementById("__ab_prehide");
  expect(style?.textContent).toBe(".hero-title{opacity:0 !important}"); // 正常な selector だけが残る
  expect(style?.textContent).not.toContain("display:block");
  expect(style?.textContent).not.toContain("@import");
  removePrehide(document);
});

it("puts the nonce on the prehide style when given (decision 38)", () => {
  removePrehide(document); // 直前のテストの取り残しがあっても no-op にならないように
  document.body.innerHTML = `<h1 class="hero-title">x</h1>`;
  injectPrehide(document, [".hero-title"], "n1");
  expect(document.getElementById("__ab_prehide")!.getAttribute("nonce")).toBe("n1");
  removePrehide(document);
  injectPrehide(document, [".hero-title"], null);
  expect(document.getElementById("__ab_prehide")!.hasAttribute("nonce")).toBe(false);
  removePrehide(document);
});
