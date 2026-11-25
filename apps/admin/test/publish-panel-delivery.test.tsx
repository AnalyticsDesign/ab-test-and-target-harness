// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { PublishPanel } from "@/components/PublishPanel";
import { button, click, delayed, mount, preview, stubControl } from "./publish-dialog-fixture";

vi.mock("next/navigation", () => ({ useRouter: () => ({}), usePathname: () => "/" }));
vi.mock("@/lib/use-refresh-and-wait", () => ({ useRefreshAndWait: () => async () => "done" }));
it("手動公開の結果に反映待ちを出し、ほかの警告だけを別に載せる", async () => {
  stubControl({ ok: true, version: 7, warnings: [{ path: "delivery", message: "配信待ちの詳細" }, { path: "analytics", message: "計測を確認" }] });
  const host = await mount(<PublishPanel wid="w" site={{ id: "s", name: "サイト", activeVersion: 6 }} preview={{ ...preview, siteLevelChanged: true }} canPublish />);
  await click(button(host, "公開する"));
  expect(host.querySelector('[data-testid="publish-result"]')?.textContent).toBe(delayed);
  expect(host.textContent).toContain("analytics: 計測を確認");
  expect(host.textContent).not.toContain("配信待ちの詳細");
});
