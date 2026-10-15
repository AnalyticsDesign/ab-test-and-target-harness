import { expect, it } from "vitest";
import type { CompiledConfig } from "@wtt/core";
import { injectPrehide, prehideSelectors, removePrehide } from "../src/prehide";
import { baseConfig } from "./fixtures"; // Task 5 で作る共有フィクスチャ(下記)

it("collects prehide selectors only for experiments matching the current url (spec §10.3)", () => {
  const config: CompiledConfig = {
    ...baseConfig,
    prehide: { exp_hero: [".hero-title", ".cta"], exp_other: [".other"] },
    experiments: [
      { ...baseConfig.experiments[0]!, id: "exp_hero", urlMatch: { op: "contains", value: "/pricing" } },
      { ...baseConfig.experiments[0]!, id: "exp_other", urlMatch: { op: "contains", value: "/never" } },
    ],
  };
  expect(prehideSelectors(config, "https://site.test/pricing?utm=x")).toEqual([".hero-title", ".cta"]);
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
