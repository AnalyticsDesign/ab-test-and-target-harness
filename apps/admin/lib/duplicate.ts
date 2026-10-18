import { duplicateName, type DuplicateMode } from "@wtt/core";
import type { PickerOption } from "@/components/ui/Picker";
import type { Experiment } from "./types";

/**
 * 決定 51(設計書 §4.2): 複製の画面の状態。plan ① はプルダウンにパターン名と変更の件数だけを出す
 * (判定・確率・判定と品質の注意・採用・未公開の編集の注意は plan ③ で足す)
 */
export type DuplicateState = { mode: DuplicateMode; variantId: string | null; name: string; nameEdited: boolean };

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

export function initialDuplicateState(e: Experiment): DuplicateState {
  // 結果が無いので、オリジナルでない最初のパターン(設計書 §4.2 の「2 番目」は、作成の既定で A がオリジナルになったため。B77)
  const variantId = selectable(e)[0]?.id ?? null;
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

export function duplicateVariantOptions(e: Experiment): PickerOption[] {
  return variantsOf(e).map((v) =>
    v.original ? { value: v.id, label: v.name, hint: "オリジナルは複製できません", disabled: true } : { value: v.id, label: v.name, hint: v.changes.length > 0 ? `変更 ${v.changes.length} 件` : "変更なし" },
  );
}

/** 「選んだパターンだけを表示」で選んだパターンへの注意(確認の画面は挟まない) */
export function duplicateNotes(e: Experiment, s: DuplicateState): string[] {
  if (effectiveMode(e, s.mode) !== "variant") return [];
  const v = variantsOf(e).find((x) => x.id === s.variantId);
  const out: string[] = [];
  if (v && v.changes.length === 0) out.push(`${v.name} には変更が無いため、表示しても今のページと同じです`);
  if (e.trafficPercentage !== 100) out.push(`配信率は 100% で作ります(元は ${e.trafficPercentage}%)`);
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
