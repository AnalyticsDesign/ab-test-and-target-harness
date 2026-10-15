/**
 * 招待の期限までの残りを 1 行にする(招待一覧の「期限」列)。端数は切り捨て。
 * 1 日以上 = 「あと N 日 M 時間」(M が 0 なら「あと N 日」)/ 1 時間以上 = 「あと N 時間」/
 * それ未満 = 「あと 1 時間未満」/ 切れていれば「期限切れ」。
 * 時刻は epoch ミリ秒(Global Constraints)。`now` を引数に取るのは、サーバー側の描画で `Date.now()` を焼き込むと
 * ハイドレーションで食い違うため — 呼ぶ側(クライアント)が自分の時計を渡す
 */
export function expiryLabel(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "期限切れ";
  const hours = Math.floor(left / 3_600_000);
  // 1 日以上あるときは時間の端数も出す(発行直後の招待が「あと 6 日」とだけ出ると、7 日間有効という案内とずれて見える)
  if (hours >= 24) return hours % 24 === 0 ? `あと ${hours / 24} 日` : `あと ${Math.floor(hours / 24)} 日 ${hours % 24} 時間`;
  if (hours >= 1) return `あと ${hours} 時間`;
  return "あと 1 時間未満";
}
