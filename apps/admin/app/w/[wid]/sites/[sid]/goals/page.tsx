import { controlFetch, requireUser } from "@/lib/control";
import { loadWorkspaces } from "@/lib/loaders";
import type { Goal } from "@/lib/types";
import { GoalsPanel } from "@/components/GoalsPanel";

export default async function GoalsPage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  await requireUser();
  const { wid, sid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  const goals = (await controlFetch<Goal[]>(`/sites/${sid}/goals`)).data;
  return <GoalsPanel siteId={sid} goals={goals} canEdit={ws?.role !== "viewer"} />;
}
