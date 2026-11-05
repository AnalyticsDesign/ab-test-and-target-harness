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

/**
 * タブの内部の ID(表示は「基本設定」/「パターン」/「評価計画」/「結果」)。B77 K16: 外部計測のタブは基本設定の下部のカードに移した。古い ?tab=analytics は pickParam の既定で overview に落ちる。
 * plan(評価計画)と results(結果)はテストだけ(D9 ③ Task 14・15。パーソナライズでは呼び出し側が overview に落とす = tabsFor)。
 * 結果は下書きでは押せない(「開始後に表示されます」。設計書 §10)。
 * history(変更履歴。B129 spec §7.1)は全員・両方の種別に出し、並びの最後(パーソナライズではパターンの次)
 */
export const EDITOR_TABS = ["overview", "variants", "plan", "results", "history"] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

/** 種別ごとに出すタブ(評価計画と結果はテストだけ。設計書 §10。変更履歴は両方) */
export function tabsFor(kind: Experiment["kind"]): readonly EditorTab[] {
  return kind === "test" ? EDITOR_TABS : EDITOR_TABS.filter((t) => t !== "plan" && t !== "results");
}

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
  /** (7) PUT …/evaluation-plan(B173 第 1 段 Q12: 評価計画も同じ保存の帯で送る。最後の段) */
  putPlan: boolean;
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
export function saveSteps(initial: Draft, current: Draft, status: Status, plan?: { dirty: boolean }): SaveSteps {
  const before = new Map(initial.variants.map((v) => [v.id, v]));
  const archived = status === "archived";
  return {
    patchExperiment: !archived && !same(experimentFields(initial), experimentFields(current)),
    experimentMemo: initial.description !== current.description,
    putVariants: status === "draft" && !same(variantSet(initial), variantSet(current)),
    variantMemos: current.variants.filter((v) => v.description !== (before.get(v.id)?.description ?? "")).map((v) => v.id),
    putChanges: archived ? [] : current.variants.filter((v) => !v.original && !same(v.changes, before.get(v.id)?.changes ?? [])).map((v) => v.id),
    // 評価計画の未保存の判定は評価計画の側(lib/evaluation-plan.ts の planDirty)が持つので、結果だけを受ける
    putPlan: plan?.dirty ?? false,
  };
}

/** 送る段が 1 つでもあるか(評価計画の段を含む)。無ければ保存は破棄と同じにする(isDirty の偽陽性のとき) */
export function hasSteps(steps: SaveSteps): boolean {
  return steps.patchExperiment || steps.experimentMemo || steps.putVariants || steps.variantMemos.length > 0 || steps.putChanges.length > 0 || steps.putPlan;
}

/** 外部計測の PATCH の値。名前も追加の項目も無ければ null(設定を外す) */
const analyticsBody = (d: Draft) =>
  d.expName || Object.keys(d.extra).length ? { ...(d.expName ? { overrides: { experimentName: d.expName } } : {}), ...(Object.keys(d.extra).length ? { extra: d.extra } : {}) } : null;

/**
 * 配信率の欄が PATCH の body に載るか(自分が変えたときだけ載る)。experimentPatchBody と、画面の赤字(OverviewTab)が同じ条件を見るための関数
 */
export function isTrafficSent(initial: Draft, current: Draft): boolean {
  return initial.traffic !== current.traffic;
}

/**
 * 本体の PATCH の body(B173 第 1 段 Q10・spec §6.1)。自分が変えた欄だけを載せる: 開いた後にほかの人が変えた、自分の変えていない欄を上書きしないため
 * (control の PATCH はどの欄も省略できる)。外部計測は名前と追加の項目をまとめた 1 つの値なので、どちらかが変われば全体を送る。
 * 画面で表せない保存値(raw)の配信条件は送らない。メモ(description)は別の段で送るので載せない
 */
export function experimentPatchBody(initial: Draft, current: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (initial.name !== current.name) body.name = current.name;
  if (!same(initial.urlMatch, current.urlMatch)) body.urlMatch = current.urlMatch;
  if (!same(initial.targeting, current.targeting)) Object.assign(body, targetingBody(current.targeting));
  if (isTrafficSent(initial, current)) body.trafficPercentage = current.traffic;
  if (initial.persist !== current.persist) body.persistAssignment = current.persist;
  if (initial.expName !== current.expName || !same(initial.extra, current.extra)) body.analytics = analyticsBody(current);
  return body;
}

