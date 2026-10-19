// 判定(verdict)の誤りの率のシミュレーション。実行: `pnpm -C packages/stats sim`(引数は --help)。
//
// 目的: 「差が無いのに採用候補(または悪化)と出る率」が、収集の欠け(散発的な失敗・収集の停止)があっても
// しきい値から想定される率(片方向 (100 - t') / 100)の範囲に収まるかを確かめる。判定の関数そのものは乱数を使わず、
// このシミュレーションが擬似乱数(seed 固定)で入力(参加者数と CV 数)を作る。実行時のコードではない。
//
// モデル(1 回の実行 = 1 本のテスト):
//  - 期間 14 日(336 時間)。各パターンに 1 時間ごとの新しい参加者が Poisson で来る(1 時間のコホート)。
//  - 参加者は確率 p で CV する。CV は参加の「同じ訪問(遅れ 0)」か、指数分布の遅れ(時間)で起きる。
//    パターンごとに遅れの型(fast / slow)を変えられる。評価時点(cutoff)までに起きた CV だけを数える。
//    型が違うときは「cutoff 時点で観測される CVR の真の値」が同じになるように p を合わせる(差が無い条件の真値 = 0)。
//  - 収集の欠け:
//      散発的な失敗 = 送信(参加・CV)ごとの失敗。一様(iid)か、1 つの時間帯に集中(burst)。
//        対象は参加(P)・CV(C)・両方(PC)。パターンごとに失敗の確率の倍率を変えられる(送信数の違い)。
//        失敗の量は「収集できなかった送信の割合」(failedSends / (failedSends + 保存した行))が目標の値になるよう決める。
//      収集の停止 = ある時刻から UTC 0 時までの時間帯。その間の参加は書かれず、その間に起きる CV も書かれない。
//  - 参加の記録が無い人の CV は数えない(集計は参加者から左結合するため。孤児の CV)。CV の失敗は「CV していない」になる。
//  - 計算量を抑えるため、人ごとではなくコホート(1 時間 × パターン)ごとに二項分布で件数を引く。CV の時刻が
//    停止・失敗の時間帯に入る確率は、遅れの分布から解析的に出す(時間帯は 1 時間より細かい境界を持てる)。
//    `--selfcheck` で、人ごとに引く素朴な実装と平均が合うことを確かめられる。
//  - 二項分布・Poisson は n * p が小さいとき厳密(逆変換)、大きいとき正規近似(平均・分散は厳密)。
//
// 誤りの数え方: 片方向ずつ(「採用候補」だけ・「悪化」だけ)、3 群以上は比較(基準 対 パターン)ごと。
//  - 差なし(cutoff 時点の真の CVR が等しい比較): state = adopt の率 / state = worse の率
//  - 効果あり: 逆向きの state の率(誤り)と、正しい向きの率(検出力)
// 関門: 想定の率 (100 - t') / 100 の 1.5 倍を超えたら「超過」。範囲 = 収集の失敗 1% 未満・停止 5% 以下。

import { DEFAULT_PLAN, effectiveThreshold, stopRatioLimit, strictestCvCount, verdict } from "../src/index";
import { lnGamma } from "../src/beta";
import type { VerdictInput, VerdictState } from "../src/index";

// ---------------------------------------------------------------------------
// 擬似乱数(sfc32、seed は splitmix32 で 4 つに展開)
// ---------------------------------------------------------------------------

type Rng = () => number;

/** 文字列 -> 32 bit の seed(FNV-1a)。 */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  const split = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = split(), b = split(), c = split(), d = split();
  const next: Rng = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
  for (let i = 0; i < 16; i++) next(); // 立ち上がりを捨てる
  return next;
}

function normalDraw(rng: Rng): number {
  const u1 = 1 - rng(); // (0, 1]
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 二項分布 Bin(n, p)。np が 25 未満なら逆変換(厳密)、それ以上は正規近似。 */
function binom(rng: Rng, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (p > 0.5) return n - binom(rng, n, 1 - p);
  const mean = n * p;
  if (mean < 25) {
    const q = 1 - p;
    const ratio = p / q;
    let f = Math.exp(n * Math.log1p(-p));
    let cdf = f;
    const u = rng();
    let x = 0;
    while (u > cdf && x < n) {
      x++;
      f *= ((n - x + 1) / x) * ratio;
      cdf += f;
      if (f < 1e-300) break;
    }
    return x;
  }
  const x = Math.round(mean + Math.sqrt(mean * (1 - p)) * normalDraw(rng));
  return x < 0 ? 0 : x > n ? n : x;
}

/** Poisson(lambda)。30 未満は Knuth 法、それ以上は正規近似。 */
function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const limit = Math.exp(-lambda);
    let k = 0, prod = rng();
    while (prod > limit) { k++; prod *= rng(); }
    return k;
  }
  const x = Math.round(lambda + Math.sqrt(lambda) * normalDraw(rng));
  return x < 0 ? 0 : x;
}

// ---------------------------------------------------------------------------
// 条件の型
// ---------------------------------------------------------------------------

/** CV までの時間の型。fast = 60% が同じ訪問・残りは平均 2 日。slow = 20% が同じ訪問・残りは平均 5 日。 */
type Ttcv = "fast" | "mid" | "slow";
const TTCV: Record<Ttcv, { s: number; tauHours: number }> = {
  fast: { s: 0.6, tauHours: 48 },
  mid: { s: 0.4, tauHours: 84 }, // 遅れの違いが小さい場合(fast と slow の中間)
  slow: { s: 0.2, tauHours: 120 },
};

type ArmSpec = {
  id: string;
  /** 配信の重み(= 到着の割合)。 */
  share: number;
  ttcv: Ttcv;
  /** 基準に対する cutoff 時点の CVR の相対差(0.1 = +10%)。基準は 0。 */
  lift: number;
  /** 失敗の確率の倍率(基準の失敗の確率に対して)。 */
  failMult: number;
};

type FailureSpec = {
  /** 目標とする「収集できなかった送信の割合」(0.0099 = 0.99%)。 */
  ratio: number;
  timing: "iid" | "burst";
  mode: "P" | "C" | "PC";
};

type StopSpec = {
  /** 開始から cutoff までに対する停止の割合(0.05 = 5%)。 */
  ratio: number;
  /** random = ランダムな日の終わり(UTC 0 時)まで / end = 最終日の終わり(cutoff)まで / start = 初日の終わりまで / two = 半分ずつ 2 回 */
  pos: "random" | "end" | "start" | "two";
};

type Scale = { name: string; perDayPerArm: number; cvr: number };

