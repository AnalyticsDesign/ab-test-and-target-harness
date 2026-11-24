// @vitest-environment happy-dom
import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DEFAULT_ANALYTICS } from "@wtt/core";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import { GoalsPanel } from "@/components/GoalsPanel";
import { VariantEditor } from "@/components/VariantEditor";
import { DataLayerPreview } from "@/components/experiment/DataLayerPreview";
import { ExperimentAnalyticsCard } from "@/components/experiment/ExperimentAnalyticsCard";
import { siteDataLayerPreview } from "@/lib/datalayer-preview";
import type { Variant } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/w/w1/sites/s1/goals",
}));

vi.mock("@/components/experiment/AnalyticsCard", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/experiment/AnalyticsCard")>();
  return {
    ...original,
    // 目標追加フォームは SSR で閉じているので、フォーム内のカード(bare)だけ開いて描画する。
    AnalyticsCard: (props: ComponentProps<typeof original.AnalyticsCard>) =>
      createElement(original.AnalyticsCard, { ...props, open: props.bare || props.open }),
  };
});

function previewRows(element: ReactElement): string[] {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(element);
  const preview = host.querySelector('[data-testid="datalayer-preview"]');
  return Array.from(preview?.children ?? [], (row) => row.textContent ?? "");
}

it("宛先は window.<名前>.push({", () => {
  const rows = previewRows(createElement(DataLayerPreview, {
    lines: [],
    extraKey: DEFAULT_ANALYTICS.extraKey,
    dataLayerName: "myDL",
  }));
  expect(rows[0]).toBe("window.myDL.push({");
});

it.each(["dataLayer", "class"])("%s 宛ての全 push が JavaScript として成り立つ", (dataLayerName) => {
  const names = { ...DEFAULT_ANALYTICS, dataLayerName };
  const pushes = siteDataLayerPreview(names).flatMap((block) => block.pushes).map((lines) =>
    previewRows(createElement(DataLayerPreview, { lines, extraKey: names.extraKey, dataLayerName })),
  );
  expect(pushes.map((rows) => rows[0])).toEqual(Array(4).fill(`window.${dataLayerName}.push({`));
  for (const rows of pushes) {
    expect(() => new Function(rows.join("\n"))).not.toThrow();
  }
});

const names = { ...DEFAULT_ANALYTICS, dataLayerName: "myDL" };
const variant: Variant = { id: "a", name: "A", original: true, weight: 100, description: "", analytics: null, changes: [] };

it.each([
  ["GoalsPanel", () => createElement(ConfirmProvider, {
    children: createElement(GoalsPanel, { siteId: "s1", goals: [], canEdit: true, names }),
  })],
  ["VariantEditor", () => createElement(VariantEditor, {
    experimentId: "e",
    variant,
    saved: variant,
    onChange: () => {},
    onRemove: () => {},
    disabled: false,
    variantsLocked: false,
    memoDisabled: false,
    pageUrl: null,
    removable: false,
    imageMode: "off",
    single: false,
    names,
    experimentName: "",
    experimentExtra: {},
    analyticsOpen: true,
    onAnalyticsOpen: () => {},
  })],
  ["ExperimentAnalyticsCard", () => createElement(ExperimentAnalyticsCard, {
    experimentId: "e",
    expName: "",
    extra: {},
    saved: { expName: "", extra: {} },
    variants: [variant],
    names,
    disabled: false,
    saveTried: false,
    open: true,
    onOpenChange: () => {},
    onChange: () => {},
  })],
] as const)("%s のプレビューはサイトの変数名を宛先に出す", (_screen, render) => {
  expect(previewRows(render())[0]).toBe("window.myDL.push({");
});
