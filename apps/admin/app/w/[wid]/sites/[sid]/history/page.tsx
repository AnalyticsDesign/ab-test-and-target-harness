import { controlFetch, requireUser } from "@/lib/control";
import { loadSite } from "@/lib/loaders";
import type { PublishRow } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { PublishHistory } from "@/components/PublishHistory";

export default async function HistoryPage({ params }: { params: Promise<{ sid: string }> }) {
  await requireUser();
  const { sid } = await params;
  const site = (await loadSite(sid)).data;
  const history = (await controlFetch<PublishRow[]>(`/sites/${sid}/publishes`)).data;
  return (
    <div>
      <PageHeader title="公開履歴" meta={`配信中: ${site.activeVersion ? `v${site.activeVersion}` : "未公開"}`} />
      <PublishHistory history={history} activeVersion={site.activeVersion} />
    </div>
  );
}
