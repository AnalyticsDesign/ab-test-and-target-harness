/**
 * 書き込みの後の読み直し(`router.refresh()`)が画面に反映されるまでの間、利用者が始めた遷移・節の切り替えを、反映の後に回す store。
 * React・ルーターに依らない(単体テストと、サーバーでも読まれる lib から使えるように)。読み直しを始める hook は `lib/use-refresh-and-wait.ts`。
 * 管理画面のフィードバックの spec(B173)の `refreshAndWait()`(§3.3)と遷移の入口(§4.1)のうち、遷移が捨てられるのを防ぐ部分だけを先に入れたもの。
 * 第 3 段で反映の終わりを画面の印(renderId)で知る形に替えるときも、ここの 3 つの関数(beginRefresh・deferUntilRefreshed・isRefreshPending)はそのまま使える。
 *
 * なぜ要るか(管理画面の速さ CE-R9。vinext 1.0.0-beta.10):
 * - 遷移は、始めた時点の画面の版(`visibleCommitVersion`)を覚え、反映の前に版が進んでいると、黙って捨てる
 *   (`app-browser-state.js` の `verifyOperationTokenForCommit` → staleOperation)。URL・パンくずは移動先に変わるが、本文は前の画面のまま止まる。
 * - refresh の反映も版を進める。refresh の応答が承認された後、React が画面に反映するまでの間に押した遷移は、捨てられる。
 * - refresh の反映は vinext の中で決まり、アプリからは止められない。spec §5.2 の「新しい遷移があれば refresh を呼ばない」は、refresh を呼ぶ前に
 *   遷移が始まっていた場合だけを防ぐ(ここで起きたのは、refresh を呼んだ後に押した遷移)。そのため、遷移の側を反映の後に回す。
 * - 代わりに、読み直しの途中に押した遷移は、読み直しの残りの時間(ふつうは数十 ms。上限は打ち切りの 10 秒)だけ遅れて始まる
 *
 * control への問い合わせは増やさない(読み直しの回数は今までと同じで、回した遷移は押したときと同じ 1 回だけ走る)
 */

/** 反映を待っている読み直し。始めた順(Map は入れた順)。鍵は始めた順の番号 */
const refreshes = new Map<number, { onEnd?: RefreshOnEnd; timer: ReturnType<typeof setTimeout> }>();
let refreshSeq = 0;
/** 反映の後に回した操作。鍵ごとに最後の 1 つだけ(後から押した遷移が前の遷移に替わる)。入れた順に走らせる */
const deferred = new Map<string, () => void>();

/** 読み直しの終わり方。ended = 反映を知らせた、superseded = 後の読み直しが終わったので一緒に終えた、timeout = 打ち切った */
export type RefreshEndReason = "ended" | "superseded" | "timeout";
type RefreshOnEnd = (reason: RefreshEndReason) => void;

/** 反映を待っている読み直しがあるか */
export function isRefreshPending(): boolean {
  return refreshes.size > 0;
}

/** 読み直しの反映を待っている間なら fn を後に回し(同じ鍵は最後の 1 つ)、待っていなければすぐ走らせる。後に回したら true */
export function deferUntilRefreshed(key: string, fn: () => void): boolean {
  if (refreshes.size === 0) {
    fn();
    return false;
  }
  deferred.delete(key);
  deferred.set(key, fn);
  return true;
}

/**
 * 読み直し id を終える。ended は、それより前に始めてまだ終わっていない読み直しも一緒に終える(superseded)。
 * vinext が先の読み直しを打ち消すと、先の呼び出し元の isPending は false に戻らないことがあるので、ここで知らせないと待ちが外れない。
 * timeout は自分だけ終える(後の読み直しはまだ待てる)。
 * 呼ぶ順: 終えた読み直しの onEnd(始めた順)をすべて呼んでから、待つ読み直しが 0 になったときだけ回した操作を走らせる。
 * onEnd が投げても回した操作は走らせ(止まったままにしない)、最初の例外はその後に投げ直す
 */
function endRefresh(id: number, reason: RefreshEndReason): void {
  if (!refreshes.has(id)) return;
  const ending: [RefreshOnEnd | undefined, RefreshEndReason][] = [];
  for (const [other, entry] of [...refreshes]) {
    if (other !== id && !(reason === "ended" && other < id)) continue;
    clearTimeout(entry.timer);
    refreshes.delete(other);
    ending.push([entry.onEnd, other === id ? reason : "superseded"]);
  }
  let failure: { error: unknown } | null = null;
  for (const [onEnd, why] of ending) {
    try {
      onEnd?.(why);
    } catch (error) {
      failure ??= { error };
    }
  }
  flushDeferredIfIdle();
  if (failure) throw failure.error;
}

/** 待つ読み直しが 0 なら、回した操作を入れた順に走らせる */
function flushDeferredIfIdle(): void {
  if (refreshes.size > 0) return;
  const run = [...deferred.values()];
  deferred.clear();
  for (const fn of run) fn();
}

/**
 * 読み直し id の待ちだけを外す(onEnd は呼ばない)。ended と違い、前に始めた読み直しは巻き込まない。
 * 呼び出し元が消えたとき・同じ呼び出し元が次の読み直しを始めるときに使う(ほかの部品の反映待ちを、勝手に終えないため)。
 * 外して待ちが 0 になったら、回した操作を走らせる
 */
function cancelRefresh(id: number): void {
  const entry = refreshes.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  refreshes.delete(id);
  flushDeferredIfIdle();
}

/** beginRefresh が返す関数。呼ぶと反映を知らせる(ended)。`.cancel()` は自分の待ちだけを外す */
export type RefreshHandle = (() => void) & { cancel: () => void };

/**
 * 読み直しを 1 つ始めたことにする。返す関数で反映を知らせる(2 回目以降は何もしない)。
 * timeoutMs(既定 10 秒。spec の打ち切りと同じ)の間に知らせが来なければ打ち切って、回した操作を走らせる(操作が止まったままにならないように)。
 * onEnd は終わったときに 1 回だけ呼ばれる(理由は RefreshEndReason)。`.cancel()` で外したものは呼ばれない
 */
export function beginRefresh(opts: { timeoutMs?: number; onEnd?: RefreshOnEnd } = {}): RefreshHandle {
  refreshSeq += 1;
  const id = refreshSeq;
  const timer = setTimeout(() => endRefresh(id, "timeout"), opts.timeoutMs ?? 10_000);
  refreshes.set(id, { onEnd: opts.onEnd, timer });
  return Object.assign(() => endRefresh(id, "ended"), { cancel: () => cancelRefresh(id) });
}
