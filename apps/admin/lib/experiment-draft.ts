import type { Experiment, Variant } from "@/lib/types";
import type { PageMatchValue } from "./page-match";
import { experimentFormFromDsl, experimentFormToDsl, type ExperimentForm } from "./targeting-tree";

/** 配信条件の状態。画面のフォームで表せない保存値(v0.9 の古い書式・API で作った入れ子)は raw のまま持ち、読み取り専用で見せる(plan ② P16) */
export type TargetingDraft = { kind: "form"; form: ExperimentForm } | { kind: "raw"; json: unknown };

/** PATCH の body の targeting。raw は送らない(ほかの欄の保存を止めない) */
export function targetingBody(t: TargetingDraft): { targeting?: unknown } {
  return t.kind === "form" ? { targeting: experimentFormToDsl(t.form) } : {};
}

/** 実験の編集フォームの state(全タブで共有する 1 つの値。タブを移っても失われない。設計書 4.4) */
export type Draft = {
  name: string;
  urlMatch: PageMatchValue;
  targeting: TargetingDraft;
  traffic: number;
  persist: boolean;
  expName: string;
  extra: Record<string, string>;
  variants: Variant[];
};

export type TabProps = { draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void; ro: boolean };

export const EDITOR_TABS = ["overview", "variants", "analytics"] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

export function draftOf(e: Experiment): Draft {
  return {
    name: e.name,
    urlMatch: e.urlMatch,
    targeting: ((form) => (form ? { kind: "form" as const, form } : { kind: "raw" as const, json: e.targeting }))(experimentFormFromDsl(e.targeting ?? null)),
    traffic: e.trafficPercentage,
    persist: e.persistAssignment,
    expName: e.analytics?.overrides?.experimentName ?? "",
    extra: e.analytics?.extra ?? {},
    variants: e.variants ?? [],
  };
}

/**
 * 未保存の判定。props から作った初期値との JSON 比較で足りる(キーの順は draftOf と set が保つ)。
 * 偽陽性はあり得る(例: Variant の analytics が null → 入力して消すと {})。安全側 = 未保存とみなす。実害は表示と「破棄」が押せることだけ
 */
export function isDirty(initial: Draft, current: Draft): boolean {
  return JSON.stringify(initial) !== JSON.stringify(current);
}

/**
 * 保存が落ちた段と、control の 422 が指す path の先頭から、その欄があるタブを決める(タブ名に印を付ける)。
 * PATCH の body は analytics 以外すべて「概要」の欄。variants / changes の段は「Variant」
 */
export function failedTab(stage: "patch" | "variants" | "changes", firstPathSegment: string | undefined): EditorTab {
  if (stage !== "patch") return "variants";
  return firstPathSegment === "analytics" ? "analytics" : "overview";
}
