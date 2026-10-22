import { effectiveThreshold, extensionIssues, planCautions, sampleSize, type EvaluationPlan, type PlanCaution } from "@wtt/stats";
import type { Status } from "./types";

/**
 * 評価計画のタブの純関数(D9 ③ Task 14、設計書 §5・§10)。画面の文言はここに集める(テストで固定する)。
 * 範囲の検査(しきい値 90〜99.9 など)は control の 422 に任せ、欄の下に fieldErrors で出す。
 * stats の planIssues の文言は「Site」を含むので、画面にそのまま出さない(呼ばない)
 */

/** `GET / PUT …/evaluation-plan` の応答(apps/control/src/routes/evaluation-plan.ts の EvaluationPlanResponseSchema) */
export type PlanView = {
  plan: EvaluationPlan;
  fixed: boolean;
  fixedAt: number | null;
  evaluation: { minEnd: number; maxEnd: number; evaluationAt: number; reachedAt: number | null } | null;
  cautions: PlanCaution[];
  changes: Array<{ at: number; by: string | null; before: EvaluationPlan; after: EvaluationPlan; reason: string | null }>;
};

/** 利用者が入力する項目(集計の定義は表示のみ) */
export type PlanField = Exclude<keyof EvaluationPlan, "definition">;
const ALL_FIELDS: PlanField[] = ["primaryGoalId", "baselineVariantId", "minDays", "maxWeeks", "targetPerVariant", "delta", "rope", "threshold"];
/** 開始後(評価時点の前)に延ばす向きだけ変えられる項目 */
const EXTENSION_FIELDS: PlanField[] = ["minDays", "maxWeeks", "targetPerVariant"];

/** 入力欄の値。数の欄は入力中の文字をそのまま持つ(空欄・途中の値を落とさない) */
export type PlanForm = {
  primaryGoalId: string | null;
  baselineVariantId: string | null;
  minDays: string;
  maxWeeks: string;
  targetPerVariant: string;
  delta: string;
  rope: string;
  threshold: string;
};

export function planFormState(api: { plan: EvaluationPlan }): PlanForm {
  const p = api.plan;
  return {
    primaryGoalId: p.primaryGoalId,
    baselineVariantId: p.baselineVariantId,
    minDays: String(p.minDays),
    maxWeeks: String(p.maxWeeks),
    targetPerVariant: p.targetPerVariant === null ? "" : String(p.targetPerVariant),
    delta: String(p.delta),
    rope: p.rope === null ? "" : String(p.rope),
    threshold: String(p.threshold),
  };
}

/** 整数(空欄・小数・数でない文字は null) */
const int = (s: string): number | null => (/^\s*-?\d+\s*$/.test(s) ? Number(s.trim()) : null);
/** 数(空欄・数でない文字は null) */
const num = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const blank = (s: string) => s.trim() === "";

/** 型の検査(整数・数)。範囲は control が見る。欄 → 文言 */
export function planFormErrors(form: PlanForm): Partial<Record<PlanField, string>> {
  const e: Partial<Record<PlanField, string>> = {};
  if (int(form.minDays) === null) e.minDays = "最低期間は日数を整数で入力してください";
  if (int(form.maxWeeks) === null) e.maxWeeks = "最大期間は週数を整数で入力してください";
  if (!blank(form.targetPerVariant) && int(form.targetPerVariant) === null) e.targetPerVariant = "目標参加者数は人数を整数で入力してください(設けないときは空欄にします)";
  if (num(form.delta) === null) e.delta = "最小改善幅は数で入力してください";
  if (!blank(form.rope) && num(form.rope) === null) e.rope = "同等とみなす幅は数で入力してください(設けないときは空欄にします)";
  if (num(form.threshold) === null) e.threshold = "確率のしきい値は数で入力してください";
  return e;
}

