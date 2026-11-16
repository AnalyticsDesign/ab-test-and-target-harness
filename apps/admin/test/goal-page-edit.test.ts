// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_ANALYTICS } from "@wtt/core";
import { GoalsPanel } from "@/components/GoalsPanel";
import type { Goal } from "@/lib/types";

vi.mock("@/components/ConfirmProvider", () => ({ useConfirm: () => vi.fn() }));
// 覆いと再描画待ちはこのテストの対象外。フォームと実際の API クライアントはそのまま使う。
vi.mock("@/components/ui/BusyScope", () => ({
  BusyScope: ({ children }: { children: ReactNode }) => children,
  useBusyAction: () => ({ run: async ({ write }: { write: (s: AbortSignal) => Promise<unknown> }) => {
    await write(new AbortController().signal);
    return { kind: "saved", refresh: "done" };
  } }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const goal: Goal = { id: "g_page", name: "Page goal", type: "PAGEVIEW", config: { page: { part: "path", op: "startsWith", value: "/thanks/" } }, analytics: null, createdAt: 1, updatedAt: 1 };
let host: HTMLElement;
let root: Root;
let writes: Array<{ method: string; path: string; body: unknown }>;
beforeEach(() => {
  writes = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    writes.push({ method: init.method!, path, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(goal), { status: 200, headers: { "content-type": "application/json" } });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(GoalsPanel, { siteId: "s1", goals: [goal], canEdit: true, names: DEFAULT_ANALYTICS })));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const click = (node: Element) => act(() => (node as HTMLElement).click());
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const edit = () => click([...host.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith("編集"))!);

it("ページの値の Enter は暗黙送信を止め、Tab と一致の仕方の Enter を妨げない", () => {
  const input = host.querySelector('[data-testid="goal-add"] input[name="value"]')!;
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  act(() => input.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(true);
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => input.dispatchEvent(tab));
  expect(tab.defaultPrevented).toBe(false);
  const picker = host.querySelector('[data-testid="goal-add"] [aria-label="一致の仕方"]')!;
  act(() => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(picker.getAttribute("aria-expanded")).toBe("true");
  expect(writes).toEqual([]);
});
it("一致の仕方だけの変更でもページ条件を1回の PATCH で保存する", async () => {
  edit();
  const picker = host.querySelector('[data-testid="goals-list"] [aria-label="一致の仕方"]');
  expect(picker).not.toBeNull();
  click(picker!);
  click([...host.querySelectorAll('[role="option"]')].find((o) => o.textContent === "を含む")!);
  await act(async () => { button("保存").click(); });
  expect(writes).toEqual([{ method: "PATCH", path: "/api/control/sites/s1/goals/g_page", body: { name: "Page goal", config: { page: { part: "path", op: "contains", value: "/thanks/" } } } }]);
  expect(host.querySelector('[data-testid="goals-list"] [aria-label="一致の仕方"]')).toBeNull();
});
it("ページ条件が変わらない保存では PATCH しない", async () => {
  edit();
  await act(async () => { button("保存").click(); });
  expect(writes).toEqual([]);
});

it("キャンセルすると編集した条件を送らず、再び開くと保存済みに戻る", () => {
  edit();
  click(host.querySelector('[data-testid="goals-list"] [aria-label="一致の仕方"]')!);
  click([...host.querySelectorAll('[role="option"]')].find((o) => o.textContent === "を含む")!);
  click(button("キャンセル"));
  edit();
  expect(host.querySelector('[data-testid="goals-list"] [aria-label="一致の仕方"]')?.textContent).toContain("で始まる");
  expect(writes).toEqual([]);
});
it("名前だけの編集は既存のページ条件を PATCH に載せない", async () => {
  edit();
  const input = host.querySelector<HTMLInputElement>('[data-testid="goals-list"] input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { button("保存").click(); });
  expect(writes).toEqual([{ method: "PATCH", path: "/api/control/sites/s1/goals/g_page", body: { name: "Renamed" } }]);
});

it("編集中に最新の一覧が届いても、未編集のページ条件を送り戻さない", async () => {
  edit();
  const updated = { ...goal, updatedAt: 2, config: { page: { part: "path", op: "equals", value: "/other/" } } };
  act(() => root.render(createElement(GoalsPanel, { siteId: "s1", goals: [updated], canEdit: true, names: DEFAULT_ANALYTICS })));
  const input = host.querySelector<HTMLInputElement>('[data-testid="goals-list"] input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed after refresh");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { button("保存").click(); });
  expect(writes).toEqual([{ method: "PATCH", path: "/api/control/sites/s1/goals/g_page", body: { name: "Renamed after refresh" } }]);
});
