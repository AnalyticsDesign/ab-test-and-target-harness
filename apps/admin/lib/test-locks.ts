import type { Draft } from "./experiment-draft";
import { treeProblem } from "./conditions";
import type { Experiment, Status } from "./types";

/**
 * 開始後のテストの編集の制限(D9 ③ Task 14、設計書 §5.5・§10)。control の 409(test_setting_locked /
 * experiment_archived_readonly)を、保存の前に画面で先に示す。最終の判定は control。パーソナライズ(single)は今のまま
 */
type LockTarget = Pick<Experiment, "kind" | "status" | "trafficPercentage">;

/** 実行中・一時停止中のテスト */
export const isStartedTest = (e: Pick<Experiment, "kind" | "status">): boolean => e.kind === "test" && (e.status === "running" || e.status === "paused");
/** 終了したテスト(メモ以外は読み取り専用) */
export const isArchivedTest = (e: Pick<Experiment, "kind" | "status">): boolean => e.kind === "test" && e.status === "archived";

export const ARCHIVED_TEST_MESSAGE = "終了したテストは編集できません。変えるときは複製してください";
const TRAFFIC_LOCKED = "テストの開始後は配信率を下げられません。絞るときは一時停止か終了してください";
const PERSIST_LOCKED = "テストの開始後は割当の固定を変えられません";

/** 終了したテストの上部の文(テスト以外・終了していなければ null) */
export const archivedTestBanner = (e: Pick<Experiment, "kind" | "status">): string | null => (isArchivedTest(e) ? ARCHIVED_TEST_MESSAGE : null);

/**
 * 欄が編集できない理由(編集できれば null)。終了したテストはメモ(description)以外のすべて。
 * 実行中・一時停止中のテストは割当の固定と、配信率を下げること(下げたかは trafficError が見る。ここは案内の文)
 */
export function testLockMessage(e: Pick<Experiment, "kind" | "status">, field: string): string | null {
  if (isArchivedTest(e)) return field === "description" ? null : ARCHIVED_TEST_MESSAGE;
  if (!isStartedTest(e)) return null;
  if (field === "persistAssignment") return PERSIST_LOCKED;
  if (field === "trafficPercentage") return TRAFFIC_LOCKED;
  return null;
}

/** 配信率の入力のエラー。実行中・一時停止中のテストで、保存済みの値より下げたときだけ(同じ値・上げるのは可) */
export function trafficError(e: LockTarget, value: number): string | null {
  return isStartedTest(e) && value < e.trafficPercentage ? TRAFFIC_LOCKED : null;
}

/**
 * 保存の前に止める理由(配信率を下げた・配信条件の入力漏れ)。止めなければ null。
 * 実際に送る PATCH の body(experimentPatchBody の値)に載る欄だけを見る(B173 第 1 段 最終レビュー FR-Medium-1):
 * 未保存のまま新しいサーバーの値が届くと、基準と下書きは開いたときの値のまま残る(reconcileServerUpdate)。そのとき、ほかの人が上げた
 * 配信率(e.trafficPercentage)と、自分が変えていない下書きの配信率を比べると、送らない欄のせいで名前だけの保存まで止めてしまう。
 * 配信条件も同じで、送らない(変えていない)配信条件の入力漏れでは止めない。値の最終的な検査は control
 */
export function preSaveLockProblem(e: LockTarget, patch: Record<string, unknown>, draft: Draft, retentionDays: number): string | null {
  if ("trafficPercentage" in patch) {
    const traffic = trafficError(e, draft.traffic);
    if (traffic) return traffic;
  }
  if ("targeting" in patch && draft.targeting.kind === "form") return treeProblem(draft.targeting.form.rows, retentionDays);
  return null;
}

/**
 * 基本設定の「割当の固定」の説明(設計書 §10)。off でも同じ訪問者には同じパターンが割り当たること、on が効くのは
 * 後から配信率を下げたときだけ、テストでは要らないこと、on にするとサイト全体で判定のたびに edge へ往復すること
 */
export const PERSIST_HINT =
  "オフでも、同じ訪問者には毎回同じパターンを表示します。オンが効くのは、後から配信率を下げたとき(すでに割り当てた訪問者には表示し続けます。パーソナライズを段階的に絞るときに使います)だけです。テストは開始後に配信率を下げられず、この設定も変えられないので、テストでは要りません。オンにすると訪問者プロフィールを使うため、サイト全体で表示のたびに edge へ問い合わせます";

/** 保存の確認の対象になる変更(Change・対象 URL・配信条件)。名前・配信率・メモ・外部計測は対象にしない */
export type LockedField = "urlMatch" | "targeting" | "changes";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function lockedFieldChanges(initial: Draft, current: Draft): LockedField[] {
  const out: LockedField[] = [];
  if (!same(initial.urlMatch, current.urlMatch)) out.push("urlMatch");
  if (!same(initial.targeting, current.targeting)) out.push("targeting");
  const before = new Map(initial.variants.map((v) => [v.id, v.changes]));
  if (current.variants.some((v) => !v.original && !same(v.changes, before.get(v.id) ?? []))) out.push("changes");
  return out;
}

export const RUNNING_TEST_CONFIRM = "実行中のテストを変更します。変更は結果に記録されます。大きく変えるなら複製して新しいテストにしてください";
/** 実行中・一時停止中のテストで、Change・対象 URL・配信条件を保存するときは 1 回確認する */
export function needsRunningTestConfirm(e: Pick<Experiment, "kind" | "status">, changedFields: readonly string[]): boolean {
  return isStartedTest(e) && changedFields.length > 0;
}

/**
 * 目標の保存の確認(目標名の変更も対象。B77 の K14)。runningTests = control の目標の JSON の runningTests
 * (配信条件・使っているオーディエンス・判定に使う目標のどれかで参照している実行中・一時停止中のテスト)。0 件なら確認しない
 */
export function goalSaveNotice(runningTests: ReadonlyArray<{ id: string; name: string }>): string | null {
  if (runningTests.length === 0) return null;
  return `この目標を使っている実行中・一時停止中のテストが ${runningTests.length} 件あります(${runningTests.map((t) => t.name).join("、")})。変更は次の公開でこれらのテストに効き、結果に記録されます。大きく変えるなら複製して新しいテストにしてください`;
}

/**
 * オーディエンスの保存の確認。control のオーディエンスの usedBy は種別を持たないので、テストに限らず
 * 実行中・一時停止中のエクスペリエンスを数える(テストのときは結果に記録されることを添える)。0 件なら確認しない
 */
export function audienceSaveNotice(usedBy: ReadonlyArray<{ id: string; name: string; status: Status }>): string | null {
  const running = usedBy.filter((u) => u.status === "running").length;
  const paused = usedBy.filter((u) => u.status === "paused").length;
  if (running + paused === 0) return null;
  const parts = [running > 0 ? `実行中のエクスペリエンス ${running} 件` : null, paused > 0 ? `一時停止中のエクスペリエンス ${paused} 件` : null].filter(Boolean);
  return `次の公開で、${parts.join("と")}の配信対象が変わります。テストでは、変更が結果に記録されます。大きく変えるなら複製して新しいテストにしてください。保存しますか?`;
}
