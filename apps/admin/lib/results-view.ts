import { effectiveThreshold, type DiffSummary, type EvaluationPlan, type Note, type VerdictState } from "@wtt/stats";
import type { HelpKey } from "@/generated/help.ja";
import { initialDuplicateState, withMode, withVariant, type DuplicateState } from "./duplicate";
import { formatLocalTime } from "./local-time";
import { fmtInt, monthDay, pct, probPct, sgn, STATE_LABEL } from "./result-format";
import type { Experiment, Status } from "./types";

/**
 * D9 ③ Task 15: 結果のタブの表示モデル(設計書 §7.3・§7.4・§10、モック (b) の結果)。
 * 結果の API(`GET /sites/:sid/experiments/:eid/results`)の応答から、帯・パターンのカード・差の図・品質・詳しい数値・端末別・
 * ほかの目標・採用の記録の中身を作る純粋関数。日付はサイトのタイムゾーンで書く(設計書 §5.3。描画はマウントの後 = クライアントで取得してから)。
 * 画面に「信頼度」「有意」「p 値」「対照」は出さない(設計書 §2・§7.4)。割り振りの偏りの検定の値も数字では出さない
 */

// ---------------------------------------------------------------------------
// 応答の形(control の ResultReportSchema と同じ。admin は control を import しない)
// ---------------------------------------------------------------------------

export type NormalDiff = { mean: number; ci95: [number, number] };
export type ResultVariant = {
  id: string;
  name: string;
  original: boolean;
  weight: number;
  n: number;
  y: number;
  cvr: number;
  cvrCi95: [number, number];
  diff: DiffSummary | null;
  state: VerdictState | null;
  probBest: number | null;
  applyFailed: number;
  applyRecovered: number;
  minCountMet: boolean | null;
};
export type ResultReport = {
  phase: "interim" | "fixed" | "stopped";
  stoppedEarly: boolean;
  quality: "ok" | "warning" | "blocked";
  records: "available" | "purged";
  collection: "enabled" | "site_disabled" | "store_missing" | "not_recorded";
  persisted: boolean;
  computedAt: number | null;
  cutoff: number | null;
  plan: EvaluationPlan | null;
  evaluation: { minEnd: number; maxEnd: number; evaluationAt: number; reachedAt: number | null } | null;
  variants: ResultVariant[];
  qualityDetail: { srmP: number | null; mixedRate: number; stopRatio: number; stopLimit: number; stopPeriods: Array<{ reason: string; from: number; to: number }>; failedSends: number; failureRatio: number };
  byDevice: Array<{ variantId: string; device: "desktop" | "mobile" | "tablet"; n: number; y: number; cvr: number; diff: NormalDiff | null }>;
  otherGoals: Array<{ goalId: string; name: string; variants: Array<{ variantId: string; n: number; y: number; cvr: number; diff: NormalDiff | null }> }>;
  planChanges: number;
  deliveryChanges: Array<{ at: number; parts: string[]; version: number }>;
  adoption: { variantId: string | null; note: string; decidedAt: number; decidedBy: string | null } | null;
  snapshots: { evaluation: boolean; stop: boolean };
  notes: Note[];
  statsVersion: string;
  helpKeys: string[];
};
/**
 * 結果の API の応答 = 本体 + 配信していた定義でパターンごとに Change があるか(終了のモーダルが使う)。
 * 結果の記録(評価時点・終了の記録)を返したときは、記録に写した名前と定義も付く
 */
export type ResultsResponse = ResultReport & {
  deliveredChanges?: Record<string, boolean> | null;
  names?: { experiment: string; variants: Record<string, { name: string; original: boolean }>; goals: Record<string, string> };
  definition?: unknown;
};

// ---------------------------------------------------------------------------
// 表示モデル
// ---------------------------------------------------------------------------