type Condition = {
  group: string;
  name: string;
  arms: ArmSpec[];
  failure: FailureSpec | null;
  stop: StopSpec | null;
  /** 関門の範囲か(失敗 1% 未満・停止 5% 以下)。範囲外は参考。 */
  inRegion: boolean;
  /** 差なしの A/A で、シミュレーション自体の検証に使うか(約 5% になるはず)。 */
  validation: boolean;
  /**
   * 関門の対象にしない既知の限界のラベル(条件の中身から自動で付く)。
   *   b  = 時間に集中する CV だけの失敗 + CV までの時間がパターンで違う
   *   b' = 時間に集中する参加と CV の両方の失敗 + CV までの時間がパターンで違う
   *   c  = パターンごとの CV の失敗の確率が違う(参加だけの倍率の違いは含めない。失敗の起き方のモデルの外)
   * 停止と組み合わせた条件は「<ラベル>+停止」。どれにも当たらない条件は関門で見る。
   */
  knownLimit: string | null;
  /**
   * 停止の割合を実行ごとに [lo, hi] × expectedLimit の一様乱数で決める(掃引)。結果は、実行ごとの
   * 実際の上限に対する停止の割合 ρ = 停止の割合 / 実際の上限 の帯(85〜90%、90〜95%、…)に分けて出す。
   * 実際の上限は停止の後の CV の件数で決まるので、事前に合わせるより、ρ で分けるほうが正確。
   * expectedLimit は停止なしの CV の見込みの件数から計算した上限(掃引の中心を決めるためだけに使う)。
   */
  sweep: { lo: number; hi: number; expectedLimit: number } | null;
  runs: number;
};

const DAYS = 14;
const HOURS = DAYS * 24;
const HOUR_MS = 3_600_000;
const MASTER_SEED = 20261019;
const EDGE_FAILURE = 0.0099; // 範囲の端(1% 未満)。一様な失敗の目標
const EDGE_BURST = 0.009; // 集中する失敗の目標(幅の見積もりが粗く、実測が少し高く出るため低めに置く。範囲かどうかは実測で判定する)

// ---------------------------------------------------------------------------
// 条件を組み立てる
// ---------------------------------------------------------------------------

function mkArms(n: number, opts: { ttcv?: Ttcv[]; lifts?: number[]; mults?: number[]; shares?: number[] } = {}): ArmSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i === 0 ? "base" : `v${i}`,
    share: opts.shares?.[i] ?? 1,
    ttcv: opts.ttcv?.[i] ?? "fast",
    lift: i === 0 ? 0 : (opts.lifts?.[i] ?? 0),
    failMult: opts.mults?.[i] ?? 1,
  }));
}

/** 基準と 2 群以上のパターンの TTCV の型の組み合わせ。 */
type TtcvKind = "same" | "AfBs" | "AsBf" | "AfBm";
function ttcvPair(kind: TtcvKind, n: number): Ttcv[] {
  if (kind === "same") return Array<Ttcv>(n).fill("fast");
  const a: Ttcv = kind === "AsBf" ? "slow" : "fast";
  const b: Ttcv = kind === "AfBs" ? "slow" : kind === "AfBm" ? "mid" : "fast";
  return Array.from({ length: n }, (_, i) => (i === 0 ? a : b));
}

const TTCV_LABEL = { same: "遅れ同じ", AfBs: "A速・B遅", AsBf: "A遅・B速", AfBm: "A速・B中" } as const;

/**
 * 停止なしの CV の見込みの件数(パターンごとに 到着数 × 評価時点で観測される CVR)から、新しい C(合計 × 重み)で上限を計算する。
 * 掃引と「上限の x%」の条件の中心を決めるためだけに使う(実際の上限は実行ごとの CV の件数で決まる)。
 */
function expectedStopLimit(arms: ArmSpec[], scale: Scale): number {
  const compiled = compile({ group: "", name: "", arms, failure: null, stop: null, inRegion: true, validation: false, knownLimit: null, sweep: null, runs: 0 }, scale);
  const ys = compiled.arms.map((a) => ({ id: a.spec.id, weight: a.spec.share, y: a.lambda * HOURS * a.theta }));
  return stopRatioLimit(strictestCvCount(ys, ys[0]!.id));
}

