import { duplicateName, type DuplicateMode } from "@wtt/core";
import type { PickerOption } from "@/components/ui/Picker";
import type { ResultsResponse } from "./results-view";
import { STATE_LABEL } from "./result-format";
import { baselineOf, beforeEvaluation, deliveredHasChanges, editedAfterEvaluationText, editedAfterEvaluationVariants, isDelivered, unpublishedText, unpublishedVariants, verdictHint } from "./stop-dialog";
import type { Experiment } from "./types";

/**
 * 決定 51(設計書 §4.2): 複製の画面の状態。結果(テストの結果の API の応答)があれば、初期値・プルダウンの補足・注意に判定を使う(D9 ③ Task 16)。
 * 結果が無い(下書き・パーソナライズ・読めなかった)ときは、プルダウンにパターン名と変更の件数だけを出す
 */
export type DuplicateState = { mode: DuplicateMode; variantId: string | null; name: string; nameEdited: boolean };

type Report = ResultsResponse | null | undefined;

const variantsOf = (e: Experiment) => e.variants ?? [];
const nameFor = (e: Experiment, mode: DuplicateMode, variantId: string | null) =>
  duplicateName(mode, e.name, variantsOf(e).find((v) => v.id === variantId)?.name ?? "");
/** B77: オリジナルは変更を持たないので「選んだパターンだけを表示」の元にできない(control は 422 duplicate_original_variant) */
const selectable = (e: Experiment) => variantsOf(e).filter((v) => !v.original);
/** パーソナライズの元は「同じ内容」だけ。オリジナルでないパターンが無い(A/A)テストも「同じ内容」だけ */
const effectiveMode = (e: Experiment, mode: DuplicateMode): DuplicateMode => (e.kind === "single" || selectable(e).length === 0 ? "same" : mode);

/**
 * 「選んだパターンだけを表示」を押せない理由(押せるなら null)。パーソナライズはこの選択肢自体を出さないので null。
 * 画面はこの理由を出してラジオを押せなくする
 */
export function duplicateVariantModeIssue(e: Experiment): string | null {
  return e.kind !== "single" && selectable(e).length === 0 ? "変更のあるパターンがありません" : null;
}

/**
 * 最初の状態(設計書 §4.2・決定 61):
 * - 方式: 採用を記録済みなら「選んだパターンだけ」(採用したパターン)、それ以外は「同じ内容」
 * - プルダウン: 採用があればそれ、無ければ基準以外で上回る確率の最も高いもの(配信したパターンだけ)、結果が無ければ先頭。
 *   どれもオリジナルを除く(オリジナルは複製を断られるため)
 */
export function initialDuplicateState(e: Experiment, report?: Report): DuplicateState {
  const choices = selectable(e);
  const adopted = report?.adoption?.variantId ?? null;
  if (adopted !== null && choices.some((v) => v.id === adopted) && effectiveMode(e, "variant") === "variant") {
    return { mode: "variant", variantId: adopted, name: nameFor(e, "variant", adopted), nameEdited: false };
  }
  let variantId = choices[0]?.id ?? null;
  if (report) {
    const baseline = baselineOf(report, e);
    let best: { id: string; p: number } | null = null;
    for (const v of choices) {
      const r = report.variants.find((x) => x.id === v.id);
      if (v.id === baseline || !r?.diff || !isDelivered(report, v.id)) continue;
      if (best === null || r.diff.pAboveDelta > best.p) best = { id: v.id, p: r.diff.pAboveDelta };
    }
    if (best) variantId = best.id;
  }
  return { mode: "same", variantId, name: nameFor(e, "same", variantId), nameEdited: false };
}

export function withMode(e: Experiment, s: DuplicateState, mode: DuplicateMode): DuplicateState {
  const m = effectiveMode(e, mode);
  return { ...s, mode: m, name: s.nameEdited ? s.name : nameFor(e, m, s.variantId) };
}

export function withVariant(e: Experiment, s: DuplicateState, variantId: string): DuplicateState {
  if (!selectable(e).some((v) => v.id === variantId)) return s; // オリジナル(一覧では選べない)は選ばない
  return { ...s, variantId, name: s.nameEdited ? s.name : nameFor(e, s.mode, variantId) };
}

