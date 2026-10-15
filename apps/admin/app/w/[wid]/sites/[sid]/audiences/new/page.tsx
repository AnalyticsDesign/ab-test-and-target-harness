import { controlFetch, requireUser } from "@/lib/control";
import { loadSite, loadWorkspaces } from "@/lib/loaders";
import type { Audience, Goal } from "@/lib/types";
import { AudienceBuilder } from "@/components/audience/AudienceBuilder";

export default async function NewAudiencePage({ params }: { params: Promise<{ wid: string; sid: string }> }) {
  await requireUser();
  const { wid, sid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  const site = (await loadSite(sid)).data;
  const audiences = (await controlFetch<Audience[]>(`/sites/${sid}/audiences`)).data;
  const goals = (await controlFetch<Goal[]>(`/sites/${sid}/goals`)).data;
  return <AudienceBuilder wid={wid} siteId={sid} audience={null} audiences={audiences} goals={goals} site={site} canEdit={ws?.role !== "viewer"} />;
}