function buildConditions(runsDefault: number, scale: Scale): Condition[] {
  const out: Condition[] = [];
  const add = (c: Omit<Condition, "runs" | "validation" | "knownLimit" | "sweep"> & { runs?: number; validation?: boolean; sweep?: Condition["sweep"] }): void => {
    const unequalLag = c.arms.some((a) => a.ttcv !== c.arms[0]!.ttcv);
    const unequalCvFailure = c.failure !== null && c.failure.mode !== "P" && c.arms.some((a) => a.failMult !== 1);
    const burst = c.failure !== null && c.failure.timing === "burst" && unequalLag;
    const base = unequalCvFailure ? "c" : burst && c.failure!.mode === "C" ? "b" : burst && c.failure!.mode === "PC" ? "b'" : null;
    const knownLimit = base !== null && c.stop !== null ? `${base}+停止` : base;
    out.push({ validation: false, runs: runsDefault, knownLimit, sweep: null, ...c });
  };
  const VAL = 20_000;

  // --- 検証と、欠けの無い基本の条件 ---
  add({ group: "基本", name: "A/A 2群(欠け無し)", arms: mkArms(2), failure: null, stop: null, inRegion: true, validation: true, runs: VAL });
  add({ group: "基本", name: "A/A 3群(欠け無し)", arms: mkArms(3), failure: null, stop: null, inRegion: true, validation: true, runs: VAL });
  add({ group: "基本", name: "A/A 4群(欠け無し)", arms: mkArms(4), failure: null, stop: null, inRegion: true, validation: true, runs: 10_000 });
  add({ group: "基本", name: "A/A 2群 70/30", arms: mkArms(2, { shares: [0.7 * 2, 0.3 * 2] }), failure: null, stop: null, inRegion: true, validation: true, runs: 10_000 });
  for (const k of ["AfBs", "AsBf"] as const) {
    add({ group: "基本", name: `A/A 2群 欠け無し ${TTCV_LABEL[k]}`, arms: mkArms(2, { ttcv: ttcvPair(k, 2) }), failure: null, stop: null, inRegion: true, runs: 10_000 });
  }
  add({ group: "基本", name: "効果あり +10% 2群", arms: mkArms(2, { lifts: [0, 0.1] }), failure: null, stop: null, inRegion: true });
  add({ group: "基本", name: "効果あり −10% 2群", arms: mkArms(2, { lifts: [0, -0.1] }), failure: null, stop: null, inRegion: true });
  add({ group: "基本", name: "3群 (+10%, 差なし)", arms: mkArms(3, { lifts: [0, 0.1, 0] }), failure: null, stop: null, inRegion: true });

  // --- 散発的な失敗: 一様(範囲の端 = 0.99%)---
  for (const mode of ["P", "C", "PC"] as const) {
    for (const mult of [1, 2, 0.5]) {
      add({ group: "失敗(一様)", name: `一様 ${mode} 倍率${mult}`, arms: mkArms(2, { mults: [1, mult] }), failure: { ratio: EDGE_FAILURE, timing: "iid", mode }, stop: null, inRegion: true });
    }
    for (const k of ["AfBs", "AsBf"] as const) {
      add({ group: "失敗(一様)", name: `一様 ${mode} ${TTCV_LABEL[k]}`, arms: mkArms(2, { ttcv: ttcvPair(k, 2) }), failure: { ratio: EDGE_FAILURE, timing: "iid", mode }, stop: null, inRegion: true });
    }
  }
  // --- 散発的な失敗: 時間に集中 ---
  for (const mode of ["P", "C", "PC"] as const) {
    for (const k of ["same", "AfBs", "AsBf"] as const) {
      add({ group: "失敗(集中)", name: `集中 ${mode} ${TTCV_LABEL[k]}`, arms: mkArms(2, { ttcv: ttcvPair(k, 2) }), failure: { ratio: EDGE_BURST, timing: "burst", mode }, stop: null, inRegion: true });
    }
  }
  // --- 失敗の量を変える(倍率 2 の一様)。どの量まで想定の範囲かを見る ---
  for (const [mode, ratios] of [["C", [0.0001, 0.0003, 0.001, 0.003, 0.006]], ["PC", [0.001, 0.003, 0.006]]] as const) {
    for (const ratio of ratios) {
      add({ group: "失敗の量", name: `一様 ${mode} 倍率2 失敗${(ratio * 100).toFixed(2)}%`, arms: mkArms(2, { mults: [1, 2] }), failure: { ratio, timing: "iid", mode }, stop: null, inRegion: true });
    }
  }
  // --- 収集の停止 ---
  for (const ratio of [0.02, 0.05]) {
    for (const pos of ["random", "end", "start", "two"] as const) {
      for (const k of ["same", "AfBs", "AsBf"] as const) {
        add({ group: "停止", name: `停止${ratio * 100}% ${pos} ${TTCV_LABEL[k]}`, arms: mkArms(2, { ttcv: ttcvPair(k, 2) }), failure: null, stop: { ratio, pos }, inRegion: true });
      }
    }
  }
  // 停止の量を小さくした場合(CV までの時間がパターンで違うときに、どの量まで想定の範囲か)と、遅れの違いが小さい場合
  for (const ratio of [0.0025, 0.005, 0.01]) {
    for (const k of ["AfBs", "AsBf"] as const) {
      add({ group: "停止の量", name: `停止${ratio * 100}% random ${TTCV_LABEL[k]}`, arms: mkArms(2, { ttcv: ttcvPair(k, 2) }), failure: null, stop: { ratio, pos: "random" }, inRegion: true });
    }
  }
  for (const ratio of [0.02, 0.05]) {
    for (const pos of ["random", "end"] as const) {
      add({ group: "停止の量", name: `停止${ratio * 100}% ${pos} ${TTCV_LABEL.AfBm}`, arms: mkArms(2, { ttcv: ttcvPair("AfBm", 2) }), failure: null, stop: { ratio, pos }, inRegion: true });
    }
  }
  for (const k of ["same", "AfBs", "AsBf"] as const) {
    add({ group: "停止(範囲外)", name: `停止10% random ${TTCV_LABEL[k]}`, arms: mkArms(2, { ttcv: ttcvPair(k, 2) }), failure: null, stop: { ratio: 0.1, pos: "random" }, inRegion: false });
  }
  // --- 停止の割合の上限(CV の件数から決まる)の手前と、ほぼ上限ちょうど。上限が効いている最悪の場合の確認 ---
  {
    const expectedCv = (t: Ttcv): number => {
      const { s: imm, tauHours } = TTCV[t];
      let q = 0;
      for (let h = 0; h < HOURS; h++) q += cdfDelay(imm, tauHours, HOURS - (h + 0.5)) / HOURS;
      return scale.perDayPerArm * DAYS * scale.cvr * q;
    };
    // 2 群(重みが等しい)の、停止なしの CV の見込みから計算した上限。「上限の x%」の中心を決めるためだけに使う
    const limit = stopRatioLimit(expectedCv("fast"));
    for (const factor of [0.5, 0.95]) {
      const ratio = limit * factor;
      for (const pos of ["random", "two", "end"] as const) {
        for (const k of ["AfBs", "AsBf", "AfBm"] as const) {
          add({ group: "停止(上限の手前)", name: `停止=上限の${Math.round(factor * 100)}% ${pos} ${TTCV_LABEL[k]}`, arms: mkArms(2, { ttcv: ttcvPair(k, 2) }), failure: null, stop: { ratio, pos }, inRegion: true });
        }
      }
    }
    // 実行ごとの実際の上限の付近を掃引する(停止の割合 = 見込みの上限の 85〜115% の一様乱数)。
    // 結果は ρ = 停止 / 実際の上限 の帯ごとに出す。ρ <= 100% の帯が「判定が出た実行」(関門で見る)、
    // ρ > 100% の帯は判定不可(判定が出た割合 0%)。2・3・4 群 × 重み(等しい / 等しくない)× CV までの時間(同じ / 違う)× 位置。
    const weightSets: Array<{ label: string; shares: number[] }> = [
      { label: "重み等しい", shares: [1, 1] }, { label: "重み70/30", shares: [1.4, 0.6] },
      { label: "重み等しい", shares: [1, 1, 1] }, { label: "重み50/25/25", shares: [2, 1, 1] },
      { label: "重み等しい", shares: [1, 1, 1, 1] }, { label: "重み40/20/20/20", shares: [1.6, 0.8, 0.8, 0.8] },
    ];
    for (const ws of weightSets) {
      const n = ws.shares.length;
      for (const k of ["same", "AfBs"] as const) {
        for (const pos of ["random", "start"] as const) {
          const arms = mkArms(n, { ttcv: ttcvPair(k, n), shares: ws.shares });
          const exp = expectedStopLimit(arms, scale);
          add({ group: "停止(上限付近の掃引)", name: `${n}群 ${ws.label} 停止=実際の上限付近 ${pos} ${TTCV_LABEL[k]}`, arms, failure: null, stop: { ratio: exp * 1.0, pos }, inRegion: true, runs: 15_000, sweep: { lo: 0.85, hi: 1.15, expectedLimit: exp } });
        }
      }
    }
    // 停止(上限の 95%)+ 一様な CV の失敗(両パターン同じ確率)+ CV までの時間の違い。関門で見る組み合わせ
    add({ group: "組み合わせ", name: "停止=上限の95% random + 一様C A速・B遅", arms: mkArms(2, { ttcv: ttcvPair("AfBs", 2) }), failure: { ratio: EDGE_FAILURE, timing: "iid", mode: "C" }, stop: { ratio: limit * 0.95, pos: "random" }, inRegion: true });
    add({ group: "停止(上限の手前)", name: "4群 停止=上限の95% random A速・B遅", arms: mkArms(4, { ttcv: ttcvPair("AfBs", 4) }), failure: null, stop: { ratio: limit * 0.95, pos: "random" }, inRegion: true });
    add({ group: "停止(上限の手前)", name: "3群 停止=上限の95% random A速・B遅", arms: mkArms(3, { ttcv: ttcvPair("AfBs", 3) }), failure: null, stop: { ratio: limit * 0.95, pos: "random" }, inRegion: true });
  }
  // --- 組み合わせ ---
  add({ group: "組み合わせ", name: "停止5% end + 一様PC 倍率2 A速・B遅", arms: mkArms(2, { ttcv: ttcvPair("AfBs", 2), mults: [1, 2] }), failure: { ratio: EDGE_FAILURE, timing: "iid", mode: "PC" }, stop: { ratio: 0.05, pos: "end" }, inRegion: true });
  add({ group: "組み合わせ", name: "停止5% random + 一様C A速・B遅", arms: mkArms(2, { ttcv: ttcvPair("AfBs", 2) }), failure: { ratio: EDGE_FAILURE, timing: "iid", mode: "C" }, stop: { ratio: 0.05, pos: "random" }, inRegion: true });
  add({ group: "組み合わせ", name: "停止5% end + 集中C A遅・B速", arms: mkArms(2, { ttcv: ttcvPair("AsBf", 2) }), failure: { ratio: EDGE_BURST, timing: "burst", mode: "C" }, stop: { ratio: 0.05, pos: "end" }, inRegion: true });
  // --- 3 群(比較ごとに数える。m = 2) ---
  add({ group: "3群", name: "3群 一様PC 倍率(1,2,2)", arms: mkArms(3, { mults: [1, 2, 2] }), failure: { ratio: EDGE_FAILURE, timing: "iid", mode: "PC" }, stop: null, inRegion: true });
  add({ group: "3群", name: "3群 一様C 倍率(1,2,2)", arms: mkArms(3, { mults: [1, 2, 2] }), failure: { ratio: EDGE_FAILURE, timing: "iid", mode: "C" }, stop: null, inRegion: true });
  add({ group: "3群", name: "3群 停止5% end A速・B遅", arms: mkArms(3, { ttcv: ttcvPair("AfBs", 3) }), failure: null, stop: { ratio: 0.05, pos: "end" }, inRegion: true });
  add({ group: "3群", name: "3群 停止5% random A速・B遅", arms: mkArms(3, { ttcv: ttcvPair("AfBs", 3) }), failure: null, stop: { ratio: 0.05, pos: "random" }, inRegion: true });
  return out;
}

