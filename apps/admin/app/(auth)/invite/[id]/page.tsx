import { clientVersionHeaders, controlFetch, controlUrl } from "@/lib/control";
import { loginView } from "@/lib/login-view";
import { inviteView, invitationStatusLabel } from "@/lib/invite-view";
import type { PublicInvitation, SessionUser } from "@/lib/types";
import { AcceptInviteForm } from "./AcceptInviteForm";

/** 招待の内容は認証不要で読める(control の `GET /invitations/:id`)。サーバー側で読むので control の URL は表に出ない */
export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await fetch(`${controlUrl()}/invitations/${encodeURIComponent(id)}`, { cache: "no-store", headers: clientVersionHeaders() }).catch(() => null);
  if (!res) return <p className="error-box">control に接続できませんでした。しばらく待ってから再読み込みしてください</p>;
  if (!res.ok) return <p className="error-box">招待が見つかりません</p>;
  const inv = (await res.json()) as PublicInvitation;
  if (inv.status !== "pending") return <p className="error-box">この招待はもう使えません({invitationStatusLabel(inv.status)})</p>;
  const me = await controlFetch<SessionUser>("/me");
  const signedInEmail = me.status === 200 ? (me.data?.email ?? null) : null;
  const view = inviteView({
    invitedEmail: inv.email,
    signedInEmail,
    passwordLogin: loginView(await controlFetch<unknown>("/login-options")).passwordLogin,
  });
  return (
    <AcceptInviteForm id={id} email={inv.email} role={inv.role ?? "member"} workspaceName={inv.workspaceName} view={view} signedInEmail={signedInEmail} />
  );
}
