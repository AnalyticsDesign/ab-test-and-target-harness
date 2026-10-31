import { AppLink } from "@/components/ui/AppLink";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/control";
import { allInOrder, loadSites, loadWorkspaces, requireSummary } from "@/lib/loaders";
import { canManage, roleLabel } from "@/lib/roles";
import type { Site } from "@/lib/types";
import { NewSiteDisclosure } from "@/components/NewSiteDisclosure";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function WorkspacePage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)
  const [, workspaces, sites, summary] = await allInOrder([requireUser(), loadWorkspaces(), loadSites(wid), requireSummary()]);
  const ws = workspaces.find((w) => w.id === wid);
  if (!ws || sites.status !== 200) notFound();
  const canAdmin = canManage(ws.role);
  // B102: Free の 1 日の上限はアカウント全体で、この導入のすべてのサイトが分け合うので、新しいサイトのフォームで知らせる。
  // 数えるのは呼ぶ人に見えるサイト(全ワークスペース)。概要は loadWorkspaces と同じ結果(取れなければ画面全体のエラー)
  const visibleSites = summary.reduce((n, w) => n + w.sites.length, 0);
  const meta = (
    <>
      {ws.name} · <span className="badge">{roleLabel(ws.role)}</span>
    </>
  );
  return (
    <>
      <TopBar crumbs={[{ label: ws.name, href: `/w/${wid}` }, { label: "サイト一覧" }]} />
      <Content>
        {canAdmin ? (
          <NewSiteDisclosure workspaceId={wid} defaultOpen={sites.data.length === 0} title="サイト一覧" meta={meta} visibleSites={visibleSites} />
        ) : (
          <>
            <PageHeader title="サイト一覧" meta={meta} />
            <p className="muted">サイトの作成は管理者以上が行います</p>
          </>
        )}
        <div className="card-flush">
          <table>
            <thead>
              <tr>
                <th>名前</th>
                <th>サイト ID</th>
                <th>ドメイン</th>
                <th>モード</th>
                <th>配信中の版</th>
              </tr>
            </thead>
            <tbody>
              {sites.data.map((s: Site) => (
                <tr key={s.id}>
                  <td>
                    <AppLink href={`/w/${wid}/sites/${s.id}`}>{s.name}</AppLink>
                  </td>
                  <td>
                    <code>{s.id}</code>
                  </td>
                  <td>{s.domain}</td>
                  <td>{s.mode === "B" ? "B" : s.idSource === "ab" ? "A" : "C"}</td>
                  <td>{s.activeVersion ?? "未公開"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Content>
    </>
  );
}
