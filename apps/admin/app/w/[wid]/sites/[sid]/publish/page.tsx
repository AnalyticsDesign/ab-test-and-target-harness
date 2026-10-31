import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadSite, loadWorkspaces } from "@/lib/loaders";
import type { PublishPreview } from "@/lib/types";
import { PublishPanel } from "@/components/PublishPanel";

export default async function PublishPage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  const { wid, sid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  const [, workspaces, siteRes, previewRes] = await allInOrder([
    requireUser(),
    loadWorkspaces(),
    loadSite(sid),
    controlFetch<PublishPreview>(`/sites/${sid}/publish-preview`),
  ]);
  const ws = workspaces.find((w) => w.id === wid);
  const site = siteRes.data;
  const preview = previewRes.data;
  return <PublishPanel wid={wid} site={{ id: site.id, name: site.name, activeVersion: site.activeVersion }} preview={preview} canPublish={ws?.role === "owner" || ws?.role === "admin"} />;
}
