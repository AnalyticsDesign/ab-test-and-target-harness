import { controlFetch, requireUser } from "@/lib/control";
import { loadSite, loadWorkspaces } from "@/lib/loaders";
import type { PublishPreview } from "@/lib/types";
import { PublishPanel } from "@/components/PublishPanel";

export default async function PublishPage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  await requireUser();
  const { wid, sid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  const site = (await loadSite(sid)).data;
  const preview = (await controlFetch<PublishPreview>(`/sites/${sid}/publish-preview`)).data;
  return <PublishPanel wid={wid} site={{ id: site.id, name: site.name, activeVersion: site.activeVersion }} preview={preview} canPublish={ws?.role === "owner" || ws?.role === "admin"} />;
}
