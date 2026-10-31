import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadSite, loadWorkspaces } from "@/lib/loaders";
import type { Goal } from "@/lib/types";
import { GoalsPanel } from "@/components/GoalsPanel";

export default async function GoalsPage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  const { wid, sid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  // site は目標名のキー名と出力プレビューに使う(サイトの外部計測の設定)
  const [, workspaces, goalsRes, siteRes] = await allInOrder([requireUser(), loadWorkspaces(), controlFetch<Goal[]>(`/sites/${sid}/goals`), loadSite(sid)]);
  const ws = workspaces.find((w) => w.id === wid);
  const goals = goalsRes.data;
  const site = siteRes.data;
  return <GoalsPanel siteId={sid} goals={goals} canEdit={ws?.role !== "viewer"} names={site.analytics} />;
}