/** 入力から計画を作る。数にできない欄は before の値のまま(planFormErrors が欄の下に出す) */
export function formToPlan(form: PlanForm, before: EvaluationPlan): EvaluationPlan {
  return {
    ...before,
    primaryGoalId: form.primaryGoalId,
    baselineVariantId: form.baselineVariantId,
    minDays: int(form.minDays) ?? before.minDays,
    maxWeeks: int(form.maxWeeks) ?? before.maxWeeks,
    targetPerVariant: blank(form.targetPerVariant) ? null : (int(form.targetPerVariant) ?? before.targetPerVariant),
    delta: num(form.delta) ?? before.delta,
    rope: blank(form.rope) ? null : (num(form.rope) ?? before.rope),
    threshold: num(form.threshold) ?? before.threshold,
  };
}

/**
 * `PUT …/evaluation-plan` の body。変えた項目だけを送る(control は送らない項目を保存済みの値のまま残す)。
 * 集計の定義は送らない。理由は開始後の変更の履歴に残す(空白だけなら送らない)
 */
export function planPutBody(form: PlanForm, before: EvaluationPlan, reason?: string): { plan: Partial<EvaluationPlan>; reason?: string } {
  const next = formToPlan(form, before);
  const plan: Partial<EvaluationPlan> = {};
  for (const f of ALL_FIELDS) if (next[f] !== before[f]) (plan as Record<string, unknown>)[f] = next[f];
  const r = reason?.trim();
  return r ? { plan, reason: r } : { plan };
}

/** 評価計画に未保存の入力があるか(保存すると送る項目があるか) */
export function planDirty(view: Pick<PlanView, "plan"> | null, form: PlanForm | null): boolean {
  return view !== null && form !== null && Object.keys(planPutBody(form, view.plan).plan).length > 0;
}

/**
 * ページが読み直した計画(開始・保存の後の router.refresh)で、エディタが持つ計画の状態を置き換える。
 * 未保存の入力があれば入力は残し、比べる計画(view)だけ新しくする(開始で固定された後は、残した入力が延ばす向きかを新しい計画で見る)
 */
export function syncPlanState(cur: { view: PlanView | null; form: PlanForm | null }, next: PlanView | null): { view: PlanView | null; form: PlanForm | null } {
  if (next === null) return { view: null, form: null };
  return { view: next, form: planDirty(cur.view, cur.form) ? cur.form : planFormState(next) };
}

/** 入力できる項目。固定前はすべて、固定後で評価時点の前は延ばす 3 項目、評価時点の後は無し(設計書 §5.4) */
export function editableFields(fixed: boolean, evaluated: boolean): Set<PlanField> {
  if (!fixed) return new Set(ALL_FIELDS);
  return evaluated ? new Set() : new Set(EXTENSION_FIELDS);
}

/**
 * タブの場面。editableFields の 2 つの真偽で表せない場面(結果を記録しないで開始・終了・閲覧者)をここで分ける。
 * - draft: 下書き(すべて入力できる) / extend: 固定済みで評価時点の前(延ばす向きだけ)/ evaluated: 評価時点の後
 * - unfixed: 結果を記録しないで開始したテスト(計画を固定していない。表示のみ)/ archived: 終了したテスト / readonly: 閲覧者・時刻が分かる前
 * now は useNow() の値(マウント前は null。評価時点の後かもしれないので、延ばす入力を出さない)
 */
export type PlanMode = "draft" | "extend" | "evaluated" | "unfixed" | "archived" | "readonly";
export function planMode(a: { status: Status; canEdit: boolean; view: Pick<PlanView, "fixed"> & { evaluation: { evaluationAt: number } | null }; now: number | null }): PlanMode {
  if (a.status === "archived") return "archived";
  if (!a.canEdit) return "readonly";
  if (a.status === "draft") return "draft";
  if (!a.view.fixed || a.view.evaluation === null) return "unfixed";
  if (a.now === null) return "readonly";
  return a.now >= a.view.evaluation.evaluationAt ? "evaluated" : "extend";
}
/** 場面ごとに入力できる項目 */
export function fieldsFor(mode: PlanMode): Set<PlanField> {
  if (mode === "draft") return editableFields(false, false);
  if (mode === "extend") return editableFields(true, false);
  return new Set();
}

