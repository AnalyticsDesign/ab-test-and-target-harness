import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadWorkspaces } from "@/lib/loaders";
import type { Audience, Goal } from "@/lib/types";
import { AudienceList } from "@/components/audience/AudienceList";
import { PageMark } from "@/components/ui/PageMark";

export default async function AudiencesPage({ params, searchParams }: { params: Promise<{ wid: string; sid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  return (
    <>
      <PageMark path={`/w/${wid}/sites/${sid}/audiences`} search={await searchParams} />
      <AudienceList wid={wid} siteId={sid} audiences={audiences} goals={goals} canEdit={ws?.role !== "viewer"} />
    </>
  );
}
