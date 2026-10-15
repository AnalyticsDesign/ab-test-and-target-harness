import { controlFetch, requireUser } from "@/lib/control";
import { loadWorkspaces } from "@/lib/loaders";
import type { Audience, Goal } from "@/lib/types";
import { AudienceList } from "@/components/audience/AudienceList";

export default async function AudiencesPage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  await requireUser();
  const { wid, sid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  const audiences = (await controlFetch<Audience[]>(`/sites/${sid}/audiences`)).data;
  const goals = (await controlFetch<Goal[]>(`/sites/${sid}/goals`)).data;
  return <AudienceList wid={wid} siteId={sid} audiences={audiences} goals={goals} canEdit={ws?.role !== "viewer"} />;
}
