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

/** 反映を待っている読み直しの数 */
let pending = 0;
/** 反映の後に回した操作。鍵ごとに最後の 1 つだけ(後から押した遷移が前の遷移に替わる)。入れた順に走らせる */
const deferred = new Map<string, () => void>();

/** 反映を待っている読み直しがあるか */
export function isRefreshPending(): boolean {
  return pending > 0;
}

/** 読み直しの反映を待っている間なら fn を後に回し(同じ鍵は最後の 1 つ)、待っていなければすぐ走らせる。後に回したら true */
export function deferUntilRefreshed(key: string, fn: () => void): boolean {
  if (pending === 0) {
    fn();
    return false;
  }
  deferred.delete(key);
  deferred.set(key, fn);
  return true;
}

/**
 * 読み直しを 1 つ始めたことにする。返す関数で反映を知らせる(2 回目以降は何もしない)。
 * timeoutMs の間に知らせが来なければ打ち切って、回した操作を走らせる(操作が止まったままにならないように。spec §3.3 の打ち切りと同じ 10 秒)
 */
export function beginRefresh(timeoutMs = 10_000): () => void {
  pending += 1;
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending -= 1;
    if (pending > 0) return;
    const run = [...deferred.values()];
    deferred.clear();
    for (const fn of run) fn();
  };
  const timer = setTimeout(end, timeoutMs);
  return end;
}
