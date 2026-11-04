/**
 * 確認の待ち行列(components/ConfirmProvider.tsx が持つ。B173 第 2 段 Task 2)。React に依らない純粋な部分。
 *
 * 確認のモーダルは画面に 1 つ。今までは新しい確認が来たら、開いている確認をキャンセル扱いで閉じて差し替えた(今もそう)。
 * 第 2 段の askHold(確定の後もダイアログを開いたまま、書き込みの間は覆う)を持ち続ける間(holding・failed)だけは、
 * 新しい確認を後に回し、閉じてから開く(書き込みの結果を宙に浮かせないため)。
 *
 * 要求は持ち主(呼んだ BusyScope の id。範囲の外の呼び出し = 離れる前の確認などは null)を持つ。持ち主の範囲が消えたら、
 * その持ち主の表示中の確認を閉じ、待たせている要求を外す(releaseOwner)。外したものは呼び出し元で cancelled として解く。
 *
 * phase: shown = 確定・取り消しを待つ / holding = 確定の後、呼び出し元の書き込みを待つ(覆い。取り消せない)/
 *        failed = 書き込みが失敗し、中に失敗を出して開いたまま(もう一度の確定か取り消しを待つ)
 */
export type ConfirmPhase = "shown" | "holding" | "failed";
export type ConfirmQueueRequest = { owner: string | null; hold: boolean };
export type ConfirmQueue<R extends ConfirmQueueRequest> = { current: { req: R; phase: ConfirmPhase } | null; waiting: R[] };
type Change<R extends ConfirmQueueRequest> = { queue: ConfirmQueue<R>; cancelled: R[] };

export function emptyQueue<R extends ConfirmQueueRequest>(): ConfirmQueue<R> {
  return { current: null, waiting: [] };
}

/** 待たせている先頭を表示に移す(表示中が無いときだけ) */
function promote<R extends ConfirmQueueRequest>(q: ConfirmQueue<R>): ConfirmQueue<R> {
  const [next, ...rest] = q.waiting;
  if (q.current || next === undefined) return q;
  return { current: { req: next, phase: "shown" }, waiting: rest };
}

const holdingNow = <R extends ConfirmQueueRequest>(q: ConfirmQueue<R>) => q.current !== null && q.current.phase !== "shown";

/** 新しい確認。持ち続ける間は後に回す。shown の確認は今までどおりキャンセル扱いで差し替える */
export function enqueue<R extends ConfirmQueueRequest>(q: ConfirmQueue<R>, req: R): Change<R> {
  if (holdingNow(q)) return { queue: { ...q, waiting: [...q.waiting, req] }, cancelled: [] };
  return { queue: { current: { req, phase: "shown" }, waiting: q.waiting }, cancelled: q.current ? [q.current.req] : [] };
}

/**
 * 確定が押された。askHold(hold)は閉じずに holding へ(failed からの再試行も)。ふつうの確認は閉じて次を出す。
 * holding の間(中は inert で押せない)と表示中が無いときは ignored
 */
export function confirmCurrent<R extends ConfirmQueueRequest>(q: ConfirmQueue<R>): { queue: ConfirmQueue<R>; held: boolean; ignored: boolean } {
  const cur = q.current;
  if (!cur || cur.phase === "holding") return { queue: q, held: false, ignored: true };
  if (cur.req.hold) return { queue: { ...q, current: { req: cur.req, phase: "holding" } }, held: true, ignored: false };
  return { queue: finishCurrent(q), held: false, ignored: false };
}

/** 取り消し(キャンセルのボタン・Esc・背面のクリック)。holding の間は書き込みが走っているので無視する */
export function cancelCurrent<R extends ConfirmQueueRequest>(q: ConfirmQueue<R>): Change<R> {
  if (!q.current || q.current.phase === "holding") return { queue: q, cancelled: [] };
  return { queue: finishCurrent(q), cancelled: [q.current.req] };
}

/** 呼び出し元の書き込みが失敗した(hold.fail)。holding のときだけ failed へ */
export function failHold<R extends ConfirmQueueRequest>(q: ConfirmQueue<R>): ConfirmQueue<R> {
  if (q.current?.phase !== "holding") return q;
  return { ...q, current: { req: q.current.req, phase: "failed" } };
}

/** 表示中を閉じて、待たせている先頭を出す(確定で終わった確認・hold.close) */
export function finishCurrent<R extends ConfirmQueueRequest>(q: ConfirmQueue<R>): ConfirmQueue<R> {
  return promote({ current: null, waiting: q.waiting });
}

/** 持ち主の範囲が消えた: その持ち主の表示中の確認(phase を問わない)と待たせている要求を外す。ほかの持ち主の要求は残す。何度呼んでもよい */
export function releaseOwner<R extends ConfirmQueueRequest>(q: ConfirmQueue<R>, owner: string): Change<R> {
  const cancelled: R[] = [];
  const current = q.current && q.current.req.owner === owner ? (cancelled.push(q.current.req), null) : q.current;
  const waiting = q.waiting.filter((r) => (r.owner === owner ? (cancelled.push(r), false) : true));
  if (cancelled.length === 0) return { queue: q, cancelled };
  return { queue: promote({ current, waiting }), cancelled };
}

/** ページを移動した: 表示中も待たせているものもすべて外す(移動前の画面の操作を新しい画面の上で開かない) */
export function releaseAll<R extends ConfirmQueueRequest>(q: ConfirmQueue<R>): Change<R> {
  return { queue: emptyQueue<R>(), cancelled: [...(q.current ? [q.current.req] : []), ...q.waiting] };
}

/**
 * 持ち主の範囲が消えたことの知らせ。BusyScope が unmount で releaseConfirmOwner(id) を呼び、ConfirmProvider が購読する。
 * BusyScope → ConfirmProvider の import を作らないため(ConfirmProvider は BusyScope の useBusyScopeId を使う)、ここに置く。
 * 購読はブラウザの ConfirmProvider(root layout)だけで、unmount はブラウザでしか起きない
 */
const ownerListeners = new Set<(owner: string) => void>();

export function onConfirmOwnerReleased(listener: (owner: string) => void): () => void {
  ownerListeners.add(listener);
  return () => {
    ownerListeners.delete(listener);
  };
}

export function releaseConfirmOwner(owner: string): void {
  for (const l of ownerListeners) l(owner);
}
