import { notFound } from "next/navigation";
import { requireUser } from "@/lib/control";
import { loadSite, loadWorkspaces } from "@/lib/loaders";
import { canManage } from "@/lib/roles";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { StaticStaleBanner } from "@/components/StaticStaleBanner";

export default async function SiteLayout({ children, params }: { children: React.ReactNode; params: Promise<{ wid: string; sid: string }> }) {
  await requireUser();
  const { wid, sid } = await params;
  const site = await loadSite(sid);
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  if (site.status !== 200 || !ws) notFound();
  const canPublish = canManage(ws.role);
  const base = `/w/${wid}/sites/${sid}`;
  return (
    <>
      <TopBar
        crumbs={[{ label: ws.name, href: `/w/${wid}` }, { label: site.data.name, href: base }]}
        publish={{ href: `${base}/publish`, activeVersion: site.data.activeVersion, hasUnpublished: site.data.hasUnpublishedChanges === true, canPublish, siteId: site.data.id }}
      />
      {site.data.activeKvStale ? <p className="banner-warn banner-full">配信ポインタが未収束です(自動で再同期します。続く場合は公開をやり直してください)</p> : null}
      {site.data.staticStale ? <StaticStaleBanner siteId={site.data.id} canRetry={canPublish} removing={site.data.staticRemoving} /> : null}
      <Content>{children}</Content>
    </>
  );
}
