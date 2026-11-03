import { BUSY_MIN_MS, WRITE_TIMEOUT_MS } from "./feedback-store";
import type { RefreshResult } from "./use-refresh-and-wait";

/**
 * 書き込みの間の時間の決まり(B173 第 1 段。components/ui/BusyScope.tsx の中身)。
 * React・DOM に依らない純粋な関数にして、偽の時計・sleep で単体テストする(test/busy-scope.test.ts)。
 * 範囲ごとの実行権(二度押しの防止)と覆いの出し外し・フォーカスは hook が持つ。ここは「いつ覆い、いつ結果を決めるか」だけ。
 *
 * ここは Date.now / performance.now を描画の中で使わない約束(test/hydration-guard.test.ts)の対象外の lib に置く。時計は deps で受ける
 */

/** 書き込みの 1 回分。既定の label は BusyScope が `保存中…` にする */
export type BusyTask<T> = {
  /** 覆いの文言 */
  label?: string;
  /** 書き込みの前の確認。false なら何もしない(覆いも出さない) */
  confirm?: () => Promise<boolean>;
  /** 書き込み本体。signal は 30 秒の上限で止める合図(fetch に渡す) */
  write: (signal: AbortSignal) => Promise<T>;
  /** 書き込みが成功した直後(読み直しの前)。読み直しで届く値と比べる基準を、送った値に入れ替えるのに使う */
  onWritten?: (value: T) => void;
  /**
   * refresh = 成功の後に読み直しの反映まで待つ。
   * none = 読み直しをしない。書き込みの成功と最短 300 ms の後に、覆いと実行権を戻す(全画面の移動まで覆う用途には使わない。
   * 使うと、移動でページが閉じる前にフォームがまた押せる状態になり、二重の作成を止められない)。
   * 申し送り: 全画面の移動が終わるまで覆い続ける形(例 after: "navigate"。自分で始めた遷移を discarded と判定しないよう、
   * 遷移を始める前の通し番号で区別する)は、作成のフォームに範囲の部品を付ける第 2 段で足す(spec §5.2-4)。第 1 段では使う所が無い
   */
  after: "refresh" | "none";
};

export type BusyOutcome<T> =
  | { kind: "saved"; value: T; refresh: RefreshResult | "skipped" }
  /** 書き込みが失敗した */
  | { kind: "failed"; error: unknown }
  /** 30 秒待っても結果が分からない(書き込みが通ったかは不明) */
  | { kind: "unknown" }
  /** 結果が返る前に別の画面への遷移が始まったので、結果を画面に反映しない */
  | { kind: "discarded" }
  /** 確認で取りやめた */
  | { kind: "cancelled" }
  /** すでに実行中だったので、何もしなかった */
  | { kind: "ignored" };

export type BusyDeps = {
  /** 最低の表示時間の残りを待つ */
  sleep(ms: number): Promise<void>;
  refresh(): Promise<RefreshResult>;
  /** 通し番号を取る(feedback-store の nextSeq) */
  seq(): number;
  /** その番号より後に遷移が始まったか(feedback-store の navStartedAfter) */
  navStartedAfter(seq: number): boolean;
  noteWriteSucceeded(): void;
  /** 覆いを出す。押したボタンを覚えるのもここ(確認が終わった後の activeElement を覚えるため) */
  showOverlay(): void;
  /** 単調増加の時計(ms) */
  now(): number;
};

/**
 * 実際の時計・sleep(BusyScope が deps に渡す)。ここ(lib)に置くのは、components/ で performance.now() を直接書くと
 * ハイドレーションの検査(test/hydration-guard.test.ts)に掛かるため。呼ぶのは書き込みの実行中(= マウントの後)だけ
 */
export const realClock: Pick<BusyDeps, "sleep" | "now"> = {
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
};

// ---- 範囲ごとの実行権 ----

/** 実行権を取る。すでに誰かが持っていれば false(確認の間・Enter キーの送信も含めて、二度目は無視する) */
export function claimRun(ref: { current: boolean }): boolean {
  if (ref.current) return false;
  ref.current = true;
  return true;
}

/** 実行権を返す */
export function releaseRun(ref: { current: boolean }): void {
  ref.current = false;
}

// ---- 時間の決まり ----

type WriteResult<T> = { ok: true; value: T } | { ok: false; error: unknown } | { timeout: true };

/**
 * 書き込みを 30 秒の上限で呼ぶ。上限を超えたら AbortController で止めて timeout を返す。
 * 上限の時計は deps.sleep ではなく本物の setTimeout で持つ(sleep は 300 ms の最低表示だけに使う。失敗がすぐ返ることを sleep の呼び出しで確かめられるように)。
 * 上限の後に書き込みが成功・失敗しても、結果は見ない(unknown で返した後なので。拒否は握って未処理の拒否にしない)
 */
function writeWithTimeout<T>(task: BusyTask<T>): Promise<WriteResult<T>> {
  const controller = new AbortController();
  return new Promise<WriteResult<T>>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ timeout: true });
    }, WRITE_TIMEOUT_MS);
    // write が同期で throw しても失敗として扱う
    new Promise<T>((res) => res(task.write(controller.signal))).then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ ok: false, error });
      },
    );
  });
}

/**
 * 書き込みを 1 回実行し、結果を返す。決まりは spec の「書き込みの間」の節のとおり:
 * 確認 → 通し番号・覆い → 書き込み(30 秒)→ 失敗・遷移の確かめ → onWritten・基準の入れ替え → 読み直し → 遷移の確かめ → 覆ってから 300 ms まで待つ → もう一度遷移の確かめ。
 * 覆いを外す・実行権を返す・フォーカスを戻すのは呼び出し側(返ったらすぐ外す。saved だけ、ここで 300 ms を待ってから返る)
 */
export async function runBusy<T>(deps: BusyDeps, task: BusyTask<T>): Promise<BusyOutcome<T>> {
  if (task.confirm && !(await task.confirm())) return { kind: "cancelled" };

  const seq = deps.seq();
  deps.showOverlay();
  const coveredAt = deps.now();

  const result = await writeWithTimeout(task);
  if ("timeout" in result) return { kind: "unknown" };
  if (!result.ok) {
    // 失敗の前に別の画面へ移り始めていれば、失敗の表示は出す先が無いので捨てる
    return deps.navStartedAfter(seq) ? { kind: "discarded" } : { kind: "failed", error: result.error };
  }
  if (deps.navStartedAfter(seq)) return { kind: "discarded" };

  // 基準の入れ替えは読み直しの前に行う(読み直しで届く値と比べる時点で、基準が送った値になっているように)
  task.onWritten?.(result.value);
  deps.noteWriteSucceeded();

  let refresh: RefreshResult | "skipped" = "skipped";
  if (task.after === "refresh") {
    refresh = await deps.refresh();
    // 読み直しの間に「移動する」を選んだ場合
    if (deps.navStartedAfter(seq)) return { kind: "discarded" };
  }

  // 一瞬で消えるちらつきを避けるため、覆ってから最低 BUSY_MIN_MS は出し続ける
  const rest = BUSY_MIN_MS - (deps.now() - coveredAt);
  if (rest > 0) await deps.sleep(rest);
  if (deps.navStartedAfter(seq)) return { kind: "discarded" };

  return { kind: "saved", value: result.value, refresh };
}
