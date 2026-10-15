// apps/admin/lib/api-keys.ts — API キーとシステム管理者の画面の表示の判断(純関数。認可は control が行い、ここは押す前に分かるようにするだけ)
import type { PickerOption } from "@/components/ui/Picker";
import { formatLocalTime } from "./local-time";
import { highestRole, ROLE_RANK, roleLabel } from "./roles";
import type { ApiKey, InstanceAdminCandidate, Role, RoleCap, Workspace, WorkspaceApiKey } from "./types";

/** B41 (2): システム管理者の追加の選択肢。各行 = 名前・メールと、参加しているワークスペースとそこでのロール */
export function candidateItems(candidates: InstanceAdminCandidate[]): Array<{ value: string; label: string; detail: string }> {
  return candidates.map((c) => ({ value: c.userId, label: `${c.name} · ${c.email}`, detail: c.workspaces.map((w) => `${w.name}: ${roleLabel(w.role)}`).join(" / ") }));
}

/** B41 (3): メンバーの鍵の一覧で、失効を押せない理由(押せるなら null)。control の判定と同じ順 */
export function revokeBlockedReason(key: WorkspaceApiKey, myRole: Role, amInstanceAdmin: boolean): string | null {
  if (key.owner.instanceAdmin && !amInstanceAdmin) return "システム管理者のキーは、システム管理者だけが失効できます";
  if (key.owner.role === "owner" && myRole !== "owner") return "オーナーのキーはオーナーだけが失効できます";
  return null;
}

/** B42: 発行フォームの範囲の値で「すべてのワークスペース」(API の full)を表す印(ワークスペースの ID は 32 文字のランダムなので重ならない) */
export const FULL_SCOPE = "full";

/** 範囲の選択肢。「すべてのワークスペース」はシステム管理者だけ(先頭)、続けて参加しているワークスペース(hint にそこでのロール) */
export function scopeOptions(workspaces: Workspace[], amInstanceAdmin: boolean): PickerOption[] {
  return [
    ...(amInstanceAdmin ? [{ value: FULL_SCOPE, label: "すべてのワークスペース", hint: "システム管理者だけが選べます" }] : []),
    ...workspaces.map((w) => ({ value: w.id, label: w.name, hint: `あなたのロール: ${roleLabel(w.role)}` })),
  ];
}

/** 選択肢が 1 つだけならそれを選んだ状態にし、それ以外は選ばせる(選び忘れで「すべてのワークスペース」にしない) */
export function initialScope(options: PickerOption[]): string | null {
  return options.length === 1 ? options[0]!.value : null;
}

/** 権限に選べる最高位。すべてのワークスペース = 本人の最高位、ワークスペース = そこでのロール(control も同じ判定で 400 を返す) */
export function capCeiling(scope: string | null, workspaces: Workspace[]): Role | null {
  if (scope === null) return null;
  if (scope === FULL_SCOPE) return highestRole(workspaces);
  return workspaces.find((w) => w.id === scope)?.role ?? null;
}

/** 権限の選択(画面の値)。same = 本人と同じ(API の roleCap = null)。未選択は null で別に持つ */
export type CapChoice = "viewer" | "editor" | "admin" | "same";

const CAP_HINT: Record<Exclude<CapChoice, "same">, string> = {
  viewer: "読み取りだけ(閲覧・評価・分析レシピ)",
  editor: "下書きの作成・編集まで(公開は人が行う)",
  admin: "公開・開始・終了まで(訪問者に届く操作)",
};

/** 権限の選択肢(K9 / 決定 54 (11)): 小さい順に、範囲での自分のロール以下 + 本人と同じ。オーナー相当の上限は「本人と同じ」で表す */
export function capOptions(ceiling: Role | null): PickerOption[] {
  if (ceiling === null) return [];
  const roles = (["viewer", "editor", "admin"] as const).filter((r) => ROLE_RANK[r] <= ROLE_RANK[ceiling]);
  return [
    ...roles.map((r) => ({ value: r, label: roleLabel(r), hint: CAP_HINT[r] })),
    { value: "same", label: `本人と同じ(${roleLabel(ceiling)})`, hint: "あなたのロールが変わると、キーの権限も変わります" },
  ];
}

