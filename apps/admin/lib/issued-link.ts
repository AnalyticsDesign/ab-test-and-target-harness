/**
 * 招待リンク・リセットリンクの発行結果のカード(`components/ui/IssuedCard.tsx`)の文言(backlog B47)。
 * API キーの発行結果(決定 54 (11))と同じ形で目立たせるが、移動の確認は付けない —
 * 招待リンクは招待中の一覧に出続け、リセットリンクはいつでも発行し直せるため(B47 (a)(c))。
 * その代わり、控え損ねたときの取り戻し方を notice に書く
 */
export type IssuedLinkCopy = { title: string; lead: string; notice: string };

/** 招待の結果。`extended` = 同じメール・同じロールの既存の招待の期限を延ばした(リンクは同じ。B47 (b)) */
export function invitationResultCopy({ email, deadline, extended }: { email: string; deadline: string; extended: boolean }): IssuedLinkCopy {
  if (extended)
    return {
      title: "招待の期限を延ばしました",
      lead: `${email} は既に招待済みです。同じリンクの期限を ${deadline} まで延ばしました`,
      notice: "リンクは変わっていません。まだ渡していなければ、コピーして本人に渡してください(メールは自動送信されません)。",
    };
  return {
    title: "招待リンクを発行しました",
    lead: `${email} に次のリンクを送ってください(${deadline} まで有効)`,
    notice: "メールは自動送信されません。コピーして本人に渡してください。閉じた後も、下の招待中の一覧から控えられます。",
  };
}

/** メンバーのパスワードリセットリンクの結果(非常用。一覧には残らない) */
export function resetLinkCopy(email: string): IssuedLinkCopy {
  return {
    title: "リセットリンクを発行しました",
    lead: `${email} 用のパスワードリセットリンクです。本人に渡してください`,
    notice: "1 回限り有効です。閉じたり移動したりすると二度と表示できません。控え損ねたときは、もう一度「リセットリンク」で発行し直してください。",
  };
}
