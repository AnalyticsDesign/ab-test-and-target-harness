// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { StatusButtons } from "@/components/StatusButtons";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import { button, click, experiment, mount, stubControl, unknown } from "./publish-dialog-fixture";

vi.mock("next/navigation", () => ({ useRouter: () => ({}), usePathname: () => "/" }));

async function confirmStart() {
  const host = await mount(<ConfirmProvider><StatusButtons wid="w" siteId="s" canPublish timeZone="Asia/Tokyo" experiment={{ ...experiment, status: "draft" }} /></ConfirmProvider>);
  await click(button(host, "開始(公開して配信を始める)"));
  await click(button(host.querySelector("dialog[open]")!, "開始する"));
  return host;
}
it("confirm_dialog_failure_uses_same_text", async () => {
  const posts = stubControl({ error: "kv_put_failed", message: "保存に失敗", hint: "設定を確認" }, 409);
  const host = await confirmStart();
  expect(host.querySelector("dialog[open] [role=alert]")?.textContent).toBe("開始できませんでした(状態は変わっていません)。保存に失敗 設定を確認");
  expect(posts).toHaveLength(1);
});
it("503 の確定結果不明は確認を閉じ、POST を送り直さない", async () => {
  const posts = stubControl({ error: "publish_outcome_unknown", message: "確定結果不明" }, 503);
  const host = await confirmStart();
  expect(host.querySelector("dialog[open]")).toBeNull();
  expect(host.querySelector('[data-testid="status-result"]')?.textContent).toBe(unknown);
  expect(posts).toEqual(["/api/control/sites/s/experiments/exp/status"]);
});
