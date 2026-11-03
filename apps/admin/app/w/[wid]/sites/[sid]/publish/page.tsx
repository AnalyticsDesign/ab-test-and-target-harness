import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadSite, loadWorkspaces } from "@/lib/loaders";
import type { PublishPreview } from "@/lib/types";
import { PublishPanel } from "@/components/PublishPanel";
import { PageMark } from "@/components/ui/PageMark";

export default async function PublishPage({ params, searchParams }: { params: Promise<{ wid: string; sid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  return (
    <>
      <PageMark path={`/w/${wid}/sites/${sid}/publish`} search={await searchParams} />
      <PublishPanel wid={wid} site={{ id: site.id, name: site.name, activeVersion: site.activeVersion }} preview={preview} canPublish={ws?.role === "owner" || ws?.role === "admin"} />
    </>
  );
}
