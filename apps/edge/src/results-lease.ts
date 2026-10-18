import { utcDay } from "@wtt/core";
import type { Env } from "./env";
import { budgetLimits, budgetStub, type LeaseResult } from "./results-budget";

/**
 * isolate ごとの書き込みの枠(D9 ② K10・設計書 §6.9)。結果の書き込みは、先にこの枠から batch の最大の行数
 * (`RESULTS_ROWS` から出した見込み)を取ってから書く。枠が足りなければ予算の DO から `max(leaseRows, rows)` を受け取る。
 *
 * 予算の保証(K10・レビュー r4):
 * - DO が配る合計は予算以下(DO 側)。この holder が書ける行は「受け取った枠 + 自分の batch の少なかった分」だけ
 * - batch の実際の行数が見込み以下なら、書き込みの合計は受け取った枠以下 = 全体で予算以下
 * - 見込みを超えた batch があったときだけ、超過はその超えた分の和まで(超えた分は手元の枠から引き、ログに残す)
 * - 少なかった分は、同じ日・同じ世代の手元の枠に戻すだけ(DO には戻さない。前の日・前の世代・捨てた後の枠にも戻さない)
 *
 * タイマーは使わない。60 秒ごとの停止の確認・届かなかった後の 5 秒・停止の終わり・日付の変わり目・返らない DO の呼び出しの
 * 切り離しは、すべて `take` の `now` との比較で判定する(待ちの Promise を isolate に残さない)
 */

export type LeaseTicket = { day: string; gen: number; rows: number };
export type TakeResult = { kind: "ok"; ticket: LeaseTicket } | { kind: "stopped"; until: number } | { kind: "unreachable" };

export type LeaseDeps = {
  /** 予算の DO の lease(K10)。throw は「届かない」として扱う */
  lease(day: string, rows: number, now: number): Promise<LeaseResult>;
  /** 予算の DO の check(K10) */
  check(now: number): Promise<{ stoppedUntil: number | null }>;
  /** 1 回に受け取る枠の行数(RESULTS_LEASE_ROWS) */
  leaseRows: number;
  /** 見込みを超えた batch のログ(既定 console.warn) */
  warn?: (message: string) => void;
};

export type LeaseHolder = {
  /** rows = batch の見込みの行数(正の整数。違えば TypeError で拒否し、状態に触れない) */
  take(rows: number, now: number): Promise<TakeResult>;
  /**
   * actualWritten = D1 の `meta.rows_written` の合計(0 以上の整数。違えば TypeError)。
   * 二重の精算は ticket のオブジェクトの同一性で見分けるので、take が返した ticket のオブジェクトをそのまま渡す(写しを渡すと 2 回目も効く)
   */
  settle(ticket: LeaseTicket, actualWritten: number): void;
  discard(): void;
  readonly stoppedUntil: number | null;
};

/** 最後に DO に確かめてから、手元の枠を確認なしで使ってよい時間。外から立てた停止はこの遅れで効く */
const CHECK_INTERVAL_MS = 60_000;
/** DO に届かなかった後、DO を呼ばずに unreachable を返す時間(連打しない) */
const UNREACHABLE_BACKOFF_MS = 5_000;
/**
 * DO の呼び出しを始めてから、返らないものとして切り離すまでの時間。呼び出しは同じ isolate の要求が共有するので、
 * 始めた要求が取り消される・DO が応答しないと、以後の take が永久に待ち、結果のイベントが failed にも数えられない。
 * 届かなかった後の後退と同じ 5 秒にそろえる(返らない呼び出し 1 回で、その isolate が書けない時間は最大で約 10 秒。
 * 通常の DO の呼び出しは数十ミリ秒なので、5 秒で返らなければ届かないのと同じに扱ってよい)。
 * 判定は後から来た take の now で行う(タイマーを置かない)
 */
const INFLIGHT_TIMEOUT_MS = 5_000;
const DAY_MS = 86_400_000;

