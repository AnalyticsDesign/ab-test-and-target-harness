/**
 * 管理画面の操作のフィードバック(B173 第 1 段)の store。遷移が進行中か・どのリンクが押されたか・保存が未保存か/処理中かを、1 か所で持つ。
 * React・ルーターに依らない(単体テストと、どの部品からも同じ状態を読めるように)。React からは `lib/use-feedback.ts` の hook で、基本の値だけを選んで読む。
 *
 * 遷移の「始まり」は押した瞬間(startNavigation)、「終わり」は移った先の画面が描かれて印(reportMark)を出したとき。
 * - 150 ms 以内に終わる遷移は利用者に見せない(visible にならない)。ちらつきを避けるため
 * - 10 秒で打ち切る(timedOut)。遷移は消さず、次の印・次の遷移まで残す。操作が止まったように見えたままにしないため
 * - 読み直し(router.refresh)の反映を待って後に回した遷移(deferred)の打ち切りの時計は、実際に移り始めた時点(markNavigationDispatched)から数える。
 *   待っている間に押した遷移が、移り始める前に打ち切られないように
 */

/** この時間より早く終わる遷移は見せない */
export const NAV_DELAY_MS = 150;
/** 遷移の打ち切り */
export const NAV_TIMEOUT_MS = 10_000;
/** 処理中の表示を出したら、最低この時間は出し続ける(一瞬で消えるちらつきを避ける) */
export const BUSY_MIN_MS = 300;
/** 書き込みの打ち切り */
export const WRITE_TIMEOUT_MS = 30_000;

/** 画面が出す印の種類。page = ふつうの画面、error = エラーの画面、notFound = 見つからない画面 */
export type MarkKind = "page" | "error" | "notFound";

export type NavState = {
  /** 始めた順の通し番号 */
  seq: number;
  /** 行き先(normalizeUrl の形) */
  href: string;
  /** 押した時点の画面(normalizeUrl の形)。この URL の印は「まだ移っていない」ので遷移を終えない */
  fromUrl: string;
  /** 押したリンクの鍵(リンクごとの「待ち」の表示用)。リンク以外の遷移は null */
  key: string | null;
  /** 150 ms を過ぎて利用者に見せる状態か */
  visible: boolean;
  /** 10 秒で打ち切ったか。nav は消えずに残る */
  timedOut: boolean;
  /** 実際に移り始めたか(読み直しを待って後に回した遷移は、回している間は false) */
  dispatched: boolean;
};

export type FeedbackSnapshot = {
  nav: NavState | null;
  /** どこかの節に未保存の変更がある */
  dirty: boolean;
  /** どこかの節が保存などの処理中 */
  busy: boolean;
};

/** サーバー描画・ハイドレーションで使う、何も起きていない状態 */
export const SERVER_SNAPSHOT: FeedbackSnapshot = { nav: null, dirty: false, busy: false };

// ---- モジュールの状態 ----

let snapshot: FeedbackSnapshot = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();

/** nextSeq と startNavigation が共有する通し番号 */
let seqCounter = 0;
/** 最後に始めた遷移の番号(終わった後も残す。navStartedAfter 用) */
let lastStartedSeq = 0;
let nav: NavState | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
/** 今の遷移までに替えられた遷移の行き先すべて。その遅れて届く印(替えた古い遷移の印)は無視する。遷移が終わったら空にする */
const replacedHrefs = new Set<string>();
let lastMark: string | null = null;
let writeSucceeded = false;
const guards = new Map<string, { dirty: boolean; busy: boolean }>();

// ---- snapshot ----

/** nav・guard から snapshot を作り直し、中身が変わったときだけ新しい参照にして購読者に知らせる */
function publish(): void {
  let dirty = false;
  let busy = false;
  for (const g of guards.values()) {
    dirty ||= g.dirty;
    busy ||= g.busy;
  }
  if (nav === snapshot.nav && dirty === snapshot.dirty && busy === snapshot.busy) return;
  snapshot = { nav, dirty, busy };
  for (const fn of [...listeners]) fn();
}