const SCALES: Scale[] = [
  { name: "tiny", perDayPerArm: 70, cvr: 0.012 }, // 最低件数の規則が半分ほど働く(1 群 980 人・CV 約 9 件)
  { name: "M", perDayPerArm: 300, cvr: 0.05 }, // 1 群 4,200 人
  { name: "L", perDayPerArm: 2_000, cvr: 0.05 }, // 1 群 28,000 人
  { name: "XL", perDayPerArm: 20_000, cvr: 0.03 }, // 1 群 280,000 人
  { name: "XXL", perDayPerArm: 70_000, cvr: 0.05 }, // 1 群 約 98 万人・CV 約 5 万(設計の最大)
];

// ---------------------------------------------------------------------------
// 1 本のテストを作る
// ---------------------------------------------------------------------------

type Window = [number, number]; // [開始, 終了) 時間

type ArmModel = {
  spec: ArmSpec;
  /** 1 時間あたりの到着数の期待値。 */
  lambda: number;
  /** 参加者が CV する確率(遅れの前。cutoff 時点の観測の真値 θ から逆算)。 */
  p: number;
  s: number;
  tau: number;
  /** cutoff 時点で観測される CVR の真の値。 */
  theta: number;
  /** 一様な失敗の確率(参加・CV)。 */
  fP: number;
  fC: number;
  /** exp(m / tau)(コホートの中央 m = h + 0.5)。 */
  expM: Float64Array;
};

type Compiled = {
  cond: Condition;
  arms: ArmModel[];
  burstP: boolean;
  burstC: boolean;
  burstWidth: number;
  stopTotalHours: number;
};

/** CV の遅れの累積分布 F(x)。x <= 0 は 0(同じ訪問の分は x > 0 で足す。コホート側の扱いは lowerF 参照)。 */
function cdfDelay(s: number, tau: number, x: number): number {
  return x <= 0 ? 0 : s + (1 - s) * (1 - Math.exp(-x / tau));
}

function compile(cond: Condition, scale: Scale): Compiled {
  const n = cond.arms.length;
  const totalShare = cond.arms.reduce((t, a) => t + a.share, 0);
  const perHourTotal = (scale.perDayPerArm * n) / 24; // 全パターンの合計の 1 時間あたり
  // 各パターンの q = 平均 F(cutoff - m)
  const q = cond.arms.map((a) => {
    const { s, tauHours } = TTCV[a.ttcv];
    let sum = 0;
    for (let h = 0; h < HOURS; h++) sum += cdfDelay(s, tauHours, HOURS - (h + 0.5));
    return sum / HOURS;
  });
  const theta0 = scale.cvr * q[0]!;
  const arms: ArmModel[] = cond.arms.map((a, i) => {
    const { s, tauHours } = TTCV[a.ttcv];
    const theta = theta0 * (1 + a.lift);
    const expM = new Float64Array(HOURS);
    for (let h = 0; h < HOURS; h++) expM[h] = Math.exp((h + 0.5) / tauHours);
    return {
      spec: a, lambda: (perHourTotal * a.share) / totalShare, p: theta / q[i]!, s, tau: tauHours, theta, fP: 0, fC: 0, expM,
    };
  });

  // 失敗の量: 目標の割合 ratio になるように倍率を掛けた共通の f を解く(停止による減少は無視。実現値は出力で確かめる)
  let burstWidth = 0;
  let burstP = false, burstC = false;
  if (cond.failure !== null) {
    const { ratio, timing, mode } = cond.failure;
    const useP = mode === "P" || mode === "PC";
    const useC = mode === "C" || mode === "PC";
    let sends = 0, weighted = 0;
    for (const a of arms) {
      const nA = a.lambda * HOURS;
      const qA = nA * a.theta;
      sends += nA + qA;
      weighted += (useP ? nA : 0) * a.spec.failMult + (useC ? qA : 0) * a.spec.failMult;
    }
    const f = Math.min(1, (ratio * sends) / weighted);
    if (timing === "iid") {
      for (const a of arms) {
        a.fP = useP ? Math.min(1, f * a.spec.failMult) : 0;
        a.fC = useC ? Math.min(1, f * a.spec.failMult) : 0;
      }
    } else {
      burstWidth = Math.min(HOURS, f * HOURS);
      burstP = useP;
      burstC = useC;
    }
  }
  const stopTotalHours = cond.stop === null ? 0 : cond.stop.ratio * HOURS;
  return { cond, arms, burstP, burstC, burstWidth, stopTotalHours };
}

