import { notFound } from "next/navigation";
import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadSite, loadWorkspaces } from "@/lib/loaders";
import type { Audience, Goal } from "@/lib/types";
import { AudienceBuilder } from "@/components/audience/AudienceBuilder";
import { PageMark } from "@/components/ui/PageMark";

export default async function AudiencePage({ params, searchParams }: { params: Promise<{ wid: string; sid: string; aid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { wid, sid, aid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  // 対象が無いときも site・一覧・目標を取りに行くが、使うのは下の notFound の判定の後だけ
  const [, workspaces, res, siteRes, audiencesRes, goalsRes] = await allInOrder([
    requireUser(),
    loadWorkspaces(),
    controlFetch<Audience>(`/sites/${sid}/audiences/${aid}`),
    loadSite(sid),
    controlFetch<Audience[]>(`/sites/${sid}/audiences`),
    controlFetch<Goal[]>(`/sites/${sid}/goals`),
  ]);
  const ws = workspaces.find((w) => w.id === wid);
  if (!ws || res.status !== 200) notFound();
  const site = siteRes.data;
  const audiences = audiencesRes.data;
  const goals = goalsRes.data;
  // key を付けない: 保存後の router.refresh() で作り直すと、保存の帯の「保存しました」が消える。画面の木は保存した値と同じなので作り直す必要が無い
  // (未保存かどうかは、refresh で届いた保存済みの値と今の値を比べて決める。AudienceBuilder の dirty)
  return (
    <>
      <PageMark path={`/w/${wid}/sites/${sid}/audiences/${aid}`} search={await searchParams} />
      <AudienceBuilder wid={wid} siteId={sid} audience={res.data} audiences={audiences} goals={goals} site={site} canEdit={ws.role !== "viewer"} />
    </>
  );
}