export function createLeaseHolder(deps: LeaseDeps): LeaseHolder {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  // 手元の枠。remaining は見込みを超えた batch の分を引くと負になりうる(次に受け取る枠から差し引かれる)
  let day: string | null = null;
  let remaining = 0;
  let gen = 0;
  let lastContactAt: number | null = null; // 最後に DO に届いた時刻(lease か check)
  let stoppedUntil: number | null = null;
  let unreachableUntil = 0;
  // 受け取り中・確認中の DO の呼び出し(同じ isolate の同時の take が共有する)。done は呼び出しの終わりか切り離しで解決する
  // (切り離したとき、すでに待っている take も起こす)。id は切り離した後に届いた古い呼び出しの結果を捨てるため
  let inflight: { id: number; since: number; done: Promise<void>; release: () => void } | null = null;
  let callSeq = 0;
  /** この呼び出しが今も inflight か(切り離された古い呼び出しは、成功・停止・失敗のどれも状態に入れない) */
  const isLive = (id: number): boolean => inflight?.id === id;
  const settled = new WeakSet<LeaseTicket>();

  /** 手元の枠を捨てる。世代を進めるので、捨てる前の ticket の精算は戻らない */
  const dropLocal = (): void => {
    remaining = 0;
    gen++;
  };
  const markStopped = (until: number): void => {
    stoppedUntil = until;
    dropLocal();
  };

  const refreshLease = async (id: number, forDay: string, rows: number, now: number): Promise<void> => {
    // 負の残り(見込みを超えた分)があれば、その分も受け取らないと batch に足りない
    const ask = Math.max(deps.leaseRows, rows - Math.min(remaining, 0));
    let res: LeaseResult;
    try {
      res = await deps.lease(forDay, ask, now);
    } catch {
      if (isLive(id)) unreachableUntil = now + UNREACHABLE_BACKOFF_MS;
      return;
    }
    // 切り離した後に届いた枠は手元に入れない(DO 側では配った分として数えられているので、予算の上限は崩れない)
    if (!isLive(id)) return;
    lastContactAt = now;
    // 停止の終わりが過ぎた値でも、同じ now の take が DO を呼び直し続けないよう少なくとも now より後にする
    if (!res.ok) return markStopped(Math.max(res.stoppedUntil, now + 1));
    // 受け取り直すたびに世代を進める。手元の残り(同じ日の、DO が配った分)はそのまま足す。
    // DO を待つ間にも settle(同じ日・同じ世代の差を戻す・引く)と discard(残りを 0 にして世代を進める)は走る。
    // 世代は await の後に進めるので、待つ間の精算は受け取り直す前の世代として扱われ、以後の精算は新しい世代の分だけが戻る。
    // day は inflight の間は take が変えない(切り離した後の古い呼び出しは上で捨てる)ので、take が合わせた forDay のまま
    gen++;
    remaining += res.rows;
    // 残りが求めた分より少ない = DO の予算が尽きた。batch に足りなければ次の UTC 0 時まで止まる
    // (DO は配り終えた時点で write_budget の停止を残している)
    if (res.rows < ask && remaining < rows) markStopped(Date.parse(`${forDay}T00:00:00Z`) + DAY_MS);
  };

  const refreshCheck = async (id: number, now: number): Promise<void> => {
    let res: { stoppedUntil: number | null };
    try {
      res = await deps.check(now);
    } catch {
      if (isLive(id)) unreachableUntil = now + UNREACHABLE_BACKOFF_MS;
      return;
    }
    if (!isLive(id)) return;
    lastContactAt = now;
    if (res.stoppedUntil !== null && res.stoppedUntil > now) markStopped(res.stoppedUntil);
  };

  /** DO の呼び出しを始めて inflight に置く。古い呼び出しの終わりが新しい inflight を消さないよう、id で見分ける */
  const run = (now: number, call: (id: number) => Promise<void>): void => {
    const id = ++callSeq;
    let release!: () => void;
    const done = new Promise<void>((res) => (release = res));
    inflight = { id, since: now, done, release };
    // call は await の後で isLive を見るので、inflight を置いてから始める
    void call(id).finally(() => {
      if (isLive(id)) inflight = null;
      release();
    });
  };

  return {
    get stoppedUntil() {
      return stoppedUntil;
    },

    async take(rows: number, now: number): Promise<TakeResult> {
      // 壊れた行数を DO に渡すと DO の TypeError が「届かない」に見えて isolate が 5 秒止まり、端数は残りを小数にする。状態に触れる前に拒否する
      if (!Number.isSafeInteger(rows) || rows < 1) throw new TypeError(`invalid rows: ${rows}`);
      if (!Number.isFinite(now)) throw new TypeError(`invalid time: ${now}`);
      for (;;) {
        if (stoppedUntil !== null) {
          if (now < stoppedUntil) return { kind: "stopped", until: stoppedUntil };
          stoppedUntil = null;
        }
        if (now < unreachableUntil) return { kind: "unreachable" };
        if (inflight) {
          if (now - inflight.since >= INFLIGHT_TIMEOUT_MS) {
            // 返らない呼び出しは届かなかったものとして切り離す。DO を呼び直さず、届かなかった後の 5 秒の後退に入る。
            // 手元の枠は DO が配った分なので捨てない。待っている take も起こし、後退を見て unreachable を返させる
            const stale = inflight;
            inflight = null;
            unreachableUntil = now + UNREACHABLE_BACKOFF_MS;
            stale.release();
            return { kind: "unreachable" };
          }
          await inflight.done;
          continue; // 結果(停止・届かない・新しい枠)を見直す
        }
        const today = utcDay(now);
        if (day !== today) {
          // 前の日の枠は使わない(前の日の残りで今日の分を書かない)
          if (day !== null) dropLocal();
          day = today;
        }
        if (remaining >= rows) {
          if (lastContactAt !== null && now - lastContactAt > CHECK_INTERVAL_MS) {
            // 枠には期限を付けず、使う前に停止だけを確かめる(期限で捨てると少ない流量でも 60 秒ごとに枠を使い切る)
            run(now, (id) => refreshCheck(id, now));
            continue;
          }
          remaining -= rows; // await の前に引くので、同じ isolate の同時の take が同じ枠を二重に使わない
          return { kind: "ok", ticket: { day: today, gen, rows } };
        }
        // 受け取った後は必ず「足りる」「止まる」「届かない」のどれかになる(ask は足りない分以上を求める)ので、回り続けない
        run(now, (id) => refreshLease(id, today, rows, now));
      }
    },

    settle(ticket: LeaseTicket, actualWritten: number): void {
      if (!Number.isSafeInteger(actualWritten) || actualWritten < 0) throw new TypeError(`invalid actualWritten: ${actualWritten}`);
      if (settled.has(ticket)) return;
      settled.add(ticket);
      if (actualWritten > ticket.rows) warn(`wtt-edge: results batch wrote ${actualWritten} rows, above the estimate of ${ticket.rows}; RESULTS_ROWS should be raised`);
      // 今の世代(同じ日・受け取り直す前・捨てる前)の ticket だけ差を戻す・引く
      if (ticket.gen !== gen || ticket.day !== day) return;
      remaining += ticket.rows - actualWritten;
    },

    discard(): void {
      dropLocal();
    },
  };
}

let shared: LeaseHolder | null = null;

/**
 * isolate に 1 つの LeaseHolder。予算の DO の stub は呼び出しのたびに作る(env の binding は isolate の中で変わらない)。
 * 予算の DO の binding が無い導入でも throw は「届かない」になり、書かずに failed になる
 */
export function leaseHolder(env: Env): LeaseHolder {
  if (!shared) {
    shared = createLeaseHolder({
      leaseRows: budgetLimits(env).leaseRows,
      lease: (d, rows, now) => budgetStub(env).lease(d, rows, now),
      check: (now) => budgetStub(env).check(now),
    });
  }
  return shared;
}

/** テストで isolate の作り直しを再現する */
export function resetLeaseHolderForTest(): void {
  shared = null;
}
