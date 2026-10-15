import { roleLabel } from "./roles";
import type { InstanceAdmin } from "./types";

/**
 * 「システム管理者から外す」の確認の本文(B46)。外すと、システム管理者になる前に参加していたワークスペースでは元のロールに戻り、
 * それ以外のワークスペースからは外れる。記録の無い人(最初のシステム管理者など)はすべてのワークスペースから外れる。
 * 外れる側 = workspaces のうち priorRoles に無いもの(workspaces の並び順のまま)。0 件なら外れる文を出さない。
 * workspaces が null(取得に失敗した)なら、外れる側の名前を省く。
 * 自分を外して戻るワークスペースが無いときだけ、ログアウトの注意を足す
 */
export function demotionConfirmBody(admin: InstanceAdmin, self: boolean, workspaces: Array<{ id: string; name: string }> | null): string {
  const prior = admin.priorRoles ?? []; // 古い control の応答では欠ける = 記録なし
  if (prior.length === 0) {
    const names = workspaces && workspaces.length > 0 ? workspaces.map((w) => w.name).join("、") : null;
    const base = names
      ? `次のすべてのワークスペースから外れます(システム管理者になる前の参加の記録がありません): ${names}`
      : "すべてのワークスペースから外れます(システム管理者になる前の参加の記録がありません)";
    return self ? `${base}。ほかに有効な招待が無ければ、ログアウトされます` : base;
  }
  const list = prior.map((p) => `${p.workspaceName}(${roleLabel(p.role)})`).join("、"); // roleLabel は string を受ける(知らない値はそのまま)
  const restored = `次のワークスペースでは、システム管理者になる前のロールに戻ります: ${list}`;
  if (workspaces === null) return `${restored}。それ以外のワークスペースからは外れます`;
  const kept = new Set(prior.map((p) => p.workspaceId));
  const left = workspaces.filter((w) => !kept.has(w.id)).map((w) => w.name);
  return left.length === 0 ? restored : `${restored}。次のワークスペースからは外れます: ${left.join("、")}`;
}

/**
 * 「元のロールに戻さず、すべてのワークスペースから外す」にチェックを入れたときの本文(B46 K12 を改める、2026-10-06 ユーザー決定)。
 * チェックの前の本文(demotionConfirmBody の「元のロールに戻ります」)は押した結果と食い違うので、これに差し替えて目立たせる。
 * 自分を外すときは、その場でログアウトされ自分では戻れないことを足す(有効な招待が残っていればログインは続くが、安全側に言い切る)
 */
export function fullRemovalConfirmBody(self: boolean, workspaces: Array<{ id: string; name: string }> | null): string {
  const base =
    workspaces && workspaces.length > 0
      ? `元のロールには戻さず、次のすべてのワークスペースから外れます: ${workspaces.map((w) => w.name).join("、")}`
      : "元のロールには戻さず、すべてのワークスペースから外れます";
  return self ? `${base}。外すとすぐにログアウトされ、ほかのシステム管理者に招待し直してもらうまで管理画面に入れなくなります` : base;
}

/**
 * 確認画面に「元のロールに戻さず、すべてのワークスペースから外す」のチェックボックスを出すか(B46 K12)。
 * 記録の無い人(priorRoles が空・欠けている)は、どちらでもすべてのワークスペースから外れるので出さない
 */
export function offersFullRemoval(admin: InstanceAdmin): boolean {
  return (admin.priorRoles ?? []).length > 0;
}
