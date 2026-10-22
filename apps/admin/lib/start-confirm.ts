import type { EvaluationPlan } from "@wtt/stats";
import { fmt, thresholdLabel } from "./evaluation-plan";
import type { PublishPreview } from "./types";

/** 決定 51(設計書 §3.3・§10、plan ① K7): 下書きを開始するときの重なりの確認。重なりが無ければ確認しない */
export type Overlap = PublishPreview["overlaps"][number];
export type StartConfirm = {
  title: string;
  lead: string;
  items: { key: string; message: string }[];
  confirmLabel: string;
  /** D9 ③(設計書 §5.2): 結果を記録する開始で固定する評価計画の内容(一覧) */
  fixed?: { label: string; value: string }[];
  /** 一覧の下の 1 文(開始後の変更の扱い) */
  note?: string;
  /** 結果を記録しない開始の警告 */
  notice?: string;
  /** 状態の変更はサイト全体を公開する、の 1 文(B66 b。開始・再開・一時停止の確認に必ず入れる) */
  sitePublish: string;
};

/**
 * B66 b: 状態の変更(開始・一時停止・再開・終了)は、このエクスペリエンスだけでなくサイト全体を公開する(control の publishSite)。
 * そのため、ほかのエクスペリエンスの保存済みで未公開の編集も一緒に本番に出る。確認の中でそれを言う
 */
export const SITE_PUBLISH_NOTE = "状態を変えると、このサイト全体を公開します。このサイトのほかのエクスペリエンスに保存済みで未公開の編集があれば、それも一緒に本番に出ます";

/** B107: 一時停止の確認。取り消せる操作(再開できる)なので、呼び出し側は主ボタンの色(tone primary)で出す */
export function pauseConfirm(): Pick<StartConfirm, "title" | "lead" | "confirmLabel" | "sitePublish"> {
  return {
    title: "一時停止しますか?",
    lead: "一時停止すると、このエクスペリエンスの訪問者への配信がすぐに止まります(再開できます)。",
    confirmLabel: "一時停止する",
    sitePublish: SITE_PUBLISH_NOTE,
  };
}

/**
 * 下書きのテストの開始(D9 ③ Task 14)。recording = その Site が結果を記録するか(Site の設定が有効で、導入に計測用のデータベースがある。
 * control が run_id を振る条件と同じ)。plan = 開始の前に読んだ評価計画(読めなければ null)。goalName / baselineName は画面の名前。
 * comparisons = 比較の回数(重みが 0 より大きいパターンの数 − 1。しきい値の引き上げに使う)。baselineWeight = 基準の重み(開始の前の検査)
 */
export type StartPlan = {
  recording: boolean;
  plan: EvaluationPlan | null;
  goalName: string | null;
  baselineName?: string | null;
  comparisons?: number;
  /** 基準のパターンの保存済みの重み(分からなければ null / 省略) */
  baselineWeight?: number | null;
};

const NOT_RECORDED = "結果はツール上に残りません。後から結果の記録を有効にしても、このテストの結果は記録されません";

/** 固定する内容の一覧(モック (a) の開始のモーダル) */
function fixedItems(plan: EvaluationPlan, goalName: string | null, baselineName: string | null | undefined, comparisons: number): { label: string; value: string }[] {
  const criteria = [
    `上回る確率 ${thresholdLabel(plan.threshold, comparisons)}% 以上`,
    plan.delta > 0 ? `+${plan.delta} ポイント超` : null,
    plan.rope !== null ? `同等とみなす幅 ±${plan.rope} ポイント` : null,
  ].filter(Boolean);
  return [
    { label: "判定に使う目標", value: goalName ?? plan.primaryGoalId ?? "未設定" },
    { label: "基準", value: baselineName ?? plan.baselineVariantId ?? "未設定" },
    { label: "期間", value: `最低 ${plan.minDays} 日・最大 ${plan.maxWeeks} 週` },
    { label: "目標参加者数", value: plan.targetPerVariant === null ? "なし(最低期間の終わりに判定)" : `${fmt(plan.targetPerVariant)} 人 / パターン` },
    { label: "判定の基準", value: criteria.join("・") },
  ];
}