/** 停止の時間帯。各時間帯は UTC の日の終わり(24 の倍数)で終わる。 */
function drawStopWindows(rng: Rng, stop: StopSpec, total: number): Window[] {
  if (total <= 0) return [];
  const endOfDay = (d: number): Window => [d * 24 - total, d * 24];
  switch (stop.pos) {
    case "end": return [endOfDay(DAYS)];
    case "start": return [endOfDay(Math.ceil(total / 24))];
    case "random": {
      const minDay = Math.ceil(total / 24);
      return [endOfDay(minDay + Math.floor(rng() * (DAYS - minDay + 1)))];
    }
    case "two": {
      const half = total / 2;
      const minDay = Math.ceil(half / 24);
      const span = DAYS - minDay + 1;
      const d1 = minDay + Math.floor(rng() * span);
      let d2 = minDay + Math.floor(rng() * (span - 1));
      if (d2 >= d1) d2++;
      return [d1, d2].sort((x, y) => x - y).map((d): Window => [d * 24 - half, d * 24]);
    }
  }
}

type Kind = 0 | 1 | 2; // 0 = 通常 / 1 = 失敗の集中 / 2 = 停止
type Segments = { edges: number[]; kinds: Kind[] };

/** 時間軸 [0, HOURS) を、停止 > 失敗の集中 > 通常 の優先で区間に分ける。 */
function buildSegments(stops: Window[], bursts: Window[]): Segments {
  const pts = new Set<number>([0, HOURS]);
  for (const [a, b] of [...stops, ...bursts]) { pts.add(Math.max(0, a)); pts.add(Math.min(HOURS, b)); }
  const edges = [...pts].sort((x, y) => x - y);
  const kinds: Kind[] = [];
  const within = (w: Window[], x: number): boolean => w.some(([a, b]) => x >= a && x < b);
  for (let j = 0; j < edges.length - 1; j++) {
    const mid = (edges[j]! + edges[j + 1]!) / 2;
    kinds.push(within(stops, mid) ? 2 : within(bursts, mid) ? 1 : 0);
  }
  return { edges, kinds };
}

/** 時間 [h, h+1) のうち区間の種類 kind が占める割合。 */
function coverage(seg: Segments, h: number, kind: Kind): number {
  let c = 0;
  for (let j = 0; j < seg.kinds.length; j++) {
    if (seg.kinds[j] !== kind) continue;
    const lo = Math.max(seg.edges[j]!, h), hi = Math.min(seg.edges[j + 1]!, h + 1);
    if (hi > lo) c += hi - lo;
  }
  return c;
}

type RunOut = {
  n: number[]; y: number[]; failedSends: number; recordedRows: number; stopMs: number;
};

function runOnce(rng: Rng, c: Compiled, stopHours: number = c.stopTotalHours): RunOut {
  const stops = c.cond.stop === null ? [] : drawStopWindows(rng, c.cond.stop, stopHours);
  const bursts: Window[] = [];
  if (c.burstWidth > 0) {
    const start = rng() * (HOURS - c.burstWidth);
    bursts.push([start, start + c.burstWidth]);
  }
  const seg = buildSegments(stops, bursts);
  const K = seg.kinds.length;
  const covStop = new Float64Array(HOURS), covBurst = new Float64Array(HOURS);
  if (stops.length > 0 || bursts.length > 0) {
    for (let h = 0; h < HOURS; h++) { covStop[h] = coverage(seg, h, 2); covBurst[h] = coverage(seg, h, 1); }
  }

  const nOut: number[] = [], yOut: number[] = [];
  let failedSends = 0, recordedRows = 0;
  for (const arm of c.arms) {
    // 区間の境界ごとの exp(-edge / tau)
    const eb = seg.edges.map((e) => Math.exp(-e / arm.tau));
    const L = new Float64Array(K + 1);
    let nTotal = 0, yTotal = 0;
    for (let h = 0; h < HOURS; h++) {
      const m = h + 0.5;
      const big = poisson(rng, arm.lambda);
      if (big === 0) continue;
      const cs = covStop[h]!;
      const stopLost = binom(rng, big, cs);
      const remain = big - stopLost;
      const rb = c.burstP && cs < 1 ? covBurst[h]! / (1 - cs) : 0;
      const pFail = rb + (1 - rb) * arm.fP;
      const failLost = binom(rng, remain, pFail);
      const kept = remain - failLost;
      nTotal += kept;
      failedSends += failLost;
      recordedRows += kept;

      // CV の時刻が各区間に入る確率
      for (let j = 0; j <= K; j++) {
        const x = seg.edges[j]! - m;
        L[j] = x <= 0 ? 0 : arm.s + (1 - arm.s) * (1 - eb[j]! * arm.expM[h]!);
      }
      let pRec = 0, pFailC = 0, pStop = 0;
      for (let j = 0; j < K; j++) {
        const pi = L[j + 1]! - L[j]!;
        if (pi <= 0) continue;
        const kind = seg.kinds[j]!;
        if (kind === 2) pStop += pi;
        else if (kind === 1 && c.burstC) pFailC += pi;
        else { pRec += pi * (1 - arm.fC); pFailC += pi * arm.fC; }
      }
      const qk = binom(rng, kept, arm.p);
      const rec = binom(rng, qk, pRec);
      const afterRec = qk - rec;
      const denomA = 1 - pRec;
      const stopC = denomA > 0 ? binom(rng, afterRec, Math.min(1, pStop / denomA)) : 0;
      const denomB = denomA - pStop;
      const failC = denomB > 0 ? binom(rng, afterRec - stopC, Math.min(1, pFailC / denomB)) : 0;
      yTotal += rec;
      failedSends += failC;
      recordedRows += rec;
      // 参加の記録が無い人の CV(孤児)は y に数えないが、送信としては失敗の割合の分母・分子に入る(期待値で足す)
      const orphan = binom(rng, big - kept, arm.p);
      failedSends += orphan * pFailC;
      recordedRows += orphan * pRec;
    }
    nOut.push(nTotal);
    yOut.push(yTotal);
  }
  // 実際の停止の時間は整数のミリ秒で測るので、ここでも丸めて「ちょうど 5%」が浮動小数点の誤差で超えないようにする
  const stopMs = Math.round(stops.reduce((t, [a, b]) => t + (b - a), 0) * HOUR_MS);
  return { n: nOut, y: yOut, failedSends, recordedRows, stopMs };
}

