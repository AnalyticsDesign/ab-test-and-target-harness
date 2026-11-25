import { notFound } from "next/navigation";
import { requireUser } from "@/lib/control";
import { allInOrder, loadSite, loadWorkspaces } from "@/lib/loaders";
import { kvStaleBannerText } from "@/lib/kv-stale-banner";
import { canManage } from "@/lib/roles";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { StaticStaleBanner } from "@/components/StaticStaleBanner";
import { SiteChromeGuard } from "@/components/ui/SiteChromeGuard";

export default async function SiteLayout({ children, params }: { children: React.ReactNode; params: Promise<{ wid: string; sid: string }> }) {
  const { wid, sid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  const [, site, workspaces] = await allInOrder([requireUser(), loadSite(sid), loadWorkspaces()]);
  const ws = workspaces.find((w) => w.id === wid);
  if (site.status !== 200 || !ws) notFound();
  const canPublish = canManage(ws.role);
  const base = `/w/${wid}/sites/${sid}`;
  return (
    <>
      {/* 読み込み中の枠が別のサイトで覚えた上部バーを出さないよう、今の URL のサイトと照らす(SiteChromeGuard のコメント) */}
      <SiteChromeGuard wid={wid} sid={sid}>
        <TopBar
          scope={{ wid, sid }}
          crumbs={[{ label: ws.name, href: `/w/${wid}` }, { label: site.data.name, href: base }]}
          publish={{ href: `${base}/publish`, activeVersion: site.data.activeVersion, hasUnpublished: site.data.hasUnpublishedChanges === true, canPublish, siteId: site.data.id, historyHref: `${base}/history` }}
        />
        {site.data.activeKvStale ? <p className="banner-warn banner-full">{kvStaleBannerText(site.data.activeKvStaleReason)}</p> : null}
        {site.data.staticStale ? <StaticStaleBanner siteId={site.data.id} canRetry={canPublish} removing={site.data.staticRemoving} mismatch={site.data.staticMismatch === true} /> : null}
      </SiteChromeGuard>
      <Content>{children}</Content>
    </>
  );
}
