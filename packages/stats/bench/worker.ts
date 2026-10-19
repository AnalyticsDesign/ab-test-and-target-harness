// 判定の計算の CPU 時間を測る使い捨ての Worker(本番のコードには入らない)。
//
//   GET /?case=<名前>[&reps=<回数>]   名前の一覧は GET /(case なし)で返す。
//
// 1 回の呼び出しで、その形の入力について verdict と diffSummary を計算して結果を JSON で返す(返すことで計算が
// 捨てられないようにする)。CPU 時間は呼び出しごとに Workers Logs で読む。Workers は計算の間 Date.now() と
// performance.now() が進まないので、この中では時間を測らない。reps は 1 回の呼び出しで繰り返す回数(既定 1)。

import {
  CLOSED_FORM_MAX_TERMS, DEFAULT_PLAN, NUMERIC_BELOW, STATS_VERSION, diffNormal, diffSummary, verdict,
} from "../src/index";
import type { Arm, VerdictInput } from "../src/index";

type Cell = Arm;

/** verdict の入力を作る(基準は先頭。欠けも停止も無い)。 */
function verdictInput(arms: Cell[], plan: Partial<typeof DEFAULT_PLAN> = {}): VerdictInput {
  return {
    plan: { ...DEFAULT_PLAN, ...plan, primaryGoalId: "goal", baselineVariantId: "v0" },
    arms: arms.map((a, i) => ({ id: `v${i}`, weight: 1, n: a.n, y: a.y, mixed: 0, applyFailed: 0, hasChanges: i > 0 })),
    stopMs: 0,
    elapsedMs: 14 * 24 * 3_600_000,
    failedSends: 0,
    recordedRows: arms.reduce((t, a) => t + a.n + a.y, 0),
  };
}

type RefRow = { key: string; variant: number; mean: number; ci95: [number, number] };

/** 端末別・ほかの目標の行: 基準との差を diffNormal だけで出す(判定しない参考の値)。先頭が基準。 */
function referenceRows(cells: Array<Map<string, Cell>>): RefRow[] {
  const out: RefRow[] = [];
  const base = cells[0]!;
  cells.forEach((arm, v) => {
    if (v === 0) return;
    for (const [key, cell] of arm) {
      const b = base.get(key);
      if (b !== undefined) out.push({ key, variant: v, ...diffNormal(b, cell) });
    }
  });
  return out;
}

const DEVICES = ["pc", "smartphone", "tablet"] as const;
const OTHER_GOALS = ["g1", "g2", "g3"] as const;

/**
 * 1 つのパターンの n・y を、端末別 3 × ほかの目標 3 の行に割る(端末の割合 0.5 / 0.4 / 0.1、
 * ほかの目標の CV の割合 0.6 / 0.3 / 0.1)。判定に使う目標の端末別の行も含む。
 * キーは "<目標>:<端末>"("all" = 端末を分けない)。
 */
function splitCells(arm: Cell): Map<string, Cell> {
  const share = [0.5, 0.4, 0.1];
  const goalRate = [0.6, 0.3, 0.1];
  const cells = new Map<string, Cell>();
  DEVICES.forEach((d, i) => {
    const n = Math.floor(arm.n * share[i]!);
    cells.set(`primary:${d}`, { n, y: Math.floor(arm.y * share[i]!) });
    OTHER_GOALS.forEach((g, j) => {
      cells.set(`${g}:${d}`, { n, y: Math.floor(arm.y * share[i]! * goalRate[j]!) });
    });
  });
  OTHER_GOALS.forEach((g, j) => cells.set(`${g}:all`, { n: arm.n, y: Math.floor(arm.y * goalRate[j]!) }));
  return cells;
}

/** 設計の最大の入力: 1 群 100 万人 / CV 5 万、3 群、端末別 3 × ほかの目標 3。 */
function maxCase(): unknown {
  const arms: Cell[] = [{ n: 1_000_000, y: 50_000 }, { n: 1_000_000, y: 50_500 }, { n: 1_000_000, y: 51_000 }];
  const v = verdict(verdictInput(arms, { delta: 0.1, rope: 0.2 }));
  const ref = referenceRows(arms.map(splitCells));
  return { verdict: v, referenceRows: ref.length, firstReference: ref[0] };
}

/** 2 群の比較(基準 対 1 つ)の verdict と diffSummary。 */
function pair(a: Cell, b: Cell): unknown {
  return { verdict: verdict(verdictInput([a, b])), summary: diffSummary(a, b, 0.1, 0.2) };
}

// 数値積分の最悪の形(compare.ts の NUMERIC_BELOW の説明を参照)
const NUMERIC_BASE: Cell = { n: 1490, y: 149 };

