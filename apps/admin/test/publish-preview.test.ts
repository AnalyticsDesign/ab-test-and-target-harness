import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi } from "vitest";
import { PublishPanel } from "@/components/PublishPanel";
import type { PublishPreview } from "@/lib/types";
vi.mock("next/navigation", () => ({ useRouter: () => ({ prefetch() {}, refresh() {} }) }));
const preview = (extra: Record<string, unknown> = {}): PublishPreview => ({ lastActivatedAt: null, siteLevelChanged: false, experiments: [], audienceChanges: [], droppedPageConditions: [], viewportExperiments: [], compileError: null, overlaps: [], ...extra });
const render = (p: PublishPreview) => renderToStaticMarkup(createElement(PublishPanel, { wid: "w", site: { id: "s", name: "Site", activeVersion: null }, preview: p, canPublish: true }));
it("missing digest disables publish", () => {
  const html = render(preview());
  expect(html).toContain("公開の確認を読み込めませんでした");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>公開する/);
});
it("config detected changes display the comparison reason", () => {
  const html = render(preview({ digest: "a".repeat(64), experiments: [{ id: "e", name: "Example", status: "running", publishedStatus: "running", updatedAt: 1, updatedBy: { id: "u", name: "User" }, hasCodeChange: false, changedChanges: [], detectedBy: "config" }] }));
  expect(html).toContain("変更あり(公開中の設定との比較で見つかりました)");
});
it("external url mark is rendered", () => {
  const html = render(preview({ digest: "a".repeat(64), experiments: [{ id: "e", name: "Example", status: "running", publishedStatus: "running", updatedAt: 1, updatedBy: { id: "u", name: "User" }, hasCodeChange: false, hasExternalUrl: true, changedChanges: [] }] }));
  expect(html).toContain("外部の URL を含む");
});
