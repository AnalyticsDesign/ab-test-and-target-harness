import type { ExpressionBuilder } from "kysely";
import type { ExperimentRow, Tables } from "./db";
import { ApiError } from "./errors";

/**
 * D9 ③(plan ③ の K10、設計書 §5.5): 開始後のテストの編集の制限。
 * - 実行中・一時停止中のテストは、配信率を下げる・割当の固定を変えると 409 test_setting_locked
 *   (外れた参加者の後の CV が元の表示のまま数えられ、差が 0 に寄るため。上げるのは可)
 * - 終了したテストは読み取り専用(メモ = description だけの PATCH と PATCH …/variants/:vid は除く。B77 の K9)
 * - パーソナライズ(kind = 'single')は今のまま(どの状態でも編集できる)
 * ここは読んだ行の検査だけ。書き込みの文の条件(読んだ後に状態が変わったとき)は各ルートが付ける
 */

/** 終了したテストへの保存 */
export const archivedReadonly = () =>
  new ApiError(409, "experiment_archived_readonly", { hint: "終了したテストは編集できません。変えるときは複製してください" });

const LOCKED_HINTS = {
  trafficPercentage: "テストの開始後は配信率を下げられません。絞るときは一時停止か終了してください",
  persistAssignment: "テストの開始後は割当の固定を変えられません",
} as const;

/** 開始後のテストで変えられない設定 */
export const testSettingLocked = (field: keyof typeof LOCKED_HINTS) =>
  new ApiError(409, "test_setting_locked", { path: [field], hint: LOCKED_HINTS[field] });

/**
 * 削除の保護(audience_in_use / goal_in_use)で、参照しているのが終了したテストのときの案内。
 * 終了したテストは配信条件を外せないので、「外してから」とは案内しない
 */
export const archivedTestsHint = (names: readonly string[]): string =>
  `終了したテスト(${names.join("、")})が参照している間は削除できません(終了したテストを削除すると削除できます)`;

/** body のキーがメモ(description)だけ。メモは config に出ないので状態を問わず受ける */
export const isMemoOnly = (keys: readonly string[]): boolean => keys.length === 1 && keys[0] === "description";

/** `kind = 'test'` かつ終了したものは 409 experiment_archived_readonly */
export function assertNotArchivedTest(exp: Pick<ExperimentRow, "kind" | "status">): void {
  if (exp.kind === "test" && exp.status === "archived") throw archivedReadonly();
}

/**
 * エクスペリエンスの PATCH の事前の検査。`keys` は body のキー(メモだけなら何もしない)。
 * 同じ値を送るのは変更ではないので受ける(管理画面は保存のたびに今の値を送る)
 */
export function assertTestEditable(
  exp: Pick<ExperimentRow, "kind" | "status" | "traffic_percentage" | "persist_assignment">,
  patch: { trafficPercentage?: number; persistAssignment?: boolean; keys: readonly string[] },
): void {
  if (isMemoOnly(patch.keys) || exp.kind !== "test") return;
  assertNotArchivedTest(exp);
  if (exp.status !== "running" && exp.status !== "paused") return;
  if (patch.trafficPercentage !== undefined && patch.trafficPercentage < exp.traffic_percentage) throw testSettingLocked("trafficPercentage");
  if (patch.persistAssignment !== undefined && (patch.persistAssignment ? 1 : 0) !== exp.persist_assignment) throw testSettingLocked("persistAssignment");
}

/**
 * 書き込みの文の条件: 対象のエクスペリエンスの行(`experiments` を直接書く文と、その前に置く記録の文用。B129: 操作の文と記録の文が同じ断片を使う)
 */
export const thisExperiment = (siteId: string, eid: string) => (eb: ExpressionBuilder<Tables, "experiments">) =>
  eb.and([eb("experiments.site_id", "=", siteId), eb("experiments.id", "=", eid)]);

/**
 * PATCH(メモだけの PATCH を除く)の書き込みの条件(D9 ③ の K10)。読んだ状態のまま・終了したテストでない。テストは加えて、配信率は今の値以上・
 * 割当の固定は今の値のまま(下書きは下げても変えてもよい)。B129: 更新の文と、その前に置く experiment.update の記録の文が使う
 */
export const experimentPatchWritable =
  (exp: Pick<ExperimentRow, "site_id" | "id" | "kind" | "status">, patch: { trafficPercentage?: number; persistAssignment?: boolean }) =>
  (eb: ExpressionBuilder<Tables, "experiments">) => {
    const isTest = exp.kind === "test";
    const { trafficPercentage, persistAssignment } = patch;
    return eb.and([
      thisExperiment(exp.site_id, exp.id)(eb),
      eb("experiments.status", "=", exp.status),
      notArchivedTest(eb),
      ...(isTest && trafficPercentage !== undefined ? [eb.or([eb("experiments.status", "=", "draft"), eb("experiments.traffic_percentage", "<=", trafficPercentage)])] : []),
      ...(isTest && persistAssignment !== undefined ? [eb.or([eb("experiments.status", "=", "draft"), eb("experiments.persist_assignment", "=", persistAssignment ? 1 : 0)])] : []),
    ]);
  };

/** 書き込みの文の条件: 親が終了したテストでない(`experiments` を直接更新する文用) */
export const notArchivedTest = (eb: ExpressionBuilder<Tables, "experiments">) =>
  eb.not(eb.and([eb("experiments.kind", "=", "test"), eb("experiments.status", "=", "archived")]));

/** 書き込みの文の条件: 親のエクスペリエンスが終了したテストでない(子の表への文用。副問い合わせ) */
export const parentNotArchivedTest = (siteId: string, eid: string) => (eb: ExpressionBuilder<Tables, any>) =>
  eb.exists(
    eb
      .selectFrom("experiments as pe")
      .select("pe.id")
      .where("pe.site_id", "=", siteId)
      .where("pe.id", "=", eid)
      .where((e) => e.not(e.and([e("pe.kind", "=", "test"), e("pe.status", "=", "archived")]))),
  );

/** 書き込みの文の条件: 親のエクスペリエンスが下書き(PUT …/variants 用。副問い合わせ) */
export const parentIsDraft = (siteId: string, eid: string) => (eb: ExpressionBuilder<Tables, any>) =>
  eb.exists(eb.selectFrom("experiments as pe").select("pe.id").where("pe.site_id", "=", siteId).where("pe.id", "=", eid).where("pe.status", "=", "draft"));
