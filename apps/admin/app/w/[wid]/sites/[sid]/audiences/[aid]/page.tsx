import { notFound } from "next/navigation";
import { controlFetch, requireUser } from "@/lib/control";
import { loadSite, loadWorkspaces } from "@/lib/loaders";
import type { Audience, Goal } from "@/lib/types";
import { AudienceBuilder } from "@/components/audience/AudienceBuilder";

export default async function AudiencePage({ params }: { params: Promise<{ wid: string; sid: string; aid: string }> }) {
  await requireUser();
  const { wid, sid, aid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  const res = await controlFetch<Audience>(`/sites/${sid}/audiences/${aid}`);
  if (!ws || res.status !== 200) notFound();
  const site = (await loadSite(sid)).data;
  const audiences = (await controlFetch<Audience[]>(`/sites/${sid}/audiences`)).data;
  const goals = (await controlFetch<Goal[]>(`/sites/${sid}/goals`)).data;
  // key を付けない: 保存後の router.refresh() で作り直すと「保存しました」の通知が消える。画面の木は保存した値と同じなので作り直す必要が無い
  return <AudienceBuilder wid={wid} siteId={sid} audience={res.data} audiences={audiences} goals={goals} site={site} canEdit={ws.role !== "viewer"} />;
}