/** 帯の操作。stop = 終了して採用を記録(variantId = 最初に選ぶ採用。null = 採用なし)/ duplicate-adopted = 採用したパターンだけを表示する下書き */
export type ResultAction = { kind: "stop"; label: string; variantId: string | null } | { kind: "duplicate-adopted"; label: string; variantId: string };
export type BannerTone = "early" | "win" | "bad" | "dq" | "stop" | "none";
export type Banner = {
  tone: BannerTone;
  /** 帯の左上の状態(速報 / 採用候補 / 判定不可 …) */
  state: string;
  title: string;
  body: string;
  /** 大きく出す確率 */
  key: { label: string; value: string; sub: string } | null;
  /** 評価時点までの進み具合(速報で、今の時刻があるときだけ) */
  progress: { value: number; max: number; label: string } | null;
  help: { key: HelpKey; label: string };
  primary?: ResultAction;
  secondary?: ResultAction;
  /** 操作の横の補足(採用の記録済みなど) */
  status?: string;
};
export type Callout = { tone: "info" | "warn"; text: string; helpKey?: HelpKey };
export type VariantCard = {
  variantId: string;
  title: string;
  isBaseline: boolean;
  cvrText: string;
  cvrRange: string;
  countText: string;
  diffText: string | null;
  diffSign: "pos" | "neg" | null;
  probLabel: string;
  probText: string | null;
  meter: { value: number; threshold: number } | null;
  state: VerdictState | null;
  stateLabel: string | null;
  stateTone: "win" | "bad" | "none" | null;
  win: boolean;
  /** 品質の問題で判定不可のとき薄く出す */
  dim: boolean;
  /** 重み 0(配信していない) */
  notDelivered: boolean;
};
export type QualityRow = { level: "ok" | "warn" | "bad"; title: string; value: string; note?: string; helpKey: HelpKey };
export type SegmentCell = { variantId: string; cvr: string; n: string; diff: string | null };
export type ResultsView = {
  banner: Banner | null;
  /** 数値が無い応答の理由(数値があれば null) */
  empty: { title: string; body: string; helpKey?: HelpKey } | null;
  callouts: Callout[];
  /** 判定に使う目標の名前(読めなければ ID) */
  goalName: string | null;
  /** 評価計画の 1 行の要約 */
  planLine: string | null;
  planChanges: number;
  cards: VariantCard[];
  diffChart: Array<{ variantId: string; name: string; mean: number; ci95: [number, number]; text: string; range: string }>;
  diffAxis: { min: number; max: number; ticks: number[]; delta: number | null };
  quality: { folded: boolean; level: "ok" | "warn" | "bad"; headline: string; rows: QualityRow[] };
  details: {
    probLabel: string;
    showBest: boolean;
    rows: Array<{ variantId: string; name: string; isBaseline: boolean; n: string; y: string; cvr: string; cvrRange: string; diff: string | null; diffRange: string | null; prob: string | null; best: string | null; loss: string | null }>;
    footnote: string;
  };
  byDevice: { columns: string[]; rows: Array<{ label: string; cells: SegmentCell[] }> };
  otherGoals: Array<{ goalId: string; name: string; cells: SegmentCell[] }>;
  adoption: { title: string; summary: string | null; note: string; decidedAt: number; decidedBy: string | null } | null;
};

