import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, vi } from "vitest";
import type { Experiment, PublishPreview } from "@/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
export const experiment: Experiment = {
  id: "exp", siteId: "s", kind: "test", name: "見出し", status: "running", publishedStatus: "running",
  urlMatch: { include: [{ page: { op: "equals", value: "/" } }] }, targeting: null, trafficPercentage: 100,
  persistAssignment: false, analytics: null, description: "", createdBy: "u", updatedBy: "u",
  createdAt: 1, updatedAt: 2, unpublished: false, runId: null,
  variants: [
    { id: "a", name: "A", weight: 50, original: true, description: "", analytics: null, changes: [] },
    { id: "b", name: "B", weight: 50, original: false, description: "", analytics: null, changes: [] },
  ],
};
export const preview: PublishPreview = {
  digest: "d", transitionDigest: "d", siteLevelChanged: false, lastActivatedAt: null, experiments: [],
  audienceChanges: [], droppedPageConditions: [], viewportExperiments: [], overlaps: [], compileError: null,
};
export const delayed = "公開は確定しました。配信への反映は遅れています(自動で反映します)";
export const unknown = "公開の結果を確かめられませんでした。画面を読み込み直して、公開履歴と状態を確かめてください";

let clean: (() => void) | undefined;
afterEach(() => { clean?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });
export async function mount(element: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  clean = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => { root.render(element); });
  return host;
}
export function button(host: Element, label: string) {
  const b = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!b) throw new Error(`「${label}」ボタンがありません: ${host.textContent}`);
  return b;
}
export const click = (node: HTMLElement) => act(async () => { node.click(); });

export function stubControl(reply: unknown, status = 200) {
  const posts: string[] = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    if (init.method === "POST") {
      posts.push(path);
      if (path.endsWith("/duplicate")) return Response.json({ id: "copy" });
      return Response.json(reply, { status });
    }
    if (path.includes("/publish-preview")) return Response.json(preview);
    if (path.endsWith("/evaluation-plan")) return Response.json({ plan: null });
    if (path.endsWith("/results")) return Response.json(null);
    throw new Error(`想定外の取得 ${path}`);
  });
  return posts;
}
