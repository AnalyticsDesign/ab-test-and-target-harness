import { notFound } from "next/navigation";
import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadCapabilities, loadWorkspaces, requireSummary } from "@/lib/loaders";
import { memberScopeText } from "@/lib/member-scope";
import { shouldShowResetLink } from "@/lib/capabilities";
import { canManage } from "@/lib/roles";
import type { Invitation, Member } from "@/lib/types";
import { MembersPanel } from "@/components/MembersPanel";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageMark } from "@/components/ui/PageMark";

/** メンバーと招待。メンバーの API キーは独立した画面(`/w/:wid/api-keys`。決定 54 (6)) */
export default async function MembersPage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { wid } = await params;
  const mark = <PageMark path={`/w/${wid}/members`} search={await searchParams} />;
  // 互いに依らない取得は並べて読む(allInOrder。失敗は並べた順に判定するので、未ログインは今までどおりログインへ)。
  // メンバー・招待は下の権限の判定の後で取る(管理者でない人の分は取らない)
  const [me, workspaces] = await allInOrder([requireUser(), loadWorkspaces()]);
  const ws = workspaces.find((w) => w.id === wid);
  if (!ws) notFound();
  const crumbs = [{ label: ws.name, href: `/w/${wid}` }, { label: "メンバー" }];
  if (!canManage(ws.role)) {
    return (
      <>
        {mark}
        <TopBar crumbs={crumbs} scope={{ wid, sid: null }} />
        <Content>
          <p className="error-box">メンバーの管理は管理者以上が行います</p>
        </Content>
      </>
    );
  }
  // 決定 46: パスワードログインが閉じていればリセットリンクは発行できない(control が 409)ので、ボタン自体を出さない(caps)。
  // ロールが効く範囲(同じワークスペースのサイト名)は layout と同じ summary を共有する(React の cache で control への要求は増えない)。
  // 取れなかったときは例外で画面全体のエラーにする(空の一覧にすると「まだサイトがありません」と偽の文を出してしまう)
  const [members, invitations, caps, summary] = await allInOrder([
    controlFetch<Member[]>(`/workspaces/${wid}/members`).then((r) => r.data),
    controlFetch<Invitation[]>(`/workspaces/${wid}/invitations`).then((r) => r.data),
    loadCapabilities(),
    requireSummary(),
  ]);
  const siteNames = (summary.find((w) => w.id === wid)?.sites ?? []).map((s) => s.name);
  return (
    <>
      {mark}
      <TopBar crumbs={crumbs} scope={{ wid, sid: null }} />
      <Content>
        <MembersPanel
          workspaceId={wid}
          myRole={ws.role}
          myUserId={me.id}
          members={members}
          invitations={invitations.filter((i) => i.status === "pending")}
          canIssueResetLink={shouldShowResetLink(caps)}
          amInstanceAdmin={me.instanceAdmin === true}
          scopeText={memberScopeText(siteNames)}
        />
      </Content>
    </>
  );
}