export type ResultsViewContext = {
  /** サイトのタイムゾーン(日付の表示) */
  timeZone: string;
  /** エクスペリエンスの今の状態(応答には無い。評価時点の後の知らせ・帯の操作を決める) */
  status: Status;
  /** 今の時刻(マウント前は null。null なら「あと n 日」と進み具合を出さない) */
  now: number | null;
  /** サイトの目標(判定に使う目標の名前。記録に写した名前が無いとき) */
  goals?: Array<{ id: string; name: string }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 書式
// ---------------------------------------------------------------------------

/** しきい値(%)。小数は 2 桁まで(97.5 / 98.33) */
const thresholdText = (t: number): string => String(Number(t.toFixed(2)));

export { monthDay };
/** 月/日 時:分(サイトのタイムゾーン。時刻の書式は formatLocalTime と同じ)。不正なタイムゾーン名は UTC に落とす */
function monthDayTime(at: number, timeZone: string): string {
  try {
    return formatLocalTime(at, "deadline", timeZone);
  } catch {
    return formatLocalTime(at, "deadline", "UTC");
  }
}

const diffText = (d: { mean: number; relMean: number | null }): string => `${sgn(d.mean, 2)} ポイント${d.relMean === null ? "" : `(${sgn(d.relMean, 0)}%)`}`;
const rangeText = (ci: [number, number]): string => `${sgn(ci[0], 2)} 〜 ${sgn(ci[1], 2)}`;
const normalDiffText = (d: NormalDiff): string => `${sgn(d.mean, 2)} ポイント(${rangeText(d.ci95)})`;

const STATE_TONE: Record<VerdictState, "win" | "bad" | "none"> = { blocked_quality: "none", adopt: "win", worse: "bad", equivalent: "none", insufficient: "none" };
// 判定に要る最低の件数に届かない比較に添える。CVR の列は観測の値(y / n)、区間と差は事後分布(Beta(1, 1) の事前分布)から
// 出すので、人数が少ないと 2 つが合わない(B109。例: 1 人中 0 人の CVR 0.00% に区間 1.26〜84.19%)
const SMALL_N_MISMATCH = "人数が少ないうちは、区間と差が CVR の列から計算した値と合いません";
const DEVICE_LABEL = { desktop: "デスクトップ", mobile: "モバイル", tablet: "タブレット" } as const;
const DEVICE_ORDER = ["desktop", "mobile", "tablet"] as const;

/** 基準との差があるパターン */
type WithDiff = ResultVariant & { diff: DiffSummary };
const hasDiff = (v: ResultVariant): v is WithDiff => v.diff !== null;

/** 注記の params の数(無い・数でなければ null) */
function num(n: Note | undefined, key: string): number | null {
  const v = n?.params?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(n: Note | undefined, key: string): string | null {
  const v = n?.params?.[key];
  return typeof v === "string" ? v : null;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export function resultsView(report: ResultsResponse, ctx: ResultsViewContext): ResultsView {
  const tz = ctx.timeZone;
  const notes = report.notes;
  const noteOf = (key: string) => notes.find((n) => n.key === key);
  const notesOf = (key: string) => notes.filter((n) => n.key === key);
  const nameOf = (id: string | null | undefined): string => {
    if (!id) return "";
    return report.variants.find((v) => v.id === id)?.name ?? report.names?.variants[id]?.name ?? id;
  };
  const plan = report.plan;
  const baselineId = plan?.baselineVariantId ?? null;
  const zeroWeight = new Set(notesOf("zero_weight").map((n) => str(n, "variantId")).filter((x): x is string => x !== null));
  const delivered = (v: ResultVariant) => v.weight > 0 && !zeroWeight.has(v.id);
  const active = report.variants.filter(delivered);
  const compared = active.filter((v) => v.id !== baselineId);
  const comparisons = Math.max(1, compared.length);
  const threshold = plan ? (comparisons > 1 ? effectiveThreshold(plan.threshold, comparisons) : plan.threshold) : 95;
  const delta = plan?.delta ?? 0;
  const probLabel = delta > 0 ? `+${delta} ポイントを超えて上回る確率` : "基準を上回る確率";
  const shortProbLabel = delta > 0 ? `+${delta} ポイントを超えて上回る確率` : "上回る確率";
  const blocked = report.quality === "blocked";
  const interim = report.phase === "interim";
  const stopped = report.phase === "stopped";
  const goalId = plan?.primaryGoalId ?? null;
  const goalName = goalId === null ? null : (report.names?.goals[goalId] ?? ctx.goals?.find((g) => g.id === goalId)?.name ?? goalId);
  const fixedAt = report.cutoff ?? report.evaluation?.evaluationAt ?? null;

  // 数値の無い応答
  const empty = report.variants.length === 0 ? emptyReason(report, noteOf) : null;

  // ---- 知らせ(帯の上に並べる) ----
  const callouts: Callout[] = [];
  const purged = noteOf("purged");
  if (report.records === "purged" && report.variants.length > 0) {
    const days = num(purged, "days");
    const which = stopped ? "終了の時点" : "評価時点";
    callouts.push({ tone: "info", text: `参加者ごとの記録は削除済みです${days === null ? "" : `(保持期間 ${days} 日)`}。表示しているのは${which}に固定した結果です`, helpKey: "retention" });
  }
  if (report.phase === "fixed" && ctx.status !== "archived") {
    callouts.push({ tone: "info", text: "評価時点で記録を終えました。テストを終了して採用を記録してください(配信は終了するまで続きます)", helpKey: "evaluation-point" });
  }
  const stale = noteOf("interim_stale");
  if (stale && report.variants.length > 0) {
    const at = num(stale, "computedAt") ?? report.computedAt;
    const when = at === null ? "" : `(${monthDayTime(at, tz)} 時点)`;
    callouts.push({ tone: "warn", text: `前に計算した速報を表示しています${when}。${staleReason(str(stale, "reason"))}` });
  }
  if (report.collection === "site_disabled") {
    callouts.push({ tone: "warn", text: "サイトの設定で結果の記録を無効にしています。無効の間は参加と CV を記録しません(止めていた時間は収集の停止に数えます)", helpKey: "collection-stops" });
  }
  for (const n of notesOf("min_count_not_met")) {
    callouts.push({ tone: "info", text: `${nameOf(str(n, "variantId"))}: CV の件数が少なすぎるため判定しません(目安: 比べる 2 つのパターンのそれぞれで、CV の見込みが 10 件以上)。${SMALL_N_MISMATCH}`, helpKey: "verdicts" });
  }
  if (noteOf("aa_test")) callouts.push({ tone: "info", text: "A/A テストです(基準とほかのパターンに変更がありません)。差が出ないことを確かめるためのテストとして読んでください" });
  if (noteOf("baseline_not_original")) callouts.push({ tone: "info", text: "基準はオリジナルではありません", helpKey: "baseline" });
  for (const n of notesOf("unpublished_changes")) {
    callouts.push({ tone: "info", text: `${nameOf(str(n, "variantId"))} に未公開の編集があります。テストで配信したのは編集の前の中身です` });
  }
  for (const n of notesOf("edited_after_evaluation")) {
    callouts.push({ tone: "info", text: `評価時点の後に ${nameOf(str(n, "variantId"))} の変更が編集されています` });
  }
  if (noteOf("definition_missing")) callouts.push({ tone: "info", text: "配信していた定義の写しを取り出せなかったため、この記録には定義の写しがありません(数値と判定は記録のとおり)" });

  // ---- パターンのカード ----
  const cards: VariantCard[] = report.variants.map((v) => {
    const isBaseline = v.id === baselineId;
    const notDelivered = !delivered(v);
    const prob = !isBaseline && !notDelivered && v.diff !== null ? v.diff.pAboveDelta : null;
    let stateLabel: string | null = null;
    let stateTone: VariantCard["stateTone"] = null;
    if (notDelivered) {
      stateLabel = "配信していない";
    } else if (!isBaseline) {
      if (interim) stateLabel = "判定前(速報)";
      else if (report.phase === "fixed" && !blocked && v.state !== null) {
        stateLabel = STATE_LABEL[v.state];
        stateTone = STATE_TONE[v.state];
      }
      // 評価時点前の終了と判定不可はラベルを出さない(帯が理由を出す。モック)
    }
    const win = stateTone === "win";
    return {
      variantId: v.id,
      title: v.name,
      isBaseline,
      cvrText: pct(v.cvr, 2),
      cvrRange: `${pct(v.cvrCi95[0], 2)} 〜 ${pct(v.cvrCi95[1], 2)}`,
      countText: `${fmtInt(v.n)} 人中 ${fmtInt(v.y)} 人`,
      diffText: isBaseline || notDelivered || v.diff === null ? null : diffText(v.diff),
      diffSign: isBaseline || notDelivered || v.diff === null ? null : v.diff.mean >= 0 ? "pos" : "neg",
      probLabel: shortProbLabel,
      probText: prob === null ? null : probPct(prob),
      meter: prob === null ? null : { value: Number((prob * 100).toFixed(1)), threshold: Number(threshold.toFixed(2)) },
      state: notDelivered || isBaseline ? null : v.state,
      stateLabel,
      stateTone,
      win,
      dim: blocked,
      notDelivered,
    };
  });

  // ---- 差の図 ----
  const diffRows = compared.filter(hasDiff).map((v) => ({ variantId: v.id, name: v.name, mean: v.diff.mean, ci95: v.diff.ci95, text: `${sgn(v.diff.mean, 2)} ポイント`, range: rangeText(v.diff.ci95) }));
  const diffAxis = axisFor(diffRows.flatMap((d) => d.ci95), delta > 0 ? delta : null);

  // ---- 帯 ----
  const banner = empty ? null : bannerFor();

  function bannerFor(): Banner {
    const base = report.variants.find((v) => v.id === baselineId) ?? null;
    const bestBy = <T extends ResultVariant>(list: T[], key: (v: T) => number) => list.reduce<T | null>((b, v) => (b === null || key(v) > key(b) ? v : b), null);
    const withDiff = compared.filter(hasDiff);
    const best = bestBy(withDiff, (v) => v.diff.pAboveDelta);
    const keyFor = (v: WithDiff | null, label: string, sub: string) => (v ? { label, value: probPct(v.diff.pAboveDelta), sub } : null);
    const evaluationAt = report.evaluation?.evaluationAt ?? null;
    const fixedText = fixedAt === null ? "" : `評価時点(${monthDay(fixedAt, tz)})の値で固定`;
    const archived = ctx.status === "archived";
    const thr = `しきい値 ${thresholdText(threshold)}%`;

    if (interim) {
      // 速報は品質に問題があっても状態のラベル(判定不可)を出さない。問題はデータ品質の欄が出す(設計書 §7.3)
      const startedAt = report.evaluation && plan ? report.evaluation.minEnd - plan.minDays * DAY_MS : null;
      const target = plan?.targetPerVariant ?? null;
      const waitingTarget = target !== null && report.evaluation?.reachedAt === null;
      const qualityNote = blocked ? "データ品質に問題があります(下の「データ品質」を確かめてください)。" : "";
      const key = keyFor(best, `いまの${probLabel}`, `${best?.name ?? ""}・速報値`);
      const help = { key: "evaluation-point" as const, label: "評価時点とは" };
      if (evaluationAt === null || report.evaluation === null) {
        return { tone: "early", state: "速報", title: "速報", body: `${qualityNote}早い時期の数値は大きく揺れるので、ここで採用を決めないでください`, key, progress: null, help };
      }
      const when = monthDay(evaluationAt, tz);
      const past = ctx.now !== null && ctx.now >= evaluationAt;
      const title = past ? "評価時点を過ぎました。結果の記録はこの後に作られます" : waitingTarget ? `速報(判定は遅くとも ${when} までに出ます)` : `速報(判定は ${when} に出ます)`;
      const parts: string[] = [];
      let progress: Banner["progress"] = null;
      if (ctx.now !== null && startedAt !== null && !past) {
        // 日目は 1 から数える(開始の日 = 1 日目。モックの「7 / 14 日」と同じ数え方)
        const total = Math.max(1, Math.round((evaluationAt - startedAt) / DAY_MS));
        const day = Math.min(total, Math.max(0, Math.floor((ctx.now - startedAt) / DAY_MS)) + 1);
        const left = Math.max(0, Math.ceil((evaluationAt - ctx.now) / DAY_MS));
        parts.push(`いまは ${day} 日目です(あと ${left} 日)。`);
        progress = { value: day, max: total, label: `${day} / ${total} 日` };
      }
      if (waitingTarget && target !== null) parts.push(`目標参加者数(パターンごとに ${fmtInt(target)} 人)に届くと、最低期間の終わり(${monthDay(report.evaluation.minEnd, tz)})以降に判定します。`);
      parts.push(qualityNote);
      parts.push(past ? "表示は前に計算した速報です。" : "早い時期の数値は大きく揺れるので、ここで採用を決めないでください。");
      return { tone: "early", state: "速報", title, body: parts.join(""), key, progress, help };
    }

    // 評価時点前の終了の日付(判定不可の帯にも添える)
    const stoppedNote = noteOf("stopped_early");
    const stoppedAt = stopped ? (num(stoppedNote, "stoppedAt") ?? report.cutoff) : null;
    const planned = num(stoppedNote, "evaluationAt");
    const stoppedText = stoppedAt === null ? "評価時点の前に終了しました" : `${monthDay(stoppedAt, tz)} に評価時点の前に終了しました${planned === null ? "" : `(評価時点は ${monthDay(planned, tz)} の予定)`}`;

    if (blocked) {
      return {
        tone: "dq",
        state: "判定不可",
        title: "データ品質に問題があるため、判定できません",
        body: `${blockedBody()}${stopped ? `。${stoppedText}` : ""}`,
        key: null,
        progress: null,
        help: { key: "quality", label: "データ品質とは" },
        ...adoptionActions(),
      };
    }
    if (stopped) {
      const title = stoppedAt === null ? "評価時点の前に終了しました" : `${monthDay(stoppedAt, tz)} に終了しました${planned === null ? "" : `(評価時点は ${monthDay(planned, tz)} の予定)`}`;
      return {
        tone: "stop",
        state: "評価時点前に終了",
        title,
        body: "終了した時点の値で記録しています。予定より早く止めたので、確率は参考として扱ってください。確かめたい場合は、同じ内容でもう一度テストします",
        key: keyFor(best, probLabel, `${best?.name ?? ""}・終了時点`),
        progress: null,
        help: { key: "evaluation-point", label: "評価時点とは" },
        ...adoptionActions(),
      };
    }

    // 評価時点の記録
    const thresholdNote = comparisons > 1 ? `${active.length} つのパターンのため、しきい値 ${thresholdText(threshold)}% で判定しています。` : "";
    const help = { key: "verdicts" as const, label: "判定の読み方" };
    const wins = withDiff.filter((v) => v.state === "adopt");
    if (wins.length > 0) {
      // 採用候補が複数なら、最良である確率(無ければ上回る確率)の高い方を先に
      const rank = (v: WithDiff) => v.probBest ?? v.diff.pAboveDelta;
      const sorted = [...wins].sort((a, b) => rank(b) - rank(a));
      const w = sorted[0]!;
      const cvr = base ? `CVR ${pct(base.cvr, 2)} → ${pct(w.cvr, 2)}(${sgn(w.diff.mean, 2)} ポイント${w.diff.relMean === null ? "" : `、${sgn(w.diff.relMean, 0)}%`})。` : "";
      const bests = sorted.map((x) => (x.probBest === null ? null : `${x.name} ${probPct(x.probBest)}`));
      const many = sorted.length > 1 && bests.every((x) => x !== null) ? `最良である確率: ${bests.join("・")}。` : "";
      return {
        tone: "win",
        state: "採用候補",
        title: `${sorted.map((x) => x.name).join("・")} が基準より良い可能性が高い`,
        body: `${cvr}${thresholdNote}${many}${fixedText}`,
        key: keyFor(w, probLabel, thr),
        progress: null,
        help,
        ...(archived ? adoptionActions() : { primary: { kind: "stop", label: "終了して採用を記録", variantId: w.id } }),
      };
    }
    const stopNone = archived ? adoptionActions() : { primary: { kind: "stop" as const, label: "採用なしで終了", variantId: null } };
    const equivalent = withDiff.filter((v) => v.state === "equivalent");
    if (equivalent.length > 0) {
      const within = bestBy(
        equivalent.filter((v) => v.diff.pWithinRope !== null),
        (v) => v.diff.pWithinRope ?? 0,
      );
      return {
        tone: "none",
        state: "実務上ほぼ同等",
        title: `${equivalent.map((x) => x.name).join("・")} は基準と実務上ほぼ同等です`,
        body: `差が同等とみなす幅(±${plan?.rope ?? 0} ポイント)に収まる確率が、しきい値 ${thresholdText(threshold)}% 以上です。手間や好みで選んで構いません。${thresholdNote}${fixedText}`,
        key: within?.diff.pWithinRope != null ? { label: "同等とみなす幅に収まる確率", value: probPct(within.diff.pWithinRope), sub: thr } : null,
        progress: null,
        help,
        ...stopNone,
      };
    }
    const worse = withDiff.filter((v) => v.state === "worse");
    const worst = bestBy(worse, (x) => x.diff.pBelowZero);
    if (worst && worse.length === withDiff.length) {
      return {
        tone: "bad",
        state: "悪化の可能性が高い",
        title: `${worse.map((x) => x.name).join("・")} は基準より悪い可能性が高い`,
        body: `${worst.name} が基準を下回る確率は ${probPct(worst.diff.pBelowZero)} で、しきい値 ${thresholdText(threshold)}% 以上です。採用しないでください。${thresholdNote}${fixedText}`,
        key: { label: "基準を下回る確率", value: probPct(worst.diff.pBelowZero), sub: thr },
        progress: null,
        help,
        ...stopNone,
      };
    }

    // 判断材料が不足。判定に要る最低の件数に届かなかった比較は、確率がしきい値に届かなかったとは書かない(verdict が確率を見ずに不足にする)
    const countShort = new Set(notesOf("min_count_not_met").map((n) => str(n, "variantId")));
    const short = withDiff.filter((v) => v.state !== "worse" && (v.minCountMet === false || countShort.has(v.id)));
    const judged = withDiff.filter((v) => v.state !== "worse" && !short.includes(v));
    const top = bestBy(judged, (v) => v.diff.pAboveDelta);
    const parts: string[] = [];
    if (top) parts.push(`${top.name} が${delta > 0 ? ` +${delta} ポイントを超えて` : ""}上回る確率は ${probPct(top.diff.pAboveDelta)} で、${thr} に届きません。`);
    if (short.length > 0) parts.push(`${top ? `${short.map((x) => x.name).join("・")}: ` : ""}CV の件数が少なすぎるため判定しません(目安: 比べる 2 つのパターンのそれぞれで、CV の見込みが 10 件以上)。数値は参考として出しています。${SMALL_N_MISMATCH}。`);
    for (const w of worse) parts.push(`${w.name} は基準より悪い可能性が高い(下回る確率 ${probPct(w.diff.pBelowZero)})。`);
    parts.push(`「差が無い」という意味ではありません。${thresholdNote}${fixedText}`);
    return {
      tone: "none",
      state: "判断材料が不足",
      title: top ? "この人数では決着がつきませんでした" : short.length > 0 ? "CV の件数が少なすぎるため判定しません" : "この人数では決着がつきませんでした",
      body: parts.join(""),
      key: keyFor(top, probLabel, thr),
      progress: null,
      help,
      ...stopNone,
    };
  }

  /** 終了したテストの帯の操作: 採用を記録していれば、そのパターンだけを表示する下書きを作る */
  function adoptionActions(): Pick<Banner, "primary" | "status"> {
    if (ctx.status !== "archived") return {};
    const a = report.adoption;
    if (a === null) return { status: "採用は未記録です" };
    const day = monthDay(a.decidedAt, tz);
    if (a.variantId === null) return { status: `採用なしを記録済み(${day})` };
    const name = nameOf(a.variantId);
    return { primary: { kind: "duplicate-adopted", label: `${name} だけを表示する下書きを作成`, variantId: a.variantId }, status: `${name} の採用を記録済み(${day})` };
  }

  function blockedBody(): string {
    const tail = "比べる前提が崩れているので、下の数値は参考にとどめ、採用の根拠にしないでください";
    if (noteOf("quality_blocked_srm")) return `割り振りの人数が設定した重みから大きくずれています。${tail}`;
    if (noteOf("quality_blocked_mixed")) return `複数のパターンを見た人の割合が 1% を超えています。${tail}`;
    const stops = noteOf("quality_blocked_stops");
    if (stops) {
      const limit = num(stops, "limit") ?? report.qualityDetail.stopLimit;
      return `収集を止めていた時間が上限(期間の ${pct(limit)})を超えています。${tail}`;
    }
    return `データ品質の検査で問題が見つかりました。${tail}`;
  }

  // ---- 品質 ----
  const quality = qualityOf(report, noteOf, nameOf);

  // ---- 評価計画の 1 行 ----
  const planLine = plan
    ? [`最低 ${plan.minDays} 日`, `最大 ${plan.maxWeeks} 週`, ...(plan.targetPerVariant !== null ? [`目標 ${fmtInt(plan.targetPerVariant)} 人 / パターン`] : []), `しきい値 ${thresholdText(threshold)}%`, ...(delta > 0 ? [`最小改善幅 +${delta} ポイント`] : []), ...(plan.rope !== null ? [`同等とみなす幅 ±${plan.rope} ポイント`] : [])].join("・")
    : null;

  // ---- 詳しい数値 ----
  const showBest = report.variants.some((v) => v.probBest !== null);
  const details: ResultsView["details"] = {
    probLabel,
    showBest,
    rows: report.variants.map((v) => {
      const isBaseline = v.id === baselineId;
      const d = isBaseline || !delivered(v) ? null : v.diff;
      return {
        variantId: v.id,
        name: v.name,
        isBaseline,
        n: fmtInt(v.n),
        y: fmtInt(v.y),
        cvr: pct(v.cvr, 2),
        cvrRange: `${pct(v.cvrCi95[0], 2)} 〜 ${pct(v.cvrCi95[1], 2)}`,
        diff: d ? `${sgn(d.mean, 2)} ポイント${d.relMean === null ? "" : `(${sgn(d.relMean, 1)}%)`}` : null,
        diffRange: d ? `${rangeText(d.ci95)} ポイント` : null,
        prob: d ? probPct(d.pAboveDelta) : null,
        best: v.probBest === null ? null : probPct(v.probBest),
        loss: d ? `${d.expectedLossPer10k.toFixed(2)} 件` : null,
      };
    }),
    footnote: `統計モデル Beta-Binomial・事前分布 Beta(1, 1)・計算の版 ${report.statsVersion}。CV は初めて表示された後から${stopped ? "終了" : "評価時点"}までを数えています。CVR は CV した人 ÷ 参加者で、区間・差・確率・期待損失は統計モデルから出すため、参加者が少ないと CVR の列と合わないことがあります。受け取れた送信の集計のため、GA4 とは数字が一致しません`,
  };

  // ---- 端末別・ほかの目標 ----
  const columns = report.variants.map((v) => v.name);
  const cellsFor = (rows: Array<{ variantId: string; n: number; cvr: number; diff: NormalDiff | null }>): SegmentCell[] =>
    report.variants.map((v) => {
      const r = rows.find((x) => x.variantId === v.id);
      return { variantId: v.id, cvr: r ? pct(r.cvr, 1) : "—", n: r ? `${fmtInt(r.n)} 人` : "0 人", diff: r?.diff && v.id !== baselineId ? normalDiffText(r.diff) : null };
    });
  const byDevice = {
    columns,
    rows: DEVICE_ORDER.filter((d) => report.byDevice.some((x) => x.device === d)).map((d) => ({ label: DEVICE_LABEL[d], cells: cellsFor(report.byDevice.filter((x) => x.device === d)) })),
  };
  const otherGoals = report.otherGoals.map((g) => ({ goalId: g.goalId, name: g.name, cells: cellsFor(g.variants) }));

  // ---- 採用の記録 ----
  let adoption: ResultsView["adoption"] = null;
  if (report.adoption) {
    const a = report.adoption;
    const v = report.variants.find((x) => x.id === a.variantId) ?? null;
    let title = "採用なし";
    let summary: string | null = null;
    if (a.variantId !== null) {
      const isBaseline = a.variantId === baselineId;
      title = `採用: ${nameOf(a.variantId)}${isBaseline ? "(基準)" : ""}`;
      if (!isBaseline && v?.diff) {
        const label = report.phase === "fixed" && !blocked && v.state !== null ? `、判定「${STATE_LABEL[v.state]}」` : stopped ? "、評価時点前に終了" : "";
        summary = `${diffText(v.diff)}、${shortProbLabel} ${probPct(v.diff.pAboveDelta)}${label}`;
      }
    }
    adoption = { title, summary, note: a.note, decidedAt: a.decidedAt, decidedBy: a.decidedBy };
  }

  return {
    banner,
    empty,
    callouts,
    goalName,
    planLine,
    planChanges: report.planChanges,
    cards,
    diffChart: diffRows,
    diffAxis,
    quality,
    details,
    byDevice,
    otherGoals,
    adoption,
  };
}

/**
 * 「<採用> だけを表示する下書きを作成」で開く複製の画面の最初の状態: 選んだパターンだけを表示する方式で、採用したパターンを選ぶ。
 * 選べないパターン(オリジナル)や、その方式を選べないテストでは、ふつうの最初の状態のまま
 */
export function adoptedDuplicateState(e: Experiment, variantId: string): DuplicateState {
  return withVariant(e, withMode(e, initialDuplicateState(e), "variant"), variantId);
}

/** 前に計算した速報を返した理由(interim_stale の reason) */
function staleReason(reason: string | null): string {
  if (reason === "budget") return "今日の読み取りの上限に達したため、更新は UTC 0 時以降になります";
  if (reason === "busy") return "ほかの集計が読み取り中のため更新できませんでした。少し時間をおいて読み込み直してください";
  return "今は更新できませんでした。少し時間をおいて読み込み直してください";
}

/** 数値の無い応答の理由 */
function emptyReason(report: ResultsResponse, noteOf: (key: string) => Note | undefined): NonNullable<ResultsView["empty"]> {
  if (report.collection === "not_recorded" || noteOf("not_recorded")) {
    return {
      title: "このテストは結果を記録せずに開始しました",
      body: "結果はツール上に残りません。後から結果の記録を有効にしても、このテストの結果は記録されません。結果を見たいときは、サイトの設定で「結果を記録する」を有効にしてから、複製して開始し直してください",
      helpKey: "enable",
    };
  }
  if (report.collection === "store_missing" || noteOf("store_missing")) {
    return { title: "計測用のデータベースが導入されていません", body: "この導入には結果を集計するデータベースが無いため、結果を表示できません。導入の手順で計測用のデータベースを用意してください", helpKey: "enable" };
  }
  if (report.records === "purged") {
    const days = num(noteOf("purged"), "days");
    return { title: "参加者ごとの記録は削除済みです", body: `結果を記録する前に保持期間${days === null ? "" : `(${days} 日)`}を過ぎて削除したため、表示できる数値はありません`, helpKey: "retention" };
  }
  const stale = noteOf("interim_stale");
  if (stale) return { title: "速報をまだ計算できていません", body: staleReason(str(stale, "reason")) };
  return { title: "表示できる数値がありません", body: "参加者が記録されると、ここに集計が表示されます" };
}

/** 品質の行(設計書 §7.3・§7.4)。問題が無ければ畳む */
function qualityOf(report: ResultReport, noteOf: (key: string) => Note | undefined, nameOf: (id: string | null) => string): ResultsView["quality"] {
  const q = report.qualityDetail;
  const rows: QualityRow[] = [];
  const notes = report.notes;

  // 割り振りの偏り(検定の値は出さない。重みと人数で示す)
  const delivered = report.variants.filter((v) => v.weight > 0);
  if (noteOf("quality_blocked_srm")) {
    rows.push({
      level: "bad",
      title: "割り振りの偏り",
      value: `あり(重み ${delivered.map((v) => v.weight).join(" / ")} に対して ${delivered.map((v) => `${fmtInt(v.n)} 人`).join(" / ")})`,
      note: "割り振りや配信の設定、対象外の訪問者の混入を確かめてください",
      helpKey: "srm",
    });
  } else {
    rows.push({ level: "ok", title: "割り振りの偏り", value: q.srmP === null ? "—" : "なし", helpKey: "srm" });
  }

  // 混在
  const mixed = noteOf("quality_blocked_mixed");
  rows.push(
    mixed
      ? { level: "bad", title: "混在", value: pct(num(mixed, "rate") ?? q.mixedRate), note: "1% を超えています。配信の設定かサイトの側の仕組みを確かめてください", helpKey: "mixed" }
      : { level: "ok", title: "混在", value: pct(q.mixedRate), helpKey: "mixed" },
  );

  // 適用の失敗(パターンごと)。回復した人は別に出す(警告には数えない)
  const failing = report.variants.filter((v) => v.applyFailed > 0);
  const recovered = report.variants.filter((v) => v.applyRecovered > 0);
  const warned = notes.filter((n) => n.key === "apply_failures").map((n) => (typeof n.params?.variantId === "string" ? n.params.variantId : null));
  const applyNotes = [
    ...warned.map((id) => `${nameOf(id)} の変更が一部の人に効いていません。効果が薄まって見えます`),
    ...(recovered.length > 0 ? [`後から効いた人: ${recovered.map((v) => `${v.name} ${fmtInt(v.applyRecovered)} 人`).join("・")}(警告には数えません)`] : []),
  ];
  rows.push({
    level: warned.length > 0 ? "warn" : "ok",
    title: "適用に失敗した人",
    value: failing.length === 0 ? "なし" : failing.map((v) => `${v.name} ${fmtInt(v.applyFailed)} 人(${pct(v.n === 0 ? 0 : v.applyFailed / v.n)})`).join("・"),
    ...(applyNotes.length > 0 ? { note: applyNotes.join("。") } : {}),
    helpKey: "apply-failures",
  });

  // 収集できなかった送信(割合は目安。参加と CV を合わせて数える限界は説明の項目にある)
  const failures = noteOf("collection_failures");
  rows.push({
    level: failures ? "warn" : "ok",
    title: "収集できなかった送信",
    value: q.failedSends === 0 ? "なし" : `${fmtInt(q.failedSends)} 件(割合の目安 ${pct(q.failureRatio)})`,
    ...(failures ? { note: "割合が 1% 以上です。参加と CV の送信を合わせた目安で、パターンごとには分けていません" } : {}),
    helpKey: "collection-failures",
  });

  // 収集の停止(上限は応答の値。CV の件数で 5% 以下に決まる)
  const stopBlocked = noteOf("quality_blocked_stops");
  const stopWarn = noteOf("collection_stops");
  const stopNote = stopBlocked ?? stopWarn;
  const ratio = num(stopNote, "ratio") ?? q.stopRatio;
  const limit = num(stopNote, "limit") ?? q.stopLimit;
  const hours = num(stopWarn, "hours") ?? q.stopPeriods.reduce((s, p) => s + Math.max(0, p.to - p.from), 0) / 3_600_000;
  rows.push({
    level: stopBlocked ? "bad" : stopWarn ? "warn" : "ok",
    title: "収集の停止",
    value: ratio === 0 && hours === 0 ? "なし" : `約 ${hoursText(hours)}(期間の ${pct(ratio)}。上限 ${pct(limit)})`,
    ...(stopBlocked ? { note: "止めていた時間が上限を超えたため、判定しません" } : stopWarn ? { note: "上限以下なので判定していますが、止まっていた間の CV は記録されていません" } : {}),
    helpKey: "collection-stops",
  });

  // テスト中の変更(判定は止めない)
  const changes = report.deliveryChanges.length;
  if (changes > 0 || noteOf("test_changes")) {
    const count = changes > 0 ? changes : (num(noteOf("test_changes"), "count") ?? 0);
    rows.push({ level: "warn", title: "テスト中の変更", value: `${count} 件`, note: "開始後に配信中の中身を変えて公開しています。判定は変更の前と後を合わせた値です", helpKey: "test-changes" });
  }

  const level = rows.some((r) => r.level === "bad") ? "bad" : rows.some((r) => r.level === "warn") ? "warn" : "ok";
  const folded = report.quality === "ok" && level === "ok";
  const headline = level === "bad" ? "データ品質: 判定を止める問題があります" : level === "warn" ? "データ品質: 注意があります" : "データ品質: 問題なし";
  return { folded, level, headline, rows };
}

/** 時間(1 時間未満は分) */
function hoursText(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分`;
  return `${Number(h.toFixed(h < 10 ? 1 : 0))} 時間`;
}

/** 差の図の軸(区間の端と 0・最小改善幅が入る範囲。目盛りは 0.5 ポイントか 1 ポイントか…の刻み) */
function axisFor(values: number[], delta: number | null): ResultsView["diffAxis"] {
  const all = [...values, 0, ...(delta !== null ? [delta] : [])];
  let min = Math.min(...all);
  let max = Math.max(...all);
  const span = Math.max(max - min, 0.5);
  const pad = span * 0.1;
  min -= pad;
  max += pad;
  const raw = (max - min) / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(Number(t.toFixed(6)));
  return { min, max, ticks, delta };
}
