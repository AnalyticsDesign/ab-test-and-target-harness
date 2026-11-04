import { BUSY_MIN_MS, NAV_TIMEOUT_MS, WRITE_TIMEOUT_MS, navOutcome, navStartedAfter, nextSeq, subscribe } from "./feedback-store";
import type { NavHandle } from "./navigate";
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
   * 書き込みの成功の後の処理。関数のときは書き込みの結果を見て選ぶ(応答で移動するか読み直すかが変わるもの。成功の後に 1 回だけ呼ぶ)。
   * refresh = 読み直しの反映まで待つ。
   * none = 読み直しをしない。書き込みの成功と最短 300 ms の後に、覆いと実行権を戻す(全画面の移動まで覆う用途には使わない。
   * 使うと、移動でページが閉じる前にフォームがまた押せる状態になり、二重の作成を止められない。移動には navigate を使う)。
   * navigate = 範囲の離れる前の確認を外して task.navigate で移動し、移動が終わる(ページが閉じる・部品が消える)まで覆いと実行権を保つ
   * (B173 第 2 段)。移動を始めた後は navStartedAfter を見ない(自分で始めた遷移を discarded と取り違えないため)。
   * 移動が打ち切り・別の遷移に替わった・始まらなかったときだけ、覆いを外して navigated を返す(確認の登録も戻す)。
   * custom = 画面が task.custom で自分で取り直す(上限 10 秒)。その後は refresh と同じ(遷移の確かめ → 300 ms)。
   * 取り直しが 10 秒で終わらない・失敗したときは書き込みの失敗にせず、saved の refresh: "timeout" にする
   */
  after: AfterKind | ((value: T) => AfterKind);
  /** after が navigate になりうるとき必須。navigateApp / navigateDocument / reloadDocument を呼び、その戻り値を返す */
  navigate?: (value: T) => NavHandle;
  /** after が custom になりうるとき必須。signal は 10 秒の上限で止める合図 */
  custom?: (value: T, signal: AbortSignal) => Promise<void>;
};

export type AfterKind = "refresh" | "none" | "navigate" | "custom";

/** 移動を待った結果(移動が終わらずに覆いを外したとき) */
export type NavWaitResult = "timedOut" | "replaced" | "none";

export type BusyOutcome<T> =
  | { kind: "saved"; value: T; refresh: RefreshResult | "skipped" }
  /** after: navigate の移動が打ち切り・別の遷移に替わった・始まらなかった(印で終われば部品が消えるので返らない) */
  | { kind: "navigated"; value: T; nav: NavWaitResult }
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
  /**
   * 持ち主の範囲(BusyScope)が生きているか。unmount・作り直しで false になり、戻らない。
   * 戻る・進むの守りを通らずに画面を離れた(store に遷移が記録されない)ときも、範囲が消えればここで止まる
   */
  alive(): boolean;
  /** 範囲の離れる前の確認の登録を外す(自分の移動を止めないように)。戻り値は元に戻す関数(移動が終わらなかったときに呼ぶ) */
  releaseGuard(): () => void;
  /** 移動の終わりを待つ(createNavWaiter)。ページが閉じる・部品が消えるときは解決しない */
  waitNav(h: NavHandle): Promise<NavWaitResult>;
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
 * 画面の取り直し(task.custom)を 10 秒の上限で呼ぶ。上限を超えたら signal を中止して timeout。失敗(reject・同期の throw)も timeout。
 * 時計は writeWithTimeout と同じく本物の setTimeout(上限の後に届いた結果・拒否は見ない)
 */
