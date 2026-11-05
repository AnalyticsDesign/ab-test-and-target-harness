import { notFound } from "next/navigation";
import { requireUser } from "@/lib/control";
import { parseAuditFilter } from "@/lib/audit-log";
import { loadAuditFirstPage } from "@/lib/audit-log-server";
import { allInOrder, loadWorkspaces } from "@/lib/loaders";
import { AuditLogPanel } from "@/components/audit/AuditLogPanel";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageMark } from "@/components/ui/PageMark";

/**
 * 設定 > ワークスペース > 操作の記録(B129 spec §7.2)。管理者以上だけ(メニューの入口も管理者以上だけ。lib/nav.ts)。
 * 要求(spec §10.2・§10.6): layout の 3 本(/me・/capabilities・/workspaces/summary)+ `/workspaces/:wid/audit-events` の 1 本。
 * ワークスペースの一覧は loadWorkspaces(summary から作る)で、`/workspaces` を直接読まない。3 つは互いに依らないので allInOrder で並べる
 * (権限は control の 403 で判定する。使用状況・システム管理者の画面と同じ)
 */
export default async function WorkspaceAuditEventsPage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { wid } = await params;
  const search = await searchParams;
  const mark = <PageMark path={`/w/${wid}/audit-events`} search={search} />;
  const filter = parseAuditFilter(search);
  const apiPath = `/workspaces/${wid}/audit-events`;
  const [, workspaces, first] = await allInOrder([requireUser(), loadWorkspaces(), loadAuditFirstPage(apiPath, filter)]);
  const ws = workspaces.find((w) => w.id === wid);
  if (!ws) notFound();
  return (
    <>
      {mark}
      <TopBar crumbs={[{ label: ws.name, href: `/w/${wid}` }, { label: "操作の記録" }]} scope={{ wid, sid: null }} />
      <Content>
        <PageHeader title="操作の記録" />
        {first.status === 200 && first.data ? (
          <>
            <p className="muted">このワークスペースでの、メンバー・招待・API キー・サイト・エクスペリエンスの操作の記録です。記録は 365 日残ります。</p>
            {/* 読んだ引数ごとに作り直す(パネルは props を状態の初期値として 1 回だけ取るので、同じ画面への移動・戻る・進むでサーバーが読み直した表と絞り込みに揃える) */}
            <AuditLogPanel key={`${apiPath}?${first.query}`} scope="workspace" apiPath={apiPath} initialFilter={filter} initialQuery={first.query} initialPage={first.data} />
          </>
        ) : first.status === 403 ? (
          <p className="error-box">この画面はワークスペースの管理者以上だけが開けます</p>
        ) : (
          <p className="error-box">操作の記録を取得できませんでした(HTTP {first.status})。時間をおいて開き直してください</p>
        )}
      </Content>
    </>
  );
}