/** 開始後の場面の案内(タブの上部) */
export const PLAN_MODE_NOTICE = {
  extend: "開始後は、評価時点の前に最低期間・最大期間を延ばす変更と、目標参加者数を増やす(新しく設ける)変更だけができます。変更は記録され、結果の画面に表示されます",
  evaluated: "評価時点を過ぎたので、評価計画は変えられません。続けて確かめるときは複製して新しいテストにしてください",
  unfixed: "このテストは結果を記録しないで開始したので、評価計画を判定に使いません。評価計画を使うときは、結果を記録するサイトで複製して開始してください",
  // archived は置かない: 終了したテストの文はエディタの上部の帯(test-locks の archivedTestBanner)だけに出す
} as const;

/** 3 桁ごとのカンマ(toLocaleString を描画で使わない) */
export const fmt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 開始後に、延ばす向きでない入力をした欄 → 理由(extensionIssues の 3 項目だけ。ほかの項目は入力できない) */
export function extensionErrors(before: EvaluationPlan, form: PlanForm): Partial<Record<PlanField, string>> {
  const bad = new Set(extensionIssues(before, formToPlan(form, before)));
  const e: Partial<Record<PlanField, string>> = {};
  if (bad.has("minDays")) e.minDays = `開始後は最低期間を短くできません(今は ${before.minDays} 日)`;
  if (bad.has("maxWeeks")) e.maxWeeks = `開始後は最大期間を短くできません(今は ${before.maxWeeks} 週)`;
  if (bad.has("targetPerVariant") && before.targetPerVariant !== null) e.targetPerVariant = `開始後は目標参加者数を減らしたり外したりできません(今は ${fmt(before.targetPerVariant)} 人)`;
  return e;
}

/** 注意(止めない)の文言。tone = warn は強い注意 */
export function cautionMessage(c: PlanCaution): { tone: "warn" | "info"; text: string } {
  switch (c.key) {
    case "min_days_very_short":
      return { tone: "warn", text: "7 日未満のため、曜日が 1 周しません。曜日で CVR が変わるサイトでは、結果が偏ります" };
    case "min_days_short":
      return { tone: "info", text: "14 日未満のため、曜日による変動を 2 週分ならして見られません" };
    case "threshold_low":
      return { tone: "warn", text: "確率のしきい値を 95% 未満にすると、誤って勝ちと出る率が上がります" };
    case "no_target":
      return { tone: "info", text: "目標参加者数を決めないと、人数に関係なく最低期間の終わりに判定します。必要な人数の目安を使って決めることをお勧めします" };
  }
}

/** 入力中の値から注意を出す。数にできない欄はその注意を出さない(型のエラーを欄の下に出す) */
export function planCautionsOf(form: PlanForm, before: EvaluationPlan): PlanCaution[] {
  const errors = planFormErrors(form);
  return planCautions(formToPlan(form, before)).filter((c) => {
    if (c.key === "min_days_short" || c.key === "min_days_very_short") return !errors.minDays;
    if (c.key === "threshold_low") return !errors.threshold;
    return !errors.targetPerVariant;
  });
}

/** 比較の回数 m(重みが 0 より大きいパターンの数 − 1。判定と同じ数え方。少なくとも 1) */
export const comparisonsOf = (activeVariants: number): number => Math.max(1, activeVariants - 1);
/** 引き上げたしきい値の表示(小数 2 桁まで) */
export const thresholdLabel = (threshold: number, comparisons: number): string => String(Number((comparisons > 1 ? effectiveThreshold(threshold, comparisons) : threshold).toFixed(2)));

/**
 * 必要な人数の目安(補助計算)。計算できない入力は null(sampleSize の RangeError を画面に出さない)。
 * activeVariants = 重みが 0 より大きいパターンの数。perDay = 1 日の参加者の見込み(合計)
 */
