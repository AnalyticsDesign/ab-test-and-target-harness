export type InviteView = "sign-in" | "sign-in-or-password" | "accept" | "mismatch";

/** 招待ページの 4 状態。通常は「Google でログイン → 受ける」。パスワードでのアカウント作成は非常時だけ */
export function inviteView(args: { invitedEmail: string; signedInEmail: string | null; passwordLogin: boolean }): InviteView {
  if (!args.signedInEmail) return args.passwordLogin ? "sign-in-or-password" : "sign-in";
  return args.signedInEmail.toLowerCase() === args.invitedEmail.toLowerCase() ? "accept" : "mismatch";
}

const INVITATION_STATUS_JA: Record<string, string> = { pending: "承諾待ち", accepted: "承諾済み", canceled: "取り消し済み", rejected: "辞退済み", expired: "期限切れ" };

/** 招待の状態の表示。control の status は英語の識別子なので、画面には日本語で出す(未知の値はそのまま) */
export const invitationStatusLabel = (status: string): string => (Object.hasOwn(INVITATION_STATUS_JA, status) ? INVITATION_STATUS_JA[status]! : status);