function customWithTimeout<T>(custom: (value: T, signal: AbortSignal) => Promise<void>, value: T): Promise<RefreshResult> {
  const controller = new AbortController();
  return new Promise<RefreshResult>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, NAV_TIMEOUT_MS);
    new Promise<void>((res) => res(custom(value, controller.signal))).then(
      () => {
        clearTimeout(timer);
        resolve("done");
      },
      () => {
        clearTimeout(timer);
        controller.abort();
        resolve("timeout");
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
  // 持ち主の生存の確かめ(B173 第 2 段)。順は (1) 確認の後(覆う前) (2) 書き込みの後(30 秒の時間切れも) (3) onWritten の前 (4) 後の処理(none 以外)の前
  // (5) refresh・custom の後 (6) 300 ms の待ちの後(結果を返す前)。
  // false なら、その先を始めずに discarded(消えた範囲の結果は出す先が無い。守りを素通りした戻る・進むは navStartedAfter に記録されない)。
  // navigate の移動を待つ間(navigateAndWait)は見ない: 自分の移動で範囲が消えるのは想定どおり(印で終われば返らない)
  if (!deps.alive()) return { kind: "discarded" };

  const seq = deps.seq();
  deps.showOverlay();
  const coveredAt = deps.now();

  const result = await writeWithTimeout(task);
  // (2) 時間切れでも、範囲が消えた・別の遷移が始まったなら unknown にしない(呼び出し側が取り直し・後の再取得を始めないように。最終レビュー I1)
  if ("timeout" in result) return !deps.alive() || deps.navStartedAfter(seq) ? { kind: "discarded" } : { kind: "unknown" };
  // (2) 失敗のときも、範囲が消えていれば失敗の表示は出す先が無いので捨てる
  const gone = !deps.alive();
  if (!result.ok) {
    // 失敗の前に別の画面へ移り始めていれば、失敗の表示は出す先が無いので捨てる
    return gone || deps.navStartedAfter(seq) ? { kind: "discarded" } : { kind: "failed", error: result.error };
  }
  if (gone || deps.navStartedAfter(seq)) return { kind: "discarded" };

  const value = result.value;
  // 後の処理は書き込みの成功の後に 1 回だけ決める(移動と読み直しが両方走らない)
  const after = typeof task.after === "function" ? task.after(value) : task.after;

  // (3) 基準の入れ替えは読み直しの前に行う(読み直しで届く値と比べる時点で、基準が送った値になっているように)
  if (!deps.alive()) return { kind: "discarded" };
  task.onWritten?.(value);
  deps.noteWriteSucceeded();

  // (4)
  if (after !== "none" && !deps.alive()) return { kind: "discarded" };

  if (after === "navigate") return navigateAndWait(deps, task, value);

  let refresh: RefreshResult | "skipped" = "skipped";
  if (after === "refresh") {
    refresh = await deps.refresh();
    // 読み直しの間に「移動する」を選んだ場合・範囲が消えた場合(5)
    if (!deps.alive() || deps.navStartedAfter(seq)) return { kind: "discarded" };
  } else if (after === "custom") {
    if (!task.custom) throw new Error("after: custom には task.custom が要る");
    refresh = await customWithTimeout(task.custom, value);
    // (5)
    if (!deps.alive() || deps.navStartedAfter(seq)) return { kind: "discarded" };
  }

  // 一瞬で消えるちらつきを避けるため、覆ってから最低 BUSY_MIN_MS は出し続ける
  const rest = BUSY_MIN_MS - (deps.now() - coveredAt);
  if (rest > 0) await deps.sleep(rest);
  // (6)
  if (!deps.alive() || deps.navStartedAfter(seq)) return { kind: "discarded" };

  return { kind: "saved", value: result.value, refresh };
}

/**
 * after: navigate の後半。確認の登録を外してから移動し、移動の終わりを待つ。この間は覆いと実行権を保つ(呼び出し側の finally は、
 * ここが返るまで走らない)。300 ms の最短は待たない(移動がそれより早く終わればページごと消える)。
 * 移動が終わらなかった(打ち切り・別の遷移に替わった・始まらなかった)ときは、確認の登録を戻してから navigated を返す
 */
async function navigateAndWait<T>(deps: BusyDeps, task: BusyTask<T>, value: T): Promise<BusyOutcome<T>> {
  if (!task.navigate) throw new Error("after: navigate には task.navigate が要る");
  const restore = deps.releaseGuard();
  let nav: NavWaitResult;
  try {
    nav = await deps.waitNav(task.navigate(value));
  } catch (error) {
    // 移動を始められなかった(navigate の throw)。登録を戻してから呼び出し側に渡す
    restore();
    throw error;
  }
  restore();
  return { kind: "navigated", value, nav };
}

// ---- 移動の終わりを待つ(BusyScope の waitNav の中身。React に依らないので、実際の store・入口と組み合わせて単体テストする) ----

/**
 * 範囲ごとの移動の待ち。onOwnTimeout は、範囲が自分で打ち切りの文言を出す合図(store の遷移を始めない移動 = reloadDocument・外の URL だけ。
 * store の遷移を始めた移動の打ち切りは NavGate が出すので、重ねて出さない)。
 * dispose は範囲の unmount で呼ぶ: 待っている購読・タイマーをすべて外す(解決しない Promise を残しても、購読・タイマーは残らない)
 */
export function createNavWaiter(onOwnTimeout: () => void): { waitNav(h: NavHandle): Promise<NavWaitResult>; dispose(): void } {
  const cleanups = new Set<() => void>();

  const waitNav = (h: NavHandle): Promise<NavWaitResult> => {
    if (h.kind === "none") return Promise.resolve("none");
    return new Promise<NavWaitResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        unsubscribe?.();
        unsubscribe = null;
        cleanups.delete(cleanup);
      };
      /** 待ちを終える。result が null(印で終わった)なら解決しない(部品が消える・ページが閉じる) */
      const finish = (result: NavWaitResult | null) => {
        cleanup();
        if (result) resolve(result);
      };

      let check: () => void;
      const navSeq = h.seq;
      if (navSeq !== null) {
        // store の遷移を始めた移動(app・アプリの中の navigateDocument): その番号の遷移の行方を見る。打ち切りの文言は NavGate
        check = () => {
          const outcome = navOutcome(navSeq);
          if (outcome === "pending") return;
          finish(outcome === "ended" ? null : outcome);
        };
      } else {
        // store の遷移を始めない移動(reloadDocument・外の URL): 呼んだ時点より後の遷移が始まったら替わった。時計と文言は自分で持つ
        const base = nextSeq();
        check = () => {
          if (navStartedAfter(base)) finish("replaced");
        };
        timer = setTimeout(() => {
          timer = null;
          finish("timedOut");
          onOwnTimeout();
        }, NAV_TIMEOUT_MS);
      }
      cleanups.add(cleanup);
      unsubscribe = subscribe(check);
      // 呼んだ時点ですでに決まっていることがある(購読の前の変化は知らせが来ない)
      check();
    });
  };

  return {
    waitNav,
    dispose: () => {
      for (const fn of [...cleanups]) fn();
    },
  };
}
