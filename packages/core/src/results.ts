/**
 * 設計書 §6.3・§6.9(D9 ②): 結果の収集の定数・型・小さな関数。zod を import しない(runtime が import する。edge・control も共有する)。
 * イベントの本文のスキーマは protocol.ts、compiled config の `results` は schema.ts にある
 */
import { toBase64Url } from "./id";

/** runId の形(16 バイトの乱数の base64url 22 文字)。control が最初の開始のときに振る(設計書 §6.3) */
export const RUN_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** 新しい runId(16 バイトの乱数の base64url、`=` なし 22 文字) */
export function newRunId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * 訪問者 ID の短いハッシュ(SHA-256 の先頭 8 バイトの base64url、11 文字)。runtime の送信済みの印の `i` に使う(設計書 §6.2)。
 * 今の ID が変わったかを見分けるだけの値で、秘密ではない。`crypto.subtle` が無い環境(http のページなど)・失敗したときは null
 */
export async function shortVisitorHash(visitorId: string): Promise<string | null> {
  try {
    const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
    if (!subtle) return null;
    const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(visitorId)));
    return toBase64Url(digest.subarray(0, 8));
  } catch {
    return null;
  }
}

const DAY_MS = 86_400_000;

/** epoch ミリ秒の UTC の日付(`YYYY-MM-DD`)。予算の日次の区切りに使う */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 次の UTC 0 時の epoch ミリ秒(ちょうど 0 時なら翌日の 0 時)。停止の期限(`until`)に使う */
export function nextUtcMidnight(ms: number): number {
  return (Math.floor(ms / DAY_MS) + 1) * DAY_MS;
}

/** 結果のイベントへの応答の結果(設計書 §6.3・§6.4) */
export type ResultResult = "stored" | "ignored" | "stopped" | "failed";

/**
 * 1 つの run(または参加)の結果。`retry: false` は送り直さない `ignored`。
 * `until` は `result: "stopped"` のときに edge が決めた次の UTC 0 時の epoch ミリ秒(K8。runtime はそれまで送らない)
 */
export type ResultOutcome = { result: ResultResult; retry?: false; until?: number };

/** 結果のイベント(参加・CV)の応答の本文。CV は runId ごとの結果を `runs` に持つ(K8) */
export type ResultsEventResponse = ResultOutcome & { runs?: Record<string, ResultOutcome> };

/**
 * 計測用 D1 に書く 1 batch あたりの最大の行数(インデックスの書き込みを含む)。
 * PoC(docs/dev/research/d9_results_poc_2026-10-17.md)で測った最大(参加・CV の 1 run あたりとも 2 行)に 1 を足した値で、
 * 予算の枠の確認で batch の行数の上限として扱う(K10)
 */
export const RESULTS_ROWS = { participant: 3, conversionPerRun: 3 } as const;

/** 書き込み(1 日・UTC)と読み取りの日次の予算、予算の DO が 1 回に配る枠の行数の既定値。edge の vars で変えられる(K10) */
export const RESULTS_BUDGET_DEFAULTS = { writeRows: 70_000, readRows: 3_000_000, leaseRows: 200 } as const;
