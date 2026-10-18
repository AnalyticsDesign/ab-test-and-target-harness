import { controlFetch, requireUser } from "@/lib/control";
import { loadSite, loadWorkspaces } from "@/lib/loaders";
import type { Goal } from "@/lib/types";
import { GoalsPanel } from "@/components/GoalsPanel";

export default async function GoalsPage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  await requireUser();
  const { wid, sid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  const goals = (await controlFetch<Goal[]>(`/sites/${sid}/goals`)).data;
  // 目標名のキー名と出力プレビューに、サイトの外部計測の設定を使う
  const site = (await loadSite(sid)).data;
  return <GoalsPanel siteId={sid} goals={goals} canEdit={ws?.role !== "viewer"} names={site.analytics} />;
}
