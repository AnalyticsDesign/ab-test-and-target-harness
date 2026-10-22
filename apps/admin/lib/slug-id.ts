/** control の SLUG_RE(apps/control/src/ids.ts)と同じ規則。変えるときは両方を一緒に */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 手で入れた ID(オーディエンス・エクスペリエンス)の保存の前の確認。空・control の SLUG_RE に合わない ID は control の 422(英語の診断)になる前に日本語で止める。
 * new は新規作成の画面(/audiences/new・/experiments/new)と重なるので使えない(control も 422。オーディエンスは plan ② P19、エクスペリエンスは B37)
 */
export function slugIdProblem(id: string): string | null {
  if (id === "") return "ID を入力してください";
  if (!SLUG_RE.test(id)) return "ID は英小文字・数字で始まり、英小文字・数字・_・- のみ、64 文字以内で入力してください";
  return id === "new" ? "new は新規作成の画面と重なるので ID に使えません" : null;
}

/** エクスペリエンスの ID(作成・複製)の確認(B37) */
export const experimentIdProblem = slugIdProblem;
