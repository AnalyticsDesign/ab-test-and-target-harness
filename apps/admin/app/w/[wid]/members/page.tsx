import { notFound } from "next/navigation";
import { controlFetch, requireUser } from "@/lib/control";
import { loadCapabilities, loadWorkspaces } from "@/lib/loaders";
import { shouldShowResetLink } from "@/lib/capabilities";
import { canManage } from "@/lib/roles";
import type { Invitation, Member } from "@/lib/types";
import { MembersPanel } from "@/components/MembersPanel";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";

/** メンバーと招待。メンバーの API キーは独立した画面(`/w/:wid/api-keys`。決定 54 (6)) */
export default async function MembersPage({ params }: { params: Promise<{ wid: string }> }) {
  const me = await requireUser();
  const { wid } = await params;
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  if (!ws) notFound();
  const crumbs = [{ label: ws.name, href: `/w/${wid}` }, { label: "メンバー" }];
  if (!canManage(ws.role)) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <Content>
          <p className="error-box">メンバーの管理は管理者以上が行います</p>
        </Content>
      </>
    );
  }
  const [members, invitations] = await Promise.all([
    controlFetch<Member[]>(`/workspaces/${wid}/members`).then((r) => r.data),
    controlFetch<Invitation[]>(`/workspaces/${wid}/invitations`).then((r) => r.data),
  ]);
  // 決定 46: パスワードログインが閉じていればリセットリンクは発行できない(control が 409)ので、ボタン自体を出さない
  const caps = await loadCapabilities();
  return (
    <>
      <TopBar crumbs={crumbs} />
      <Content>
        <MembersPanel
          workspaceId={wid}
          myRole={ws.role}
          myUserId={me.id}
          members={members}
          invitations={invitations.filter((i) => i.status === "pending")}
          canIssueResetLink={shouldShowResetLink(caps)}
          amInstanceAdmin={me.instanceAdmin === true}
        />
      </Content>
    </>
  );
}
