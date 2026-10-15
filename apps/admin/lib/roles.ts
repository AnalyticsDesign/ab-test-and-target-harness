// apps/admin/lib/roles.ts — Role の順位(control の roles.ts と同じ並び)。表示・選択肢の絞り込みにだけ使い、認可は control が行う
import type { Role, Workspace } from "./types";

export const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

/** 画面に出すロールの名前(決定 54 (1)。GA と同じ語)。ロールの表示は必ずこれを通す(`.toUpperCase()` しない) */
export const ROLE_JA: Record<Role, string> = { owner: "オーナー", admin: "管理者", editor: "編集者", viewer: "閲覧者" };

/** 未知の文字列(古いデータ・候補の一覧の role: string)はそのまま返す */
export const roleLabel = (role: string): string => (Object.hasOwn(ROLE_JA, role) ? ROLE_JA[role as Role] : role);

/** メンバー・招待・メンバーの API キーを扱えるか(管理者以上。認可は control が行い、ここは表示の出し分けだけ) */
export const canManage = (role: Role): boolean => ROLE_RANK[role] >= ROLE_RANK.admin;

/** 本人が持つ最高位の Role(どの Workspace にも属していなければ null)。API キーの権限の上限はこれと同等かそれ以下だけ選べる(control も同じ判定で 400 を返す) */
export function highestRole(workspaces: Workspace[]): Role | null {
  let best: Role | null = null;
  for (const w of workspaces) if (!best || ROLE_RANK[w.role] > ROLE_RANK[best]) best = w.role;
  return best;
}
