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
/** パーソナライズの元は「同じ内容」だけ */
const effectiveMode = (e: Experiment, mode: DuplicateMode): DuplicateMode => (e.kind === "single" ? "same" : mode);

export function initialDuplicateState(e: Experiment): DuplicateState {
  const vs = variantsOf(e);
  const variantId = (vs[1] ?? vs[0])?.id ?? null; // 結果が無いので 2 番目のパターン(設計書 §4.2)
  return { mode: "same", variantId, name: nameFor(e, "same", variantId), nameEdited: false };
}

export function withMode(e: Experiment, s: DuplicateState, mode: DuplicateMode): DuplicateState {
  const m = effectiveMode(e, mode);
  return { ...s, mode: m, name: s.nameEdited ? s.name : nameFor(e, m, s.variantId) };
}

export function withVariant(e: Experiment, s: DuplicateState, variantId: string): DuplicateState {
  return { ...s, variantId, name: s.nameEdited ? s.name : nameFor(e, s.mode, variantId) };
}

export function withName(s: DuplicateState, name: string): DuplicateState {
  return { ...s, name, nameEdited: true };
}

export function duplicateVariantOptions(e: Experiment): PickerOption[] {
  return variantsOf(e).map((v) => ({ value: v.id, label: v.name, hint: v.changes.length > 0 ? `変更 ${v.changes.length} 件` : "変更なし" }));
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

export function duplicateBody(s: DuplicateState): { mode: DuplicateMode; variantId?: string; name: string } {
  return s.mode === "variant" && s.variantId !== null ? { mode: "variant", variantId: s.variantId, name: s.name } : { mode: "same", name: s.name };
}
