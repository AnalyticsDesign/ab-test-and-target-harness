// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DEFAULT_ANALYTICS } from "@wtt/core";
import { SiteNamingPreview } from "@/components/settings/SiteNamingPreview";
import { SiteSettingsForm } from "@/components/settings/SiteSettingsForm";
import type { Site } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/w/w1/sites/s1/settings", useSearchParams: () => new URLSearchParams(), useParams: () => ({ wid: "w1", sid: "s1" }) }));
vi.mock("@/components/ConfirmProvider", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/lib/use-refresh-and-wait", () => ({ useRefreshAndWait: () => vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const site: Site = {
  id: "s1", workspaceId: "w1", name: "Test", mode: "A", idSource: "ab",
  domain: "www.example.test", domains: [{ value: "www.example.test", verdict: "outside", checkedAt: 1, triedAt: 1 }],
  allowedOrigins: ["https://www.example.test"], edgeDomains: [], outsideDomains: ["www.example.test"], uncheckedDomains: [],
  retentionDays: 90, consentMode: "implicit", forgetOnRevoke: true, resultsEnabled: false, resultsRetentionDays: 90, newProfileBudgetPerDay: null,
  timezone: "Asia/Tokyo", decisionTimeoutMs: 1000, visitorCookieName: "_wtt_vid", uuidCookieEnabled: false, uuidCookieName: "_wtt_uuid",
  previousCookieNames: [], shareSubdomains: false, cookieGroups: [], analytics: {
    dataLayerName: "myDL", extraKey: "ab_info",
    exposure: { event: "my_exposure", keys: { experimentId: "eid", experimentName: "ename", variantId: "vid", variantName: "vname" } },
    conversion: { event: "my_conversion", keys: { goalId: "gid", goalName: "gname" } },
  }, ga4PropertyId: null, bigqueryDataset: null,
  activeVersion: null, activeKvStale: false, staticStale: false, staticRemoving: false, lastActivatedAt: null, contentUpdatedAt: 1, createdAt: 1, updatedAt: 1,
};

const settings = (initialSection: "naming" | "general") => createElement(SiteSettingsForm, {
  site, canAdmin: false, canDelete: false, tagOrigin: null, initialSection,
  resultsStore: false, edgeOrigin: null, runningTests: 0, runningRecordedTests: 0,
});

const previews = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="datalayer-preview"]')];
const rows = (preview: Element) => [...preview.children].map((row) => row.textContent ?? "");
const ssr = (element: ReactElement) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(element);
  return host;
};

it.each(["dataLayer", "class"])("「出力される内容」の見出しと 4 つの push を描く (window.%s)", (dataLayerName) => {
  const host = ssr(createElement(SiteNamingPreview, { saved: { ...DEFAULT_ANALYTICS, dataLayerName }, readOnly: false, active: true, busy: false }));
  expect(host.querySelector("h3 button[aria-label='出力される内容の補足']")?.parentElement?.firstChild?.textContent).toBe("出力される内容");
  expect([...host.querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual([
    "露出", "コンバージョン", "制限に当たったとき名前は固定",
  ]);
  const pushes = previews(host);
  expect(pushes).toHaveLength(4);
  const dataLayer: unknown[] = [];
  for (const push of pushes) {
    const lines = rows(push);
    expect(lines[0]).toBe(`window.${dataLayerName}.push({`);
    new Function("window", lines.join("\n"))({ [dataLayerName]: dataLayer });
  }
  expect(dataLayer).toHaveLength(4);
});

function expectSavedNames(host: HTMLElement) {
  const inputs = [...host.querySelectorAll<HTMLInputElement>('input[name^="analytics."]')];
  expect(inputs).toHaveLength(10);
  expect(inputs.every((input) => input.disabled)).toBe(true);
  const pushes = previews(host);
  expect(pushes).toHaveLength(4);
  expect(pushes.map((push) => rows(push)[0])).toEqual(Array(4).fill("window.myDL.push({"));
  expect(rows(pushes[0]!)).toContain("ab_info: null  // 前の露出の追加情報を消す(イベントなし)");
  expect(rows(pushes[1]!)).toContain("ab_info: {");
  expect(pushes.flatMap(rows)).not.toContainEqual(expect.stringMatching(/^null:/));
}

it("閲覧のみでは、サーバー描画で保存した名前を出す", () => {
  expectSavedNames(ssr(settings("naming")));
});

it("閲覧のみでは、マウント後も保存した名前を出す", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () => root.render(settings("naming")));
    expectSavedNames(host);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("ほかの節ではプレビューを描かない", () => {
  expect(previews(ssr(settings("general")))).toHaveLength(0);
});