export function sampleSizeEstimate(a: { cvrPercent: number; diffPoints: number; perDay: number; activeVariants: number; threshold: number; maxWeeks: number }): {
  perVariant: number;
  total: number;
  days: number;
  text: string;
  fit: { ok: boolean; text: string };
  raised: string | null;
} | null {
  if (![a.cvrPercent, a.diffPoints, a.perDay, a.threshold, a.maxWeeks].every(Number.isFinite) || !(a.perDay > 0)) return null;
  const k = Math.max(2, a.activeVariants);
  const m = comparisonsOf(k);
  let perVariant: number;
  try {
    perVariant = sampleSize(a.cvrPercent / 100, a.diffPoints, m, a.threshold);
  } catch {
    return null;
  }
  const total = perVariant * k;
  const days = Math.ceil(total / a.perDay);
  const maxDays = a.maxWeeks * 7;
  const to = Number((a.cvrPercent + a.diffPoints).toFixed(4));
  return {
    perVariant,
    total,
    days,
    text: `${a.cvrPercent}% → ${to}% の差を見つけるには、1 パターンあたり約 ${fmt(perVariant)} 人(${k} つで合計約 ${fmt(total)} 人)。1 日 ${fmt(a.perDay)} 人なら約 ${days} 日かかります`,
    fit:
      days > maxDays
        ? { ok: false, text: `最大期間(${maxDays} 日)に収まりません。見つけたい差を大きくする・パターンを減らす・最大期間を延ばす、のいずれかを検討してください` }
        : { ok: true, text: `最大期間(${maxDays} 日)に収まる見込みです` },
    raised: m > 1 ? `${k} つのパターンを比べるため、しきい値を ${thresholdLabel(a.threshold, m)}% に引き上げて計算しています` : null,
  };
}

/**
 * 下書きの時間の線の「評価時点の見込み」。days = 開始から何日後か(分からなければ null)。
 * 目標参加者数があり 1 日の見込みがあれば、届く日を max(最低期間, 届く日数) とし、最大期間を超えれば最大期間の終わり
 */
export function draftEvaluationEstimate(a: { minDays: number; maxWeeks: number; target: number | null; perDay: number | null; activeVariants: number }): { days: number | null; text: string } {
  const maxDays = a.maxWeeks * 7;
  if (a.target === null) return { days: a.minDays, text: "最低期間の終わりに判定します" };
  if (a.perDay === null || !(a.perDay > 0)) return { days: null, text: `各パターンが ${fmt(a.target)} 人に達した日に判定します(最大期間の終わりまでに届かなければ、その日に判定します)` };
  const reach = Math.ceil((a.target * Math.max(2, a.activeVariants)) / a.perDay);
  if (reach > maxDays) return { days: maxDays, text: `目標に届く見込みは約 ${reach} 日後で最大期間を超えるため、最大期間の終わりに判定する見込みです。多くは「判断材料が不足」になります` };
  return { days: Math.max(a.minDays, reach), text: `各パターンが ${fmt(a.target)} 人に達した日(見込み)に判定します` };
}

/** 結果を記録しないサイトの上部の警告。canEnable = サイト設定で有効にする導線を出すか(導入に計測用のデータベースが無ければ出さない) */
export function notRecordingNotice(resultsStore: boolean): { title: string; body: string; canEnable: boolean } {
  return resultsStore
    ? {
        title: "このサイトは結果を記録しない設定です",
        body: "このまま開始すると、結果はツール上に残りません(GA4 / BigQuery には今までどおり送られます)。終わったテストのデータは後から取り戻せません",
        canEnable: true,
      }
    : {
        title: "この導入では結果を記録できません",
        body: "計測用のデータベースが導入されていないため、このまま開始すると、結果はツール上に残りません(GA4 / BigQuery には今までどおり送られます)",
        canEnable: false,
      };
}

/** 基準が変更を持つパターンのとき、何との比較になるか */
export function baselineNote(v: { name: string; original: boolean; changes: unknown[] }): string | null {
  if (v.original || v.changes.length === 0) return null;
  return `基準に変更が ${v.changes.length} 件あります。結果は「今のページとの比較」ではなく「${v.name} との比較」になります`;
}