/**
 * 新しいサーバーの値が届いたとき(本体の作り直しをやめた後。B173 第 1 段 spec §6.1)の、基準(base)と下書き(draft)の決め方。
 * 未保存の変更が無ければ、その値で描き直す(自分の保存の後もこれ。保存の成功の直後に基準を送った値にしてあるので、未保存にならない)。
 * 未保存の変更があれば、下書きを残し、基準も開いたときの値のまま残す(次の保存で、自分が変えた欄だけを送るため)。
 * 届いた値が基準と違えば、注記(この画面を開いた後に、内容が更新されました)を出す
 */
export function reconcileServerUpdate(input: { base: Draft; draft: Draft; server: Draft }): { base: Draft; draft: Draft; notice: boolean } {
  const { base, draft, server } = input;
  if (!isDirty(base, draft)) return { base: server, draft: server, notice: false };
  return { base, draft, notice: !same(base, server) };
}

/**
 * 自分の保存の書き込みが成功した直後(読み直しの前)の、基準(base)と下書き(draft)。基準は送った内容(sent)にし、
 * 下書きは今の値(current)のまま残す。保存を始めた後に届いた変更(IMAGE の欄のアップロードが終わって src を変えた、など)は
 * 送った内容との差として未保存に残り、保存の帯・離れる前の確認にそのまま出る(I2: 送った内容で上書きすると、その変更が黙って消える)。
 * 保存の途中に何も変わっていなければ current は sent と同じなので、未保存は無くなる
 */
export function acceptSavedDraft(sent: Draft, current: Draft): { base: Draft; draft: Draft } {
  return { base: sent, draft: current };
}

/**
 * 破棄で戻す値(B189。オーディエンスの破棄と同じ考え)。saved = 自分の保存で送った値(下の savedAfter が持つ間だけ)。
 * 保存の後の読み直しが時間切れで props が保存の前の値のままでも、破棄で保存の前の値へ戻さない。持っていなければ、届いているサーバーの値
 */
export function discardTarget(input: { server: Draft; saved: Draft | null }): Draft {
  return input.saved ?? input.server;
}

/** 破棄の戻り先(saved)を動かす出来事。written = 自分の保存の書き込みが成功した直後(読み直しの前)・serverArrived = 新しいサーバーの値が届いた・refreshed = 自分の保存の後の読み直しが終わった */
export type SavedEvent = { kind: "written"; sent: Draft } | { kind: "serverArrived" } | { kind: "refreshed"; timedOut: boolean };

/**
 * B189: 破棄の戻り先として送った値を持つのは、書き込みの成功の後、画面が新しいサーバーの値になるまでの間だけ。
 * - written: 送った値を持つ
 * - serverArrived: 捨てる(届いた値が戻り先になる)
 * - refreshed: 読み直しが画面に反映されたら捨てる(評価計画だけの保存のように、サーバーの値の鍵が変わらない保存でも残さない。最終レビュー M1)。
 *   時間切れなら持ち続ける(props は保存の前の値のままのため)
 * 守らない場面: 前の保存の時間切れの読み直しが、次の保存の written の後に遅れて届くと、serverArrived で捨て、届いた値(前の保存の値)が戻り先になる。
 * これは直す前の reconcileServerUpdate と同じ挙動で、悪くはしていない
 */
export function savedAfter(saved: Draft | null, event: SavedEvent): Draft | null {
  switch (event.kind) {
    case "written":
      return event.sent;
    case "serverArrived":
      return null;
    case "refreshed":
      return event.timedOut ? saved : null;
  }
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
 * パターンの段(variants・パターンのメモ・changes)は「パターン」。評価計画の段は「評価計画」。path の先頭は今は見ないが、欄を分けるときのために受けておく
 */
export function failedTab(stage: "patch" | "variants" | "changes" | "plan", _firstPathSegment: string | undefined): EditorTab {
  if (stage === "plan") return "plan";
  return stage === "patch" ? "overview" : "variants";
}
