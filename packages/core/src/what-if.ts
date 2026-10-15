import { inTraffic } from "./hash";
import { dslNeedsProfile, evaluateDsl, experimentUsesInvalidPattern, pickVariant, type PageContext, type ProfileSnapshot } from "./evaluate";
import { matchPage, pageOf } from "./page";
import type { CompiledConfig, Experiment } from "./schema";

/** D1 `experiments.status`(spec §13.8)。core は D1 を知らないので型だけ持つ */
export type ExperimentStatus = "draft" | "running" | "paused" | "archived";

/**
 * `status` は **Desired Status**(D1 `experiments.status` そのまま)、`published` は
 * **公開 config にその Experiment が載っているか**(決定 39 (7))。2 つは独立に返す
 */
export type WhatIfInput = { experiment: Experiment; status: ExperimentStatus; published: boolean };

/**
 * spec §13.10 / 決定 39 (2) (7): 「なぜこの URL で出ないか」の機械可読な理由。
 * ID(visitorId)に依存しない段(not_running → not_published → url_mismatch → needs_history → input_missing → targeting_false)を先に判定し、
 * visitorId が与えられたときだけ traffic_excluded まで進む。input_missing = 配信条件が使う入力(画面の幅・判定時刻・User-Agent など)が
 * 欠けていて判定できない(本番では対象外になる。決定 49、設計書 §11.1)
 */
export type WhatIfReason = "not_running" | "not_published" | "url_mismatch" | "needs_history" | "input_missing" | "targeting_false" | "traffic_excluded";

export type WhatIfResult = {
  experimentId: string;
  status: ExperimentStatus;
  published: boolean;
  eligible: boolean;
  reason?: WhatIfReason;
  weights: Array<{ variantId: string; weight: number }>;
  variantId?: string;
};

export type WhatIfOptions = {
  /** 省略可(決定 39 (2))。無ければ traffic 判定と Variant 決定は行わない */
  visitorId?: string;
  /** DO を見ずに入力で与える履歴(§13.10)。省略時、履歴条件を持つ Experiment は needs_history */
  history?: ProfileSnapshot;
  /** true なら draft / paused を running とみなして評価する(archived は対象外。§13.8) */
  draft?: boolean;
  /** サイトのタイムゾーン(曜日・時間帯の条件の判定に使う。評価する config の timezone) */
  timezone?: string;
  /** 評価する config の patterns。閲覧の条件が使えないパターン(このページで判定できないパターンも)を参照していれば input_missing(experimentUsesInvalidPattern。本番の edge と同じ判定) */
  patterns?: CompiledConfig["patterns"];
};

/** draft モードで「走っているとみなす」status(archived は復帰不可なので含めない) */
const DRAFTABLE: ReadonlyArray<ExperimentStatus> = ["draft", "running", "paused"];

/**
 * spec §13.10 の `evaluate`。`decide()` と同じ判定を同じ順序で行い、落ちた段を `reason` として返す。
 * **保存済み割当(persistAssignment)は参照しない** — DO に触れない what-if なので、
 * 保存済み割当を持つ訪問者は本番でこれと違う Variant を受け取り得る(応答の説明に書く)
 *
 * **`decide()` との意図的な差分**: `decide()` は `config.needsProfile && profile === null` のとき
 * **config 全体**を空 Decision にする(Profile 取得不能 = DO 障害時の fail-closed、evaluate.ts:85)。
 * `evaluateWhatIf` にはこの段が無い — what-if の `history` 省略は「DO 障害」ではなく「呼び手が履歴を
 * 与えていない」ことを意味するため、`needsProfile: true` の config に `history` を渡さずに呼ぶと、
 * 履歴条件を持たない Experiment はここでは `eligible: true` になり得る(`decide()` なら空になる場面)。
 * `history` を渡した場合(= profile が非 null)は `decide()` と一致する(回帰テスト参照)。
 */
export function evaluateWhatIf(items: WhatIfInput[], ctx: PageContext, opts: WhatIfOptions = {}): WhatIfResult[] {
  const profile = opts.history ?? null;
  const page = pageOf(ctx.url);
  return items.map(({ experiment, status, published }) => {
    const base = {
      experimentId: experiment.id,
      status,
      published,
      weights: experiment.variants.map((v) => ({ variantId: v.id, weight: v.weight })),
    };
    const no = (reason: WhatIfReason): WhatIfResult => ({ ...base, eligible: false, reason });

    const runningNow = status === "running" || (opts.draft === true && DRAFTABLE.includes(status));
    if (!runningNow) return no("not_running");
    // 決定 39 (7): draft: false は公開 config を評価する。status が running でも載っていなければ配っていない
    // (未 Publish の Site も全 Experiment が published: false になるのでここに落ちる)
    if (opts.draft !== true && !published) return no("not_published");
    if (matchPage(experiment.urlMatch, page) !== true) return no("url_mismatch");
    if (experiment.targeting) {
      if (profile === null && dslNeedsProfile(experiment.targeting)) return no("needs_history");
      // 使えないパターンを参照する閲覧の条件は、本番の edge では DO に渡さない = 対象外(experimentsForUrl と同じ関数)
      if (opts.patterns !== undefined && experimentUsesInvalidPattern(experiment, opts.patterns, page)) return no("input_missing");
      const r = evaluateDsl(experiment.targeting, ctx, profile, opts.timezone, page);
      if (r === null) return no("input_missing");
      if (!r) return no("targeting_false");
    }
    if (opts.visitorId === undefined) return { ...base, eligible: true }; // ID 非依存の段まで(決定 39 (2))
    if (!inTraffic(opts.visitorId, experiment.id, experiment.trafficPercentage)) return no("traffic_excluded");
    return { ...base, eligible: true, variantId: pickVariant(experiment, opts.visitorId) };
  });
}
