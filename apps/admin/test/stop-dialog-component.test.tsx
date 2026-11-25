// @vitest-environment happy-dom
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { StopDialog, StopNotices } from "@/components/experiment/StopDialog";
import type { StopMessage } from "@/lib/stop-dialog";
import { navigateDocument } from "@/lib/navigate";
import { button, click, delayed, experiment, mount, stubControl, unknown } from "./publish-dialog-fixture";

vi.mock("@/lib/navigate", async (original) => ({ ...await original<typeof import("@/lib/navigate")>(), navigateDocument: vi.fn(() => ({ kind: "none" })) }));
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn(async () => "done") }));
vi.mock("@/lib/use-refresh-and-wait", () => ({ useRefreshAndWait: () => refresh }));

function Stop() {
  const [result, setResult] = useState<{ messages: StopMessage[]; created: string | null }>();
  return result ? <StopNotices {...result} /> : <StopDialog wid="w" siteId="s" experiment={experiment} timeZone="Asia/Tokyo" mode="stop" report={null} initialVariantId="b" onClose={() => setResult({ messages: [], created: null })} onDone={(messages, created) => setResult({ messages, created })} />;
}
it("配信の反映待ちと作成した下書きは、知らせを読んでから開ける", async () => {
  vi.useFakeTimers();
  const posts = stubControl({ publish: { ok: true, version: 7, warnings: [{ path: "delivery", message: "遅れ" }] } });
  const host = await mount(<Stop />);
  await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button(host, "終了して記録"));
  // BusyScope が書き込み直後に残す覆いが消えるまで待つ。
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(posts).toHaveLength(2);
  expect(host.querySelector("dialog[open]")?.textContent).toContain(delayed);
  expect(host.textContent).not.toContain("反映しました");
  expect(posts).toEqual(["/api/control/sites/s/experiments/exp/status", "/api/control/sites/s/experiments/exp/duplicate"]);
  expect(navigateDocument).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  await click(button(host, "下書きを開く"));
  expect(navigateDocument).toHaveBeenCalledWith("/w/w/sites/s/experiments/copy");
});
it("終了の 503 はダイアログを閉じ、複製も再送もしない", async () => {
  const posts = stubControl({ error: "publish_outcome_unknown", message: "確定結果不明" }, 503);
  const host = await mount(<Stop />);
  await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button(host, "終了して記録"));
  expect(host.querySelector("dialog[open]")).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(unknown);
  expect(posts).toEqual(["/api/control/sites/s/experiments/exp/status"]);
});
