import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/control";
import { loadSites, loadWorkspaces } from "@/lib/loaders";
import { canManage, roleLabel } from "@/lib/roles";
import type { Site } from "@/lib/types";
import { NewSiteDisclosure } from "@/components/NewSiteDisclosure";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function WorkspacePage({ params }: { params: Promise<{ wid: string }> }) {
  await requireUser();
  const { wid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  const sites = await loadSites(wid);
  if (!ws || sites.status !== 200) notFound();
  const canAdmin = canManage(ws.role);
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
          <NewSiteDisclosure workspaceId={wid} defaultOpen={sites.data.length === 0} title="サイト一覧" meta={meta} />
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
                    <Link href={`/w/${wid}/sites/${s.id}`}>{s.name}</Link>
                  </td>
                  <td>
                    <code>{s.id}</code>
                  </td>
                  <td>{s.domain}</td>
                  <td>{s.mode === "B" ? "D-lite" : s.idSource === "ab" ? "A" : "C"}</td>
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
