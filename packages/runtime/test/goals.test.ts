import { beforeEach, expect, it } from "vitest";
import type { Goal } from "@wtt/core";
import { startGoalDetection } from "../src/goals";
import { baseConfig } from "./fixtures";

const goals: Goal[] = [
  { id: "g_pv", name: "Pricing view", type: "PAGEVIEW", config: { page: { op: "contains", value: "/pricing" } } },
  { id: "g_other", name: "Other page", type: "PAGEVIEW", config: { page: { op: "equals", value: "https://site.test/other" } } },
  { id: "g_click", name: "CTA", type: "CLICK", config: { selector: ".cta" } },
  { id: "g_custom", name: "Custom", type: "CUSTOM", config: {} },
];
const config = { ...baseConfig, goals };

beforeEach(() => {
  document.body.innerHTML = `<a class="cta"><span id="inner">buy</span></a><button id="noop">x</button>`;
});

it("PAGEVIEW は起動時に URL 一致分だけ 1 回発火し、CUSTOM は自動発火しない", () => {
  const fired: string[] = [];
  const stop = startGoalDetection(config, document, "https://site.test/pricing?utm=x", (g) => fired.push(g.id));
  expect(fired).toEqual(["g_pv"]);
  stop();
});

it("click_goal_fires_on_every_matching_click", () => {
  const fired: string[] = [];
  const stop = startGoalDetection(config, document, "https://site.test/", (g) => fired.push(g.id));
  document.getElementById("inner")!.click(); // 子要素からの委譲(closest)
  document.querySelector<HTMLElement>(".cta")!.click();
  document.getElementById("noop")!.click(); // 不一致
  expect(fired).toEqual(["g_click", "g_click"]); // 決定 37 (4): 重複排除しない
  stop();
  document.querySelector<HTMLElement>(".cta")!.click();
  expect(fired).toHaveLength(2); // 停止後は発火しない
});

it("再レンダリングで差し替わった要素にも効く(document への委譲)", () => {
  const fired: string[] = [];
  const stop = startGoalDetection(config, document, "https://site.test/", (g) => fired.push(g.id));
  document.body.innerHTML = `<a class="cta">new</a>`;
  document.querySelector<HTMLElement>(".cta")!.click();
  expect(fired).toEqual(["g_click"]);
  stop();
});
