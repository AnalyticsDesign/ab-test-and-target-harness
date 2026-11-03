import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadSite } from "@/lib/loaders";
import type { PublishRow } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { PublishHistory } from "@/components/PublishHistory";
import { PageMark } from "@/components/ui/PageMark";

export default async function HistoryPage({ params, searchParams }: { params: Promise<{ wid: string; sid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { wid, sid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  const [, siteRes, historyRes] = await allInOrder([requireUser(), loadSite(sid), controlFetch<PublishRow[]>(`/sites/${sid}/publishes`)]);
  const site = siteRes.data;
  const history = historyRes.data;
  return (
    <div>
      <PageMark path={`/w/${wid}/sites/${sid}/history`} search={await searchParams} />
      <PageHeader title="公開履歴" meta={`配信中: ${site.activeVersion ? `v${site.activeVersion}` : "未公開"}`} />
      <PublishHistory history={history} activeVersion={site.activeVersion} />
    </div>
  );
}
