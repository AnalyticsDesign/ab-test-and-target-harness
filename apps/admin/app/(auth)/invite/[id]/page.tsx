import { controlFetch, controlRequest, requestClientIp } from "@/lib/control";
import { loginView } from "@/lib/login-view";
import { inviteView, invitationStatusLabel } from "@/lib/invite-view";
import type { PublicInvitation, SessionUser } from "@/lib/types";
import { AcceptInviteForm } from "./AcceptInviteForm";
import { PageMark } from "@/components/ui/PageMark";

/** 招待の内容は認証不要で読める(control の `GET /invitations/:id`)。サーバー側で読むので control の URL は表に出ない */
export default async function InvitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  // どの分岐でも同じ印を出す(印の無い分岐に移ると、遷移の待ち表示が打ち切りまで終わらない)
  const mark = <PageMark path={`/invite/${id}`} search={await searchParams} />;
  const res = await controlRequest(`/invitations/${encodeURIComponent(id)}`, { clientIp: await requestClientIp() });
  if (!res)
    return (
      <>
        {mark}
        <p className="error-box">control に接続できませんでした。しばらく待ってから再読み込みしてください</p>
      </>
    );
  if (!res.ok)
    return (
      <>
        {mark}
        <p className="error-box">招待が見つかりません</p>
      </>
    );
  const inv = (await res.json()) as PublicInvitation;
  if (inv.status !== "pending")
    return (
      <>
        {mark}
        <p className="error-box">この招待はもう使えません({invitationStatusLabel(inv.status)})</p>
      </>
    );
  const me = await controlFetch<SessionUser>("/me");
  const signedInEmail = me.status === 200 ? (me.data?.email ?? null) : null;
  const view = inviteView({
    invitedEmail: inv.email,
    signedInEmail,
    passwordLogin: loginView(await controlFetch<unknown>("/login-options")).passwordLogin,
  });
  return (
    <>
      {mark}
      <AcceptInviteForm id={id} email={inv.email} role={inv.role ?? "member"} workspaceName={inv.workspaceName} view={view} signedInEmail={signedInEmail} />
    </>
  );
}
