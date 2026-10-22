import { slugIdProblem } from "./slug-id";

/**
 * オーディエンス ID の候補(plan ② P7)。名前の ASCII の英数字から aud_<スラッグ>(全角の英数字は NFKC で半角に)。英数字が無ければ aud_ + 乱数。
 * 作成画面で編集でき、作成後は変えられない(control の SLUG_RE: ^[a-z0-9][a-z0-9_-]{0,63}$)。重複は control も 409 で止める
 */
const SLUG_MAX = 54; // aud_ + 54 + _NN で 64 字以内

export function audienceIdCandidate(name: string, taken: string[], random: () => string = () => Math.random().toString(36).slice(2, 8)): string {
  const slug = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, SLUG_MAX).replace(/_+$/, "");
  const base = slug ? `aud_${slug}` : `aud_${random()}`;
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) {
    const c = `${base}_${i}`;
    if (!taken.includes(c)) return c;
  }
}

/**
 * 手で直した ID の保存の前の確認(規則はエクスペリエンスと共通の lib/slug-id.ts)。
 * new は新規作成の画面(/audiences/new)と重なるので使えない(control も 422。plan ② P19)。候補 ID は aud_ で始まるので重ならない
 */
export const audienceIdProblem = slugIdProblem;