/**
 * verb = 下書きの開始は「開始」、一時停止中の再開は「再開」(再開も配信に入り直すので優先が変わる。2026-10-06 ユーザー決定)。
 * zeroWeight = 保存済みのパターンのうち重み 0 のものの名前(B77 K20。パターン名をそのまま渡す)。開始の確認を 1 つにまとめ、モーダルを 2 回出さない。
 * 0% を知らせるのは下書きの開始だけ(開始後は重みを直せないため)なので、再開では呼び出し側が渡さない。
 * start = 下書きのテストの開始だけ渡す(D9 ③)。渡したときは、重なりや 0% が無くても必ず確認する(固定する内容か、記録しない文を出す)
 */
export function startConfirmFor(
  overlaps: Overlap[] | null | undefined,
  verb: "開始" | "再開" = "開始",
  zeroWeight: string[] = [],
  start?: StartPlan,
  /** B66 b: このエクスペリエンスのほかに未公開の変更がある(状態の変更で一緒に本番に出る)。あれば、ほかに理由が無くても 1 文だけの確認を出す */
  othersUnpublished = false,
): StartConfirm | null {
  const ov = overlaps ?? [];
  if (ov.length === 0 && zeroWeight.length === 0 && !start && !othersUnpublished) return null;
  const items = [
    ...ov.map((o) => ({ key: o.experimentIds.join("|"), message: o.message })),
    // 名前は重なり得るので位置も key に入れる
    ...zeroWeight.map((name, i) => ({ key: `zero-weight:${i}:${name}`, message: `${name} は重み 0% のため、誰にも表示されません` })),
  ];
  const fixing = start?.recording === true;
  // 記録しない開始は notice が同じことを言うので、導入文は空(呼び出し側は空なら出さない)
  const fallbackLead = !start || !fixing ? "" : start.plan ? "次の内容で評価計画を固定します。" : "開始の時点で評価計画を固定します。";
  return {
    title: fixing ? `${verb}して評価計画を固定しますか?` : `${verb}しますか?`,
    lead: ov.length > 0 ? "同じ要素を変える配信中のエクスペリエンスがあります。" : zeroWeight.length > 0 ? "重み 0% のパターンがあります。" : fallbackLead,
    items,
    confirmLabel: `${verb}する`,
    sitePublish: SITE_PUBLISH_NOTE,
    ...(fixing && start.plan
      ? { fixed: fixedItems(start.plan, start.goalName, start.baselineName, start.comparisons ?? 1), note: "開始後も期間と人数を延ばす変更はできますが、変更は記録され、結果の画面に表示されます。" }
      : {}),
    ...(start && !fixing ? { notice: NOT_RECORDED } : {}),
  };
}

/**
 * 確認の前に止める理由(止めなければ null)。結果を記録する開始で判定に使う目標が無い・基準の重みが 0 だと、control が 422 evaluation_plan_incomplete で断る。
 * 「未設定」の一覧を出してから失敗させず、先に案内する(文言は control の hint と同じ)。計画を読めなければ control に任せる
 */
export function startBlocker(start: StartPlan): string | null {
  if (!start.recording || start.plan === null) return null;
  if (start.plan.primaryGoalId === null) return "評価計画のタブで判定に使う目標を選んでください";
  if (typeof start.baselineWeight === "number" && start.baselineWeight <= 0) return "基準のパターンの重みを 0 より大きくしてください";
  return null;
}

/** 開始の応答の warnings(結果を記録しない開始・容量の見込み)を、画面に出す文にする */
export function startWarnings(warnings: ReadonlyArray<{ path: string; message: string }> | undefined): string[] {
  return (warnings ?? []).map((w) => w.message);
}

/** 確認サマリの取得。失敗したら空(警告は開始を止めない) */
/**
 * 開始・再開の前の下見(B66 b)。重なりと、このエクスペリエンスのほかに未公開の変更があるか(ほかのエクスペリエンスの編集・
 * オーディエンスの変更・サイト全体の設定の変更。状態の変更はサイト全体を公開するので一緒に本番に出る)。取れなければ確認を出さずに進める
 */
export async function loadStartPreview(selfId: string, fetchPreview: () => Promise<PublishPreview>): Promise<{ overlaps: Overlap[]; othersUnpublished: boolean }> {
  try {
    const p = await fetchPreview();
    const othersUnpublished = (p.experiments ?? []).some((x) => x.id !== selfId) || (p.audienceChanges ?? []).length > 0 || p.siteLevelChanged === true;
    return { overlaps: p.overlaps ?? [], othersUnpublished };
  } catch {
    return { overlaps: [], othersUnpublished: false };
  }
}
