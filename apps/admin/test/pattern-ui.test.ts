// @vitest-environment happy-dom
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_ANALYTICS } from "@wtt/core";
import { VariantEditor } from "@/components/VariantEditor";
import { ExperimentEditor } from "@/components/ExperimentEditor";
import { GoalsPanel } from "@/components/GoalsPanel";
import type { Experiment, Site, Variant } from "@/lib/types";

const router = { refresh: vi.fn(), prefetch: vi.fn(), push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/w/w/sites/s/experiments/e", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/ConfirmProvider", () => ({ useConfirm: () => vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const variant: Variant = { id: "a", name: "A", original: true, weight: 100, description: "", analytics: null, changes: [] };
const experiment: Experiment = {
  id: "e", siteId: "s", name: "Hero", kind: "single", status: "draft", publishedStatus: null,
  urlMatch: { include: [{ page: { op: "equals", value: "/" } }] }, targeting: null,
  trafficPercentage: 100, persistAssignment: false, analytics: null, description: "",
  createdBy: "u", updatedBy: "u", createdAt: 1, updatedAt: 2, unpublished: true, runId: null,
  variants: [{ ...variant, original: false }],
};
const site = { id: "s", domain: "example.test", retentionDays: 90, timezone: "Asia/Tokyo", analytics: DEFAULT_ANALYTICS } as Site;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (element: ReactElement) => act(() => root.render(element));
const click = (el: HTMLElement) => act(() => el.click());
function input(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function Editor({ status = "draft" }: { status?: Experiment["status"] }) {
  return createElement(ExperimentEditor, { site, experiment: { ...experiment, status }, goals: [], audiences: [], role: "editor", imageMode: "off", initialTab: "overview", initialVariant: "a", wid: "w", initialPlan: null, recording: false, resultsStore: false });
}
function VariantParent({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState(variant);
  return createElement(VariantEditor, { experimentId: "e", variant: value, saved: variant, onChange: setValue, onRemove: () => {}, disabled, variantsLocked: false, memoDisabled: false, pageUrl: null, removable: false, imageMode: "off", single: false, names: DEFAULT_ANALYTICS, experimentName: "", experimentExtra: {}, analyticsOpen: false, onAnalyticsOpen: () => {} });
}
it("選択中の種類だけが Tab の入口になり、四つの矢印キーで選択とフォーカスが循環する", () => {
  render(createElement(VariantParent));
  const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(radios.map((el) => el.tabIndex)).toEqual([0, -1]);
  act(() => radios[0]!.focus());
  for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
    const previous = document.activeElement;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => previous!.dispatchEvent(event));
    const selected = radios.find((el) => el.getAttribute("aria-checked") === "true")!;
    expect(selected).not.toBe(previous);
    expect(document.activeElement).toBe(selected);
    expect(radios.filter((el) => el.tabIndex === 0)).toEqual([selected]);
    expect(event.defaultPrevented).toBe(true);
  }
});
it("無効な種類はキーで変更されない", () => {
  render(createElement(VariantParent, { disabled: true }));
  const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  act(() => radios[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
  expect(radios.every((el) => el.disabled)).toBe(true);
});
it("終了したエクスペリエンスのメモを編集したときは「保存(メモ)」と表示する", () => {
  render(createElement(Editor, { status: "archived" }));
  input(host.querySelector("textarea")!, "終了後のメモ");
  expect([...host.querySelectorAll("button")].map((el) => el.textContent?.trim())).toContain("保存(メモ)");
});
it("両方の外部計測に値のエラーがあれば、別のタブに移っても両方に印を出す", () => {
  render(createElement(Editor));
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === text)!;
  click(button("外部計測(dataLayer 出力)"));
  input(host.querySelector('input[aria-label="出力するエクスペリエンス名"]')!, "bad\u0001");
  click(host.querySelector("#tab-variants")!);
  click(button("外部計測(dataLayer 出力)"));
  input(host.querySelector('input[aria-label="出力するパターン名"]')!, "bad\u0001");
  click(button("保存(下書き)"));
  click(host.querySelector("#tab-overview")!);
  expect(host.querySelector('#tab-variants [aria-label="このタブに入力エラーがあります"]')).not.toBeNull();
  click(host.querySelector("#tab-variants")!);
  expect(host.querySelector('#tab-overview [aria-label="このタブに入力エラーがあります"]')).not.toBeNull();
});
it("目標 ID の入力前は仮の ID を説明に出さず、入力後は実際の ID を出す", () => {
  render(createElement(GoalsPanel, { siteId: "s", goals: [], canEdit: true, names: DEFAULT_ANALYTICS }));
  click([...host.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === "外部計測(dataLayer 出力)")!);
  const tip = host.querySelector<HTMLButtonElement>('[aria-label="目標名の補足"]')!;
  click(tip);
  expect(document.body.textContent).toContain("空なら目標 ID を出力します");
  expect(document.body.textContent).not.toContain("目標 ID(<目標 ID>)");
  input(host.querySelector("#goal-add-id")!, "g_purchase");
  expect(document.body.textContent).toContain("空なら目標 ID(g_purchase)を出力します");
});