export function withName(s: DuplicateState, name: string): DuplicateState {
  return { ...s, name, nameEdited: true };
}

/** プルダウンの項目。補足は判定と上回る確率(結果が無ければ変更の件数) */
export function duplicateVariantOptions(e: Experiment, report?: Report): PickerOption[] {
  return variantsOf(e).map((v) =>
    v.original
      ? { value: v.id, label: v.name, hint: "オリジナルは複製できません", disabled: true }
      : { value: v.id, label: v.name, hint: verdictHint(report, v.id) ?? (v.changes.length > 0 ? `変更 ${v.changes.length} 件` : "変更なし") },
  );
}

/** 選んだパターンの判定への注意(採用候補・採用を記録したパターン・基準には出さない) */
function verdictNote(report: Report, e: Experiment, variantId: string, now: number | null): string | null {
  if (!report || report.adoption?.variantId === variantId || variantId === baselineOf(report, e)) return null;
  const r = report.variants.find((x) => x.id === variantId);
  if (!r) return null;
  if (!isDelivered(report, variantId)) return "このパターンは配信していないため、効果は確かめられていません";
  // 評価時点の後でも、記録がまだ無ければ前に計算した速報が返る(phase = interim)。評価時点の前かは今の時刻で決める
  if (report.phase === "interim") {
    return beforeEvaluation(report, now) ? "評価時点の前です。いまの確率は参考値です" : "評価時点を過ぎましたが、判定をまだ記録できていません。表示している確率は前に計算した参考値です";
  }
  if (report.quality === "blocked") return "データ品質に問題があり、判定できていません。効果は確かめられていません";
  if (report.phase === "stopped") return "評価時点の前に終了したため、確率は参考値です";
  if (r.state === null || r.state === "adopt") return null;
  if (r.state === "worse") return `判定: ${STATE_LABEL.worse}。基準より悪い可能性が高いパターンです`;
  return `判定: ${STATE_LABEL[r.state]}。効果は確かめられていません`;
}

/**
 * now = 今の時刻(評価時点の前かを決める。マウント前は null)。
 * 「選んだパターンだけを表示」で選んだパターンへの注意(確認の画面は挟まない。設計書 §4.2):
 * 採用候補以外の判定・速報・評価時点前の終了・品質 → 変更が無い(配信していた定義で判断)→ 配信率 → 評価時点の後の編集 → 未公開の編集
 */
export function duplicateNotes(e: Experiment, s: DuplicateState, report?: Report, now: number | null = null): string[] {
  if (effectiveMode(e, s.mode) !== "variant") return [];
  const v = variantsOf(e).find((x) => x.id === s.variantId);
  const out: string[] = [];
  if (v) {
    const verdict = verdictNote(report, e, v.id, now);
    if (verdict) out.push(verdict);
    if (!deliveredHasChanges(report, e, v.id)) out.push(`${v.name} には変更が無いため、表示しても今のページと同じです`);
  }
  if (e.trafficPercentage !== 100) out.push(`配信率は 100% で作ります(元は ${e.trafficPercentage}%)`);
  if (v && editedAfterEvaluationVariants(report).includes(v.id)) out.push(editedAfterEvaluationText(v.name));
  if (v && unpublishedVariants(report).includes(v.id)) out.push(unpublishedText(v.name));
  return out;
}

/**
 * 送る body。「選んだパターンだけを表示」でパターンが選ばれていないときは黙って「同じ内容」に変えず、例外にする
 * (withMode と initialDuplicateState がこの状態を作らないので、届くのは呼び出し側の誤りだけ)
 */
export function duplicateBody(s: DuplicateState): { mode: DuplicateMode; variantId?: string; name: string } {
  if (s.mode !== "variant") return { mode: "same", name: s.name };
  if (s.variantId === null) throw new Error("表示するパターンを選んでください");
  return { mode: "variant", variantId: s.variantId, name: s.name };
}
