import type { Experiment, Status, Variant } from "@/lib/types";
import type { PageMatchValue } from "./page-match";
import { analyticsValueErrors, type AnalyticsValueError } from "./analytics-values";
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
  /** メモ(B77。保存は description だけの PATCH で送り、未公開の印を付けない) */
  description: string;
  urlMatch: PageMatchValue;
  targeting: TargetingDraft;
  traffic: number;
  persist: boolean;
  expName: string;
  extra: Record<string, string>;
  variants: Variant[];
};

export type TabProps = { draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void; ro: boolean };

/** タブの内部の ID(表示は「基本設定」/「パターン」)。B77 K16: 外部計測のタブは基本設定の下部のカードに移した。古い ?tab=analytics は readParam の既定で overview に落ちる */
export const EDITOR_TABS = ["overview", "variants"] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

export function draftOf(e: Experiment): Draft {
  return {
    name: e.name,
    description: e.description,
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

/** 保存の段(B77 K17)。下の saveSteps が決める */
export type SaveSteps = {
  /** (2) エクスペリエンスの欄(メモ以外)の PATCH */
  patchExperiment: boolean;
  /** (3) description だけの PATCH */
  experimentMemo: boolean;
  /** (4) PUT …/variants(下書きだけ。body に description を載せない) */
  putVariants: boolean;
  /** (5) PATCH …/variants/:vid でメモを送るパターンの ID */
  variantMemos: string[];
  /** (6) PUT …/changes を送るパターンの ID(オリジナルは送らない) */
  putChanges: string[];
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** PATCH に載るエクスペリエンスの欄(名前・対象 URL・配信条件・配信率・割当の固定・外部計測)。メモは載せない */
const experimentFields = (d: Draft) => [d.name, d.urlMatch, d.targeting, d.traffic, d.persist, d.expName, d.extra];
/** PUT …/variants に載るパターンの集合(並び・ID・名前・重み・オリジナル・外部計測)。メモと変更は別の段 */
const variantSet = (d: Draft) => d.variants.map((v) => [v.id, v.name, v.weight, v.original, v.analytics]);

/**
 * B77 K17: 保存の段を、初期値との差分で決める。変わった段だけを送るので、メモだけの保存は (3) と (5) だけになり
 * 「未公開の編集あり」を付けない。パターンの集合は下書きでしか変えられない(control が 409)。
 * 終了したエクスペリエンスはメモだけを送る(ほかの欄は読み取り専用)。
 * 新しいパターンは (4) で作られるので、メモと変更は保存済みの値が無い = 空と比べる
 */
export function saveSteps(initial: Draft, current: Draft, status: Status): SaveSteps {
  const before = new Map(initial.variants.map((v) => [v.id, v]));
  const archived = status === "archived";
  return {
    patchExperiment: !archived && !same(experimentFields(initial), experimentFields(current)),
    experimentMemo: initial.description !== current.description,
    putVariants: status === "draft" && !same(variantSet(initial), variantSet(current)),
    variantMemos: current.variants.filter((v) => v.description !== (before.get(v.id)?.description ?? "")).map((v) => v.id),
    putChanges: archived ? [] : current.variants.filter((v) => !v.original && !same(v.changes, before.get(v.id)?.changes ?? [])).map((v) => v.id),
  };
}

/** エクスペリエンスの外部計測を値の検査の形にする(名前の空欄は「指定なし」で、analyticsValueErrors が見ない) */
const experimentAnalyticsOf = (d: Draft) => ({ overrides: { experimentName: d.expName }, extra: d.extra });

/**
 * B77 K17 (1): 保存の前の値の検査。エクスペリエンス(path の先頭 = analytics)と各パターン(= variants, パターン ID)の外部計測を、
 * 保存済みの値と比べて検査する。変えていない古い値(マイグレーションで写した名前など)では止めない。新しいパターンは保存済みの値が無い
 */
export function draftValueErrors(initial: Draft, current: Draft): AnalyticsValueError[] {
  const before = new Map(initial.variants.map((v) => [v.id, v]));
  return [
    ...analyticsValueErrors(experimentAnalyticsOf(current), experimentAnalyticsOf(initial), ["analytics"]),
    ...current.variants.flatMap((v) => analyticsValueErrors(v.analytics, before.get(v.id)?.analytics ?? null, ["variants", v.id, "analytics"])),
  ];
}

/**
 * 保存が落ちた段から、その欄があるタブを決める(タブ名に印を付ける)。
 * エクスペリエンスの PATCH(メモだけの PATCH を含む)の欄は、外部計測(analytics)も含めてすべて「基本設定」(B77 K16)。
 * パターンの段(variants・パターンのメモ・changes)は「パターン」。path の先頭は今は見ないが、欄を分けるときのために受けておく
 */
export function failedTab(stage: "patch" | "variants" | "changes", _firstPathSegment: string | undefined): EditorTab {
  return stage === "patch" ? "overview" : "variants";
}