/** 閉形式の項数の境目: 項数 = 1 + min(CV, 非 CV)。over = 0 で上限ちょうど、1 で上限を 1 超える。 */
function closedEdge(over: number): unknown {
  const y = CLOSED_FORM_MAX_TERMS - 1 + over; // 項数 = 1 + y
  const n = 2_000_000;
  return pair({ n, y: y - 50 }, { n, y });
}

/** 記録を 1 件作る経路: 集計の結果の行 -> 入力 -> verdict -> 参考の行 -> JSON の組み立て。 */
function recordCase(): unknown {
  // 集計の結果(D1 から読んだ行の形): パターンごとの n・y と、端末別・ほかの目標の行
  const variants = [
    { id: "v0", name: "オリジナル", n: 1_000_000, y: 50_000 },
    { id: "v1", name: "パターン B", n: 1_000_000, y: 50_500 },
    { id: "v2", name: "パターン C", n: 1_000_000, y: 51_000 },
  ];
  const rows: Array<{ variant_id: string; goal_id: string; device: string; n: number; y: number }> = [];
  for (const v of variants) {
    for (const [key, cell] of splitCells({ n: v.n, y: v.y })) {
      const [goal, device] = key.split(":") as [string, string];
      rows.push({ variant_id: v.id, goal_id: goal, device, n: cell.n, y: cell.y });
    }
  }
  // 行から入力を作る
  const cellsByVariant = variants.map((v) => {
    const m = new Map<string, Cell>();
    for (const r of rows) if (r.variant_id === v.id) m.set(`${r.goal_id}:${r.device}`, { n: r.n, y: r.y });
    return m;
  });
  const out = verdict(verdictInput(variants.map((v) => ({ n: v.n, y: v.y })), { delta: 0.1, rope: 0.2 }));
  const reference = referenceRows(cellsByVariant);
  const snapshot = {
    statsVersion: STATS_VERSION,
    experiment: { name: "テスト", kind: "test" },
    variants: variants.map((v) => ({ id: v.id, name: v.name, n: v.n, y: v.y, comparison: out.comparisons.find((c) => c.variantId === v.id) ?? null })),
    quality: out.quality,
    notes: out.notes,
    reference,
  };
  const json = JSON.stringify(snapshot);
  return { bytes: json.length, states: out.comparisons.map((c) => c.state) };
}

const CASES: Record<string, () => unknown> = {
  // 設計の最大の入力
  max: maxCase,
  // 6 群(比較 5 回)で、どの群も閉形式の上限の近く
  arms6: () => verdict(verdictInput([0, 1, 2, 3, 4, 5].map((i) => ({ n: 2_000_000, y: 95_000 + i * 700 })))),
  // 閉形式の項数の境目(上限ちょうどと、超えて正規近似に切り替わる側)
  closed_edge: () => closedEdge(0),
  closed_over: () => closedEdge(1),
  // 数値積分に切り替わる境目(min(CV, 非 CV) が NUMERIC_BELOW 未満 / 以上)
  numeric_edge: () => pair({ n: 3_000, y: NUMERIC_BELOW - 1 }, { n: 3_000, y: NUMERIC_BELOW + 20 }),
  normal_edge: () => pair({ n: 3_000, y: NUMERIC_BELOW }, { n: 3_000, y: NUMERIC_BELOW + 20 }),
  // 数値積分の最悪の形(基準 {1490, 149} と、人数と CV が 64 倍 / n が約 400 倍の相手)
  numeric_64x: () => pair(NUMERIC_BASE, { n: NUMERIC_BASE.n * 64, y: NUMERIC_BASE.y * 64 }),
  numeric_400x: () => pair(NUMERIC_BASE, { n: NUMERIC_BASE.n * 400, y: NUMERIC_BASE.y * 400 }),
  // 結果の記録を 1 件作る経路
  record: recordCase,
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("case");
    const headers = { "content-type": "application/json; charset=utf-8" };
    if (name === null) return new Response(JSON.stringify({ cases: Object.keys(CASES), statsVersion: STATS_VERSION }), { headers });
    const run = CASES[name];
    if (run === undefined) return new Response(JSON.stringify({ error: "unknown case", cases: Object.keys(CASES) }), { status: 404, headers });
    const repsParam = Number(url.searchParams.get("reps") ?? "1");
    const reps = Number.isInteger(repsParam) && repsParam >= 1 && repsParam <= 100 ? repsParam : 1;
    let result: unknown;
    for (let i = 0; i < reps; i++) result = run();
    return new Response(JSON.stringify({ case: name, reps, result }), { headers });
  },
};