export const capFromChoice = (choice: CapChoice): RoleCap => (choice === "same" ? null : choice);

/** 一覧の「権限」の列。ownerRole を渡すと「本人と同じ(管理者)」(メンバーの API キーの一覧) */
export const capLabel = (cap: RoleCap, ownerRole?: Role): string => (cap ? roleLabel(cap) : ownerRole ? `本人と同じ(${roleLabel(ownerRole)})` : "本人と同じ");

/** 範囲を変えた後に残す権限の選択。新しい範囲で選べない権限は捨てる(state から消す。範囲を戻してもよみがえらせない。Review Focus 2) */
export function capAfterScopeChange(cap: string | null, scope: string | null, workspaces: Workspace[]): string | null {
  return validChoice(cap, capOptions(capCeiling(scope, workspaces)).map((o) => o.value));
}

/** 有効期限の選択(B43 / K23)。none = 期限なし(expiresInDays を送らない)。未選択は null で別に持つ */
export type ExpiryChoice = "none" | "1" | "7" | "30" | "90";
export const EXPIRY_OPTIONS: PickerOption[] = [
  { value: "none", label: "期限なし" },
  { value: "1", label: "1 日", hint: "更新や確認のためだけに使うキー" },
  { value: "7", label: "7 日" },
  { value: "30", label: "30 日" },
  { value: "90", label: "90 日" },
];
export const expiresInDaysOf = (choice: ExpiryChoice): number | undefined => (choice === "none" ? undefined : Number(choice));
/** 期限の時刻の目安(control は発行の時刻から数えるので、押した時点の now から数える) */
export const expiryAt = (choice: ExpiryChoice, now: number): number | null => (choice === "none" ? null : now + Number(choice) * 86_400_000);
/** 期限の日時の表示(見ている人のタイムゾーン。テストでは timeZone を渡す)。例: 「10/12 22:05」 */
export const formatDeadline = (at: number, timeZone?: string): string => formatLocalTime(at, "deadline", timeZone);
/** 一覧の「期限」の列 */
export function expiryLabel(expiresAt: number | null, now: number, timeZone?: string): string {
  if (expiresAt === null) return "期限なし";
  return expiresAt <= now ? `期限切れ(${formatDeadline(expiresAt, timeZone)})` : formatDeadline(expiresAt, timeZone);
}

/** 「発行する」を押せない理由(上から順に 1 つ)。押せるなら null */
export function issueMissing(name: string, scope: string | null, cap: string | null, expiry: string | null): string | null {
  if (name.trim() === "") return "名前を入れてください";
  if (scope === null) return "範囲を選んでください";
  if (cap === null) return "権限を選んでください";
  if (expiry === null) return "有効期限を選んでください";
  return null;
}

/** 一覧の「範囲」の列 */
export function scopeLabel(key: Pick<ApiKey, "scope" | "workspace">): string {
  if (key.scope === "full") return "すべてのワークスペース";
  if (key.scope === "workspace") return key.workspace?.name ?? "削除済みのワークスペース(使えません)";
  return "範囲なし(使えません)";
}

/** 自分の一覧の「範囲」の列。control が 401 にする鍵には「使えません」と理由を付ける(差 ④) */
export function ownScopeLabel(key: Pick<ApiKey, "scope" | "workspace">, workspaces: Workspace[], amInstanceAdmin: boolean): string {
  if (key.scope === "full" && !amInstanceAdmin) return "すべてのワークスペース(使えません: システム管理者ではありません)";
  if (key.scope === "workspace" && key.workspace?.name != null && !workspaces.some((w) => w.id === key.workspace!.id)) {
    return `${key.workspace.name}(使えません: このワークスペースのメンバーではありません)`;
  }
  return scopeLabel(key);
}

/** 選択肢から消えた選択は未選択に戻す(画面の更新・範囲の変更で選択肢が変わったとき) */
export function validChoice(choice: string | null, options: string[]): string | null {
  return choice !== null && options.includes(choice) ? choice : null;
}
