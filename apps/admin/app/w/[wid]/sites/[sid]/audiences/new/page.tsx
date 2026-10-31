import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadSite, loadWorkspaces } from "@/lib/loaders";
import type { Audience, Goal } from "@/lib/types";
import { AudienceBuilder } from "@/components/audience/AudienceBuilder";

export default async function NewAudiencePage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  const { wid, sid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  const [, workspaces, siteRes, audiencesRes, goalsRes] = await allInOrder([
    requireUser(),
    loadWorkspaces(),
    loadSite(sid),
    controlFetch<Audience[]>(`/sites/${sid}/audiences`),
    controlFetch<Goal[]>(`/sites/${sid}/goals`),
  ]);
  const ws = workspaces.find((w) => w.id === wid);
  const site = siteRes.data;
  const audiences = audiencesRes.data;
  const goals = goalsRes.data;
  return <AudienceBuilder wid={wid} siteId={sid} audience={null} audiences={audiences} goals={goals} site={site} canEdit={ws?.role !== "viewer"} />;
}
