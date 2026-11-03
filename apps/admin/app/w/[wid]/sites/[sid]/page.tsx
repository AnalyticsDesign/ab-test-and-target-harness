import { AppLink } from "@/components/ui/AppLink";
import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadSite, loadWorkspaces } from "@/lib/loaders";
import type { Experiment, PublishRow } from "@/lib/types";
import { STATUS_FILTERS } from "@/lib/experiment-filter";
import { pickParam } from "@/lib/url-state";
import { ExperimentList } from "@/components/ExperimentList";
import { LocalTime } from "@/components/LocalTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { Icon } from "@/components/ui/Icon";
import { PageMark } from "@/components/ui/PageMark";

/** Site 概要 = 実験の一覧 + 作成リンク + 公開状況の要約(Site ナビ・未公開バナーは親の layout.tsx が担う) */
export default async function SitePage({ params, searchParams }: { params: Promise<{ wid: string; sid: string }>; searchParams: Promise<{ status?: string | string[] }> }) {
  const { wid, sid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  const [, workspaces, siteRes, experimentsRes, publishesRes] = await allInOrder([
    requireUser(),
    loadWorkspaces(),
    loadSite(sid),
    controlFetch<Experiment[]>(`/sites/${sid}/experiments`),
    controlFetch<PublishRow[]>(`/sites/${sid}/publishes`),
  ]);
  const ws = workspaces.find((w) => w.id === wid);
  const site = siteRes.data;
  const experiments = experimentsRes.data;
  const publishes = publishesRes.data;
  const canEdit = ws?.role !== "viewer";
  const canPublish = ws?.role === "owner" || ws?.role === "admin";
  const search = await searchParams;
  const initialFilter = pickParam(search.status, STATUS_FILTERS, "all");
  // publishes の行は activate に成功した記録として `active` のまま残り続ける(status では絞れない。review 指摘)。
  // 「いま配信中」の行は site.activeVersion と version が一致する 1 行だけ
  const latest = publishes.find((p) => p.version === site.activeVersion);
  return (
    <div>
      <PageMark path={`/w/${wid}/sites/${sid}`} search={search} />
      <PageHeader
        title="エクスペリエンス"
        meta={
          <>
            配信中: {site.activeVersion ? <>v{site.activeVersion}({latest ? <LocalTime at={latest.activatedAt ?? latest.createdAt} /> : null})</> : "未公開"} /
            訪問者のブラウザには 1 分ほどで届きます
          </>
        }
        actions={
          canEdit ? (
            <AppLink className="btn btn-primary" href={`/w/${wid}/sites/${sid}/experiments/new`}>
              <Icon name="plus" /> 新しいエクスペリエンス
            </AppLink>
          ) : null
        }
      />
      <ExperimentList wid={wid} sid={sid} experiments={experiments} canPublish={canPublish} initialFilter={initialFilter} />
    </div>
  );
}