export function getSnapshot(): FeedbackSnapshot {
  return snapshot;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---- URL ----

/** 比べるための URL の形: pathname + 鍵で並べ替えた検索。hash は除く(同じ画面の別の位置なので) */
export function normalizeUrl(href: string, base?: string): string {
  const origin = base ?? (typeof window !== "undefined" ? window.location.href : "http://localhost");
  try {
    const url = new URL(href, origin);
    // 鍵で並べ替える。同じ鍵の値の順は変えない(sort は安定)
    const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const search = new URLSearchParams(params).toString();
    return search ? `${url.pathname}?${search}` : url.pathname;
  } catch {
    // 解釈できない文字列は、そのまま比べる(印の側も同じ関数を通るので、同じ文字列なら一致する)
    return href;
  }
}

/**
 * URL が指すワークスペースとサイト。`/w/:wid/sites/:sid/…` → 両方、`/w/:wid/…` → wid だけ、`/w/me/…` と `/w` → 両方 null(me は個人の画面で、範囲を持たない)。
 * lib/navigate.ts から再公開する。selectScopeSkeleton が使うので、循環 import を避けて(navigate.ts は store を読む)ここに置く
 */
export function targetScope(href: string): { wid: string | null; sid: string | null } {
  // 検索・hash を除いた pathname だけを見る
  const segments = (href.split(/[?#]/, 1)[0] ?? "").split("/").filter(Boolean);
  if (segments[0] !== "w" || !segments[1] || segments[1] === "me") return { wid: null, sid: null };
  const sid = segments[2] === "sites" && segments[3] ? segments[3] : null;
  return { wid: segments[1], sid };
}

// ---- 遷移 ----

function stopTimers(): void {
  if (showTimer) clearTimeout(showTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  showTimer = null;
  timeoutTimer = null;
}

/** 打ち切りの時計を始める(今の遷移 seq のもの) */
function startTimeoutClock(seq: number): void {
  timeoutTimer = setTimeout(() => {
    timeoutTimer = null;
    if (nav?.seq !== seq) return;
    nav = { ...nav, timedOut: true };
    publish();
  }, NAV_TIMEOUT_MS);
}

/** 今の遷移を終える。書き込み成功の印も、遷移が終われば用済み */
function endNavigation(): void {
  stopTimers();
  nav = null;
  replacedHrefs.clear();
  writeSucceeded = false;
  publish();
}

/** 通し番号を 1 つ進めて返す。「この後に遷移が始まったか」(navStartedAfter)の基準を取るのに使う */
export function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

/** 遷移を始める。通し番号を返す。前の遷移があれば替える */
export function startNavigation(input: { href: string; fromUrl: string; key: string | null; deferred?: boolean }): number {
  const seq = nextSeq();
  stopTimers();
  if (nav) replacedHrefs.add(nav.href);
  lastStartedSeq = seq;
  const dispatched = !input.deferred;
  nav = { seq, href: input.href, fromUrl: input.fromUrl, key: input.key, visible: false, timedOut: false, dispatched };
  showTimer = setTimeout(() => {
    showTimer = null;
    if (nav?.seq !== seq) return;
    nav = { ...nav, visible: true };
    publish();
  }, NAV_DELAY_MS);
  if (dispatched) startTimeoutClock(seq);
  publish();
  return seq;
}

/**
 * 今の遷移があれば、印を待たずに終える(タイマーを止め、替えた行き先も忘れ、購読者に知らせる)。無ければ何もしない。
 * 表示を始めない遷移(今の URL・最後の印と同じ URL への移動)が、表示を始めた前の遷移を置き換えるときに呼ぶ。
 * 置き換えた遷移の行き先は印が来ない(または来ても今の遷移を終えられない)ので、残すと 10 秒の打ち切りで「開けませんでした」が誤って出る
 */
export function cancelNavigation(): void {
  if (!nav) return;
  endNavigation();
}

/** 後に回した遷移が実際に移り始めたことを知らせる。その番号が今の遷移のときだけ、打ち切りの時計を始める */
export function markNavigationDispatched(seq: number): void {
  if (nav?.seq !== seq || nav.dispatched) return;
  nav = { ...nav, dispatched: true };
  startTimeoutClock(seq);
  publish();
}

/**
 * 画面が描かれたことを知らせる印。今の遷移があれば、次のどれかで遷移を終える:
 * - 行き先の URL の印
 * - エラー・見つからないの画面(行き先が描けなかった)
 * - 押した画面・行き先・替えた行き先のどれとも違う URL(リダイレクトで別の画面に着いた)
 * 押した画面の URL の印は、まだ移っていない(または元の画面に戻った。その場合は打ち切りで終える)ので終えない。
 * 替えた古い遷移の行き先の印は、遅れて届いたものなので無視する。印の URL は、遷移が無くても覚える
 */
export function reportMark(mark: { url: string; kind: MarkKind }): void {
  lastMark = mark.url;
  if (!nav) return;
  const { url, kind } = mark;
  if (url === nav.href) return endNavigation();
  if (replacedHrefs.has(url)) return;
  if (kind === "error" || kind === "notFound") return endNavigation();
  if (url !== nav.fromUrl) return endNavigation();
}

/** 最後に届いた印の URL。無ければ null */
export function lastMarkUrl(): string | null {
  return lastMark;
}

/** seq(nextSeq で取った番号)より後に、遷移が始まったか */
export function navStartedAfter(seq: number): boolean {
  return lastStartedSeq > seq;
}

// ---- 書き込みの成功 ----

/** 書き込みが成功したことを覚える。読み直しが終わるか次の遷移が終わるまでの間だけ true(app/error.tsx が「保存はできた」と出すため) */
export function noteWriteSucceeded(): void {
  writeSucceeded = true;
}

export function clearWriteSucceeded(): void {
  writeSucceeded = false;
}

export function writeSucceededRecently(): boolean {
  return writeSucceeded;
}

// ---- 節の状態 ----

/** 節ごとの未保存・処理中を登録する(null で外す)。snapshot にはどこかが true なら true で出す */
export function setGuard(scopeId: string, state: { dirty: boolean; busy: boolean } | null): void {
  if (state) guards.set(scopeId, { dirty: state.dirty, busy: state.busy });
  else guards.delete(scopeId);
  publish();
}

// ---- 選ぶ関数(useFeedbackSelector に渡す。基本の値を返すので、関わりの無い更新では描き直さない) ----

/**
 * 押されたリンクが key のもので、利用者に見せる状態か。打ち切った(timedOut)後は false: 本文が打ち切りの案内に替わった後も
 * 回る印が残ると、まだ待てば開くように見えるため(最終レビュー FR-Medium-4・台帳の Ruling 7)
 */
export function selectLinkPending(key: string): (s: FeedbackSnapshot) => boolean {
  return (s) => s.nav?.key === key && s.nav.visible && !s.nav.timedOut;
}

/**
 * 利用者に見せる状態の遷移で、行き先の範囲(ワークスペース・サイト)が scope と違うか。上部バー・サイトの枠を骨組みにするかの判定。
 * 打ち切った(timedOut)後は false: 骨組みのままだとパンくず・公開のリンクを押せず、操作を返せないため(Ruling 7)。
 * 前のサイトの名前を出さない守り(今の URL と描いた値が違えば帯)は、SiteChromeGuard が useParams() で別に見る
 */
export function selectScopeSkeleton(scope: { wid: string | null; sid: string | null }): (s: FeedbackSnapshot) => boolean {
  return (s) => {
    if (!s.nav?.visible || s.nav.timedOut) return false;
    const target = targetScope(s.nav.href);
    return target.wid !== scope.wid || target.sid !== scope.sid;
  };
}

// ---- テスト用 ----

export function resetFeedbackStoreForTest(): void {
  stopTimers();
  nav = null;
  seqCounter = 0;
  lastStartedSeq = 0;
  replacedHrefs.clear();
  lastMark = null;
  writeSucceeded = false;
  guards.clear();
  listeners.clear();
  snapshot = SERVER_SNAPSHOT;
}
