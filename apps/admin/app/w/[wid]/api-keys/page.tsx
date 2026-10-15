import { notFound } from "next/navigation";
import { controlFetch, requireUser } from "@/lib/control";
import { loadWorkspaces } from "@/lib/loaders";
import { canManage } from "@/lib/roles";
import type { WorkspaceApiKey } from "@/lib/types";
import { WorkspaceApiKeysPanel } from "@/components/WorkspaceApiKeysPanel";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";

/** メンバーの API キー(決定 54 (6)、決定 48 (8) の一覧)。メンバー画面の下から独立させた。管理者以上だけ */
export default async function WorkspaceApiKeysPage({ params }: { params: Promise<{ wid: string }> }) {
  const me = await requireUser();
  const { wid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  if (!ws) notFound();
  const crumbs = [{ label: ws.name, href: `/w/${wid}` }, { label: "メンバーの API キー" }];
  if (!canManage(ws.role)) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <Content>
          <p className="error-box">メンバーの API キーは管理者以上が見られます</p>
        </Content>
      </>
    );
  }
  const keys = await controlFetch<WorkspaceApiKey[]>(`/workspaces/${wid}/api-keys`);
  return (
    <>
      <TopBar crumbs={crumbs} />
      <Content>
        <PageHeader title="メンバーの API キー" />
        {keys.status === 200 ? (
          <WorkspaceApiKeysPanel workspaceId={wid} myRole={ws.role} amInstanceAdmin={me.instanceAdmin === true} keys={keys.data} />
        ) : (
          <p className="error-box">メンバーの API キーを取得できませんでした(HTTP {keys.status})。時間をおいて開き直してください</p>
        )}
      </Content>
    </>
  );
}
