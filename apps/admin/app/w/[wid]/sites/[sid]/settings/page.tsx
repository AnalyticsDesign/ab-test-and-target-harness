import { notFound } from "next/navigation";
import { controlFetch, requireUser } from "@/lib/control";
import { countExperimentsForResults } from "@/lib/results-settings";
import type { Experiment } from "@/lib/types";
import { loadCapabilities, loadSite, loadWorkspaces } from "@/lib/loaders";
import { pickParam } from "@/lib/url-state";
import { PageHeader } from "@/components/ui/PageHeader";
import { SECTION_IDS } from "@/components/settings/sections";
import { SiteSettingsForm } from "@/components/settings/SiteSettingsForm";
import { sharingNoticeFor } from "@/components/settings/sharing-notice";
import { PageMark } from "@/components/ui/PageMark";

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ wid: string; sid: string }>; searchParams: Promise<{ section?: string | string[]; sharing?: string | string[] }> }) {
  await requireUser();
  const { wid, sid } = await params;
  const site = await loadSite(sid);
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  if (site.status !== 200 || !ws) notFound();
  const caps = await loadCapabilities();
  // 結果の記録を切り替えるときの確認に使う件数。一覧が取れなければ 0 件(確認を出さないだけで、保存の可否は control が決める)
  const list = await controlFetch<Experiment[]>(`/sites/${sid}/experiments`);
  const counts = countExperimentsForResults(list.status === 200 ? list.data : []);
  const query = await searchParams;
  const initialSection = pickParam(query.section, SECTION_IDS, "general");
  // B139: 作成で衝突を避けたとき、作成の画面が ?sharing= を付けてここへ遷移する。サイトの今の値と合うときだけ知らせる
  const sharingAdjusted = sharingNoticeFor(query.sharing, site.data);
  return (
    <div>
      <PageMark path={`/w/${wid}/sites/${sid}/settings`} search={query} />
      <PageHeader title="サイト設定" meta={site.data.name} />
      {/* key: 別のサイトの設定へ移る(設定のメニューの切り替えの枠など)と、同じ部品が使い回されて前のサイトの入力の state が残るので、サイトごとに作り直す */}
      <SiteSettingsForm key={site.data.id} site={site.data} canAdmin={ws.role === "owner" || ws.role === "admin"} canDelete={ws.role === "owner"} tagOrigin={caps.tagOrigin} initialSection={initialSection} resultsStore={caps.resultsStore} edgeOrigin={caps.edgeOrigin} runningTests={counts.runningTests} runningRecordedTests={counts.runningRecordedTests} sharingAdjusted={sharingAdjusted} />
    </div>
  );
}