// ---------------------------------------------------------------------------
// 人ごとに引く素朴な実装(--selfcheck 用。コホート版の平均と合うかを見る)
// ---------------------------------------------------------------------------

function runOnceNaive(rng: Rng, c: Compiled): RunOut {
  const stops = c.cond.stop === null ? [] : drawStopWindows(rng, c.cond.stop, c.stopTotalHours);
  const bursts: Window[] = [];
  if (c.burstWidth > 0) {
    const start = rng() * (HOURS - c.burstWidth);
    bursts.push([start, start + c.burstWidth]);
  }
  const inside = (w: Window[], t: number): boolean => w.some(([a, b]) => t >= a && t < b);
  const nOut: number[] = [], yOut: number[] = [];
  let failedSends = 0, recordedRows = 0;
  for (const arm of c.arms) {
    let nTotal = 0, yTotal = 0;
    for (let h = 0; h < HOURS; h++) {
      const count = poisson(rng, arm.lambda);
      for (let i = 0; i < count; i++) {
        const t = h + rng();
        let kept = true;
        if (inside(stops, t)) kept = false;
        else if ((c.burstP && inside(bursts, t)) || rng() < arm.fP) { kept = false; failedSends++; }
        if (kept) { nTotal++; recordedRows++; }
        if (rng() >= arm.p) continue;
        const delay = rng() < arm.s ? 0 : -Math.log(1 - rng()) * arm.tau;
        const tc = t + delay;
        if (tc >= HOURS) continue;
        if (inside(stops, tc)) continue;
        if ((c.burstC && inside(bursts, tc)) || rng() < arm.fC) { failedSends++; continue; }
        recordedRows++;
        if (kept) yTotal++;
      }
    }
    nOut.push(nTotal);
    yOut.push(yTotal);
  }
  return { n: nOut, y: yOut, failedSends, recordedRows, stopMs: Math.round(stops.reduce((t, [a, b]) => t + (b - a), 0) * HOUR_MS) };
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

type Tally = { events: number; total: number };
const tally = (): Tally => ({ events: 0, total: 0 });
const rate = (t: Tally): number | null => (t.total === 0 ? null : t.events / t.total);

type Result = {
  cond: Condition;
  scale: Scale;
  seed: number;
  m: number;
  nominal: number;
  gate: number;
  /** 差なしの比較: 採用候補 / 悪化 */
  nullAdopt: Tally; nullWorse: Tally;
  /** 効果あり(真の差 > 0 / < 0)の比較: 逆向き(誤り)/ 正しい向き(検出力) */
  wrong: Tally; power: Tally;
  blocked: Tally; insufficient: Tally;
  /** 差なしの比較が 1 つでもある実行で、差なし(か逆向き)なのに採用候補が 1 つでも出た実行の割合 */
  anyFalseAdopt: Tally;
  meanFailureRatio: number; meanStopRatio: number;
  /** 基準とパターン 1 の CVR の平均(実行ごとの y / n の平均)。偏りの大きさ(パターン 1 / 基準 - 1)の説明用。 */
  meanCvr: [number, number];
  /** 停止の割合が上限を超えて判定不可になった実行の割合と、上限の平均。 */
  stopBlocked: Tally; meanStopLimit: number;
};

/** 掃引の帯(ρ = 停止の割合 / 実際の上限)。 */
const RHO_BINS: Array<{ lo: number; hi: number; label: string }> = [
  { lo: 0, hi: 0.9, label: "ρ<90%" }, { lo: 0.9, hi: 0.95, label: "ρ90-95%" }, { lo: 0.95, hi: 1.0, label: "ρ95-100%" },
  { lo: 1.0, hi: 1.05, label: "ρ100-105%" }, { lo: 1.05, hi: Infinity, label: "ρ>105%" },
];

function newResult(cond: Condition, scale: Scale, seed: number, m: number, nominal: number): Result {
  return {
    cond, scale, seed, m, nominal, gate: nominal * 1.5,
    nullAdopt: tally(), nullWorse: tally(), wrong: tally(), power: tally(), blocked: tally(), insufficient: tally(),
    anyFalseAdopt: tally(), meanFailureRatio: 0, meanStopRatio: 0, meanCvr: [0, 0], stopBlocked: tally(), meanStopLimit: 0,
  };
}

/** 掃引でない条件は 1 件、掃引の条件は ρ の帯ごとに 1 件の結果を返す。 */
function simulateCondition(cond: Condition, scale: Scale, runs: number, naive = false): Result[] {
  const compiled = compile(cond, scale);
  const seed = hashSeed(`${MASTER_SEED}:${scale.name}:${cond.name}`);
  const rng = makeRng(seed);
  const m = cond.arms.length - 1;
  const nominal = (100 - (m === 1 ? DEFAULT_PLAN.threshold : effectiveThreshold(DEFAULT_PLAN.threshold, m))) / 100;
  const results: Result[] = cond.sweep === null
    ? [newResult(cond, scale, seed, m, nominal)]
    : RHO_BINS.map((b) => newResult({ ...cond, name: `${cond.name} ${b.label}`, runs: 0 }, scale, seed, m, nominal));
  const counts = results.map(() => 0);
  // 真の符号(cutoff 時点の観測の真値で比べる)
  const base = compiled.arms[0]!;
  const truth = compiled.arms.map((a) => {
    const d = a.theta - base.theta;
    return Math.abs(d) <= 1e-12 * base.theta ? 0 : d > 0 ? 1 : -1;
  });
  const plan = { ...DEFAULT_PLAN, primaryGoalId: "goal", baselineVariantId: "base" };
  for (let r = 0; r < runs; r++) {
    const stopHours = cond.sweep === null ? compiled.stopTotalHours
      : cond.sweep.expectedLimit * (cond.sweep.lo + (cond.sweep.hi - cond.sweep.lo) * rng()) * HOURS;
    const out = naive ? runOnceNaive(rng, compiled) : runOnce(rng, compiled, stopHours);
    const input: VerdictInput = {
      plan,
      arms: compiled.arms.map((a, i) => ({
        id: a.spec.id, weight: a.spec.share, n: out.n[i]!, y: out.y[i]!, mixed: 0, applyFailed: 0, hasChanges: i > 0,
      })),
      stopMs: out.stopMs,
      elapsedMs: HOURS * HOUR_MS,
      failedSends: out.failedSends,
      recordedRows: out.recordedRows,
    };
    const v = verdict(input);
    const stopBlocked = v.quality.reasons.includes("quality_blocked_stops");
    if (stopBlocked !== v.quality.stopRatio > v.quality.stopLimit) {
      throw new Error(`停止の判定不可が上限と合いません(停止 ${v.quality.stopRatio}、上限 ${v.quality.stopLimit}): ${cond.name}`);
    }
    let bin = 0;
    if (cond.sweep !== null) {
      const rho = v.quality.stopLimit > 0 ? v.quality.stopRatio / v.quality.stopLimit : 0;
      bin = RHO_BINS.findIndex((b) => rho >= b.lo && rho < b.hi);
    }
    const res = results[bin]!;
    counts[bin]!++;
    res.meanStopLimit += v.quality.stopLimit;
    if (stopBlocked) res.stopBlocked.events++;
    res.stopBlocked.total++;
    res.meanFailureRatio += v.quality.failureRatio;
    for (const i of [0, 1] as const) if (out.n[i]! > 0) res.meanCvr[i] += out.y[i]! / out.n[i]!;
    res.meanStopRatio += v.quality.stopRatio;
    let falseAdoptInRun = false;
    for (const cmp of v.comparisons) {
      const i = compiled.arms.findIndex((a) => a.spec.id === cmp.variantId);
      const state: VerdictState = cmp.state;
      const tr = truth[i]!;
      res.blocked.total++; res.insufficient.total++;
      if (state === "blocked_quality") res.blocked.events++;
      if (state === "insufficient") res.insufficient.events++;
      // 停止が上限を超えて判定不可になった実行は、判定が出ない(誤りにならない)ので関門の集計から外す
      // (外さないと判定不可の実行が分母に入って率が薄まる)。判定が出た実行だけで、出た判定の誤りの率を見る。
      if (stopBlocked) continue;
      if (tr === 0) {
        res.nullAdopt.total++; res.nullWorse.total++;
        if (state === "adopt") { res.nullAdopt.events++; falseAdoptInRun = true; }
        if (state === "worse") res.nullWorse.events++;
      } else {
        res.wrong.total++; res.power.total++;
        if (state === (tr > 0 ? "worse" : "adopt")) res.wrong.events++;
        if (state === (tr > 0 ? "adopt" : "worse")) res.power.events++;
        if (tr < 0 && state === "adopt") falseAdoptInRun = true;
      }
    }
    res.anyFalseAdopt.total++;
    if (falseAdoptInRun) res.anyFalseAdopt.events++;
  }
  results.forEach((res, i) => {
    const c = Math.max(1, counts[i]!);
    res.meanFailureRatio /= c; res.meanStopRatio /= c; res.meanStopLimit /= c;
    res.meanCvr = [res.meanCvr[0] / c, res.meanCvr[1] / c];
    res.cond = { ...res.cond, runs: counts[i]! };
  });
  return cond.sweep === null ? results : results.filter((x) => x.cond.runs > 0);
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

const pct = (v: number | null, digits = 2): string => (v === null ? "-" : `${(v * 100).toFixed(digits)}%`);

/** 二項分布の厳密な(Clopper-Pearson)95% 区間の下限。events 件 / total 件。少数の行でも過大にならない。 */
function exactLower(t: Tally): number {
  if (t.total === 0 || t.events === 0) return 0;
  const { events: k, total: n } = t;
  // P(X >= k | n, p) = 0.025 となる p を二分法で探す
  const lnFact = (x: number): number => lnGamma(x + 1);
  const tail = (p: number): number => {
    let sum = 0;
    const lp = Math.log(p), lq = Math.log1p(-p);
    for (let i = k; i <= n; i++) {
      const term = Math.exp(lnFact(n) - lnFact(i) - lnFact(n - i) + i * lp + (n - i) * lq);
      sum += term;
      if (term < 1e-18 && i > n * p) break;
    }
    return sum;
  };
  let lo = 0, hi = k / n;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (tail(mid) < 0.025) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

type Gate = { status: string; worst: number | null; which: string; n: number };

/** 比較の数がこれ未満の行には「少数」と件数を付ける(率は出す。関門の失敗にするのは厳密な下限が関門を超えたときだけ)。 */
const FEW_SAMPLES = 200;

/**
 * 差なしの採用候補・悪化、効果ありの逆向きのうち最大の率を関門と比べる。
 * 範囲 = 収集の失敗の実測が 1% 未満、停止が 5% 以下。判定が出た実行(停止が自分の上限以下の実行)すべてを集計する。
 * 比較が 200 以上の行は、点推定が関門を超えたら「超過」(厳密な下限も超えたら「超過(確実)」)。200 未満の行は
 * 厳密な下限が関門を超えたときだけ「超過(確実)」にする(少数の点推定は揺れるため)。
 */
function gateOf(r: Result): Gate {
  const items: Array<[string, Tally]> = [["採用候補", r.nullAdopt], ["悪化", r.nullWorse], ["逆向き", r.wrong]];
  let worst: [string, Tally] | null = null;
  for (const [name, t] of items) {
    if (t.total === 0) continue;
    if (worst === null || t.events / t.total > worst[1].events / worst[1].total) worst = [name, t];
  }
  const region = r.cond.inRegion && r.meanFailureRatio < 0.01 && r.meanStopRatio <= 0.05 + 1e-9;
  if (worst === null) return { status: !region ? "範囲外" : "判定なし", worst: null, which: "", n: 0 };
  const w = worst[1].events / worst[1].total;
  const few = worst[1].total < FEW_SAMPLES;
  const exceeded = w > r.gate;
  const sure = exceeded && exactLower(worst[1]) > r.gate;
  const status = !region ? "範囲外"
    : r.cond.knownLimit !== null ? `既知の限界(${r.cond.knownLimit})`
    : sure ? "超過(確実)" : exceeded && !few ? "超過" : "OK";
  return { status, worst: w, which: worst[0], n: worst[1].total };
}

function row(r: Result): string {
  const g = gateOf(r);
  return [
    r.cond.group, r.cond.name, String(r.cond.arms.length), String(r.cond.runs), r.seed.toString(16).padStart(8, "0"),
    pct(r.meanFailureRatio), pct(r.meanStopRatio), pct(r.meanCvr[0] === 0 ? null : r.meanCvr[1] / r.meanCvr[0] - 1, 2),
    pct(rate(r.nullAdopt)), pct(rate(r.nullWorse)), pct(rate(r.wrong)), pct(rate(r.power)),
    pct(rate(r.blocked), 1), pct(rate(r.stopBlocked), 1), pct(rate(r.insufficient), 1),
    String(g.n), pct(1 - (rate(r.blocked) ?? 0), 1), pct(r.gate),
    `${g.status}${g.worst === null ? "" : `(${g.which} ${pct(g.worst)})`}${g.n > 0 && g.n < FEW_SAMPLES ? ` 少数 n=${g.n}` : ""}`,
  ].join(" | ");
}

const HEADER = [
  "群", "条件", "パターン数", "回数", "seed", "失敗の割合(実測)", "停止の割合(実測)", "CVR の偏り(パターン1 / 基準 - 1)",
  "差なし: 採用候補", "差なし: 悪化", "効果あり: 逆向き", "効果あり: 検出", "判定不可", "うち停止で判定不可", "判断材料不足", "関門の集計の比較数", "判定が出た割合", "関門(1.5倍)", "関門の結果",
];

function printTable(title: string, results: Result[]): void {
  console.log(`\n### ${title}\n`);
  console.log(`| ${HEADER.join(" | ")} |`);
  console.log(`|${HEADER.map(() => "---").join("|")}|`);
  for (const r of results) console.log(`| ${row(r)} |`);
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { runs: number; scale: string[]; filter: string | null; selfcheck: boolean; help: boolean } {
  const o = { runs: 4_000, scale: [] as string[], filter: null as string | null, selfcheck: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--runs") o.runs = Number(argv[++i]);
    else if (a === "--scale") o.scale = String(argv[++i]).split(",");
    else if (a === "--filter") o.filter = String(argv[++i]);
    else if (a === "--selfcheck") o.selfcheck = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`知らない引数です: ${a}`);
  }
  if (!Number.isInteger(o.runs) || o.runs < 2_000) throw new RangeError("--runs は 2000 以上の整数です");
  return o;
}

function selfcheck(): boolean {
  // コホート版と人ごと版で、n・y・失敗の数の平均が合うか(M の規模、代表の条件)
  const scale = SCALES.find((s) => s.name === "M")!;
  const picks = ["一様 PC 倍率2", "集中 C A速・B遅", "停止5% end A速・B遅", "停止5% random 遅れ同じ", "停止5% two A遅・B速"];
  const conds = buildConditions(2_000, scale).filter((c) => picks.includes(c.name));
  let ok = true;
  console.log("| 条件 | 指標 | コホート版 | 人ごと版 | 差 |\n|---|---|---|---|---|");
  for (const cond of conds) {
    const compiled = compile(cond, scale);
    const runs = 600;
    const mean = (naive: boolean): number[] => {
      const rng = makeRng(hashSeed(`selfcheck:${cond.name}`) ^ (naive ? 0x5bd1e995 : 0));
      const acc = [0, 0, 0, 0, 0];
      for (let r = 0; r < runs; r++) {
        const o = naive ? runOnceNaive(rng, compiled) : runOnce(rng, compiled);
        acc[0]! += o.n[0]! / runs; acc[1]! += o.y[0]! / runs; acc[2]! += o.n[1]! / runs; acc[3]! += o.y[1]! / runs;
        acc[4]! += o.failedSends / runs;
      }
      return acc;
    };
    const a = mean(false), b = mean(true);
    ["n(基準)", "y(基準)", "n(B)", "y(B)", "失敗の数"].forEach((label, i) => {
      const rel = b[i]! === 0 ? Math.abs(a[i]!) : Math.abs(a[i]! - b[i]!) / b[i]!;
      const tol = label === "失敗の数" ? 0.15 : 0.03; // 失敗の数は少なく揺れが大きい
      const flag = rel > tol && Math.abs(a[i]! - b[i]!) > 3 ? "NG" : "ok";
      if (flag === "NG") ok = false;
      console.log(`| ${cond.name} | ${label} | ${a[i]!.toFixed(1)} | ${b[i]!.toFixed(1)} | ${(rel * 100).toFixed(2)}% ${flag} |`);
    });
  }
  return ok;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("使い方: pnpm sim [--runs N] [--scale tiny,M,L,XL,XXL] [--filter 条件名の一部] [--selfcheck]");
    return;
  }
  if (args.selfcheck) {
    const ok = selfcheck();
    console.log(ok ? "\nselfcheck: ok" : "\nselfcheck: NG");
    process.exitCode = ok ? 0 : 1;
    return;
  }
  const scales = args.scale.length === 0 ? SCALES : SCALES.filter((s) => args.scale.includes(s.name));
  console.log(`# 判定の誤りの率のシミュレーション(master seed ${MASTER_SEED}、期間 ${DAYS} 日、しきい値 ${DEFAULT_PLAN.threshold}%)`);
  console.log("条件ごとの seed = FNV-1a(\"<master seed>:<規模>:<条件名>\")。表の seed 列に 16 進で示す。");
  const trips: string[] = [];
  let validationFailed = false;
  for (const scale of scales) {
    const t0 = Date.now();
    const conds = buildConditions(args.runs, scale).filter((c) => args.filter === null || c.name.includes(args.filter));
    const results: Result[] = [];
    for (const cond of conds) {
      const runs = cond.validation ? Math.max(cond.runs, args.runs) : cond.runs;
      results.push(...simulateCondition({ ...cond, runs }, scale, runs));
    }
    printTable(`規模 ${scale.name}(1 日 ${scale.perDayPerArm.toLocaleString("en-US")} 人 / パターン、CVR ${(scale.cvr * 100).toFixed(1)}%、${DAYS} 日)`, results);
    for (const r of results) {
      const g = gateOf(r);
      if (g.status === "超過" || g.status === "超過(確実)") trips.push(`${scale.name} / ${r.cond.name}: ${g.which} ${pct(g.worst)} > ${pct(r.gate)}(${g.status})`);
      if (r.cond.validation) {
        // シミュレーションの検証: 差なしの A/A は片方向それぞれ想定の率の ±3 標準誤差に収まる
        const se = Math.sqrt((r.nominal * (1 - r.nominal)) / r.cond.runs / Math.max(1, r.m));
        for (const t of [r.nullAdopt, r.nullWorse]) {
          const v = rate(t);
          if (v !== null && scale.name !== "tiny" && Math.abs(v - r.nominal) > 3 * se + 0.003) {
            validationFailed = true;
            trips.push(`検証 NG: ${scale.name} / ${r.cond.name}: ${pct(v)} (想定 ${pct(r.nominal)})`);
          }
        }
      }
    }
    console.error(`規模 ${scale.name}: ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  }
  console.log("\n## 関門の超過\n");
  if (trips.length === 0) console.log("なし");
  else for (const t of trips) console.log(`- ${t}`);
  if (validationFailed) process.exitCode = 2;
}

main();
