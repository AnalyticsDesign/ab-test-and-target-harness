import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadWorkspaces } from "@/lib/loaders";
import type { Audience, Goal } from "@/lib/types";
import { AudienceList } from "@/components/audience/AudienceList";

export default async function AudiencesPage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  const { wid, sid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  const [, workspaces, audiencesRes, goalsRes] = await allInOrder([
    requireUser(),
    loadWorkspaces(),
    controlFetch<Audience[]>(`/sites/${sid}/audiences`),
    controlFetch<Goal[]>(`/sites/${sid}/goals`),
  ]);
  const ws = workspaces.find((w) => w.id === wid);
  const audiences = audiencesRes.data;
  const goals = goalsRes.data;
  return <AudienceList wid={wid} siteId={sid} audiences={audiences} goals={goals} canEdit={ws?.role !== "viewer"} />;
}
