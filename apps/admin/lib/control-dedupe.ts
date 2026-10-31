import { cacheForRequest } from "vinext/cache";
import { getRequestContext, isInsideUnifiedScope } from "vinext/shims/unified-request-context";

/**
 * 1 回の画面の描画の中で、同じ control への GET を 1 回にまとめる(admin speed C)。
 * vinext は globalThis.fetch を差し替えて同じ GET をまとめるが、service binding の `binding.fetch` はその外を通るので
 * (commit 6e87a50b で binding に替えてから)、画面ごとの control への呼び出しが倍以上に増えた。その代わりをここで持つ。
 * - 覚えは vinext の要求ごとの置き場(`cacheForRequest` = 要求の文脈の requestCache)に置く。isolate の global には置かない
 *   (同じ isolate が別の利用者の要求を並行して処理する)。試しの実行(probe)と本描画は同じ要求の文脈の子なので、両方をまたいで 1 回になる
 * - まとめるのは、vinext が自分の fetch をまとめている範囲(ページの描画中 = isFetchDedupeActive)だけ。
 *   Route Handler と要求の範囲の外は素通し(Route Handler の要求の文脈では isFetchDedupeActive が立たない)
 * - 鍵は宛先の URL(query 込み)と、送るヘッダーすべて(authorization のセッション token・名乗る版・接続元 IP を含む)。
 *   利用者・ワークスペースが違えば鍵が違う
 * - 覚えるのは最初の応答を読み切った写し(状態・ヘッダー・本文のバイト列)で、呼び出し元には毎回そこから新しい Response を作って返す
 *   (本文は 1 回しか読めない。解析した値も呼び出し元ごとに別のもの)。clone で返すと、覚えた側の読まれない枝が要求の終わりまで残る
 *   (workerd が未読の本文として警告しうる)ので、本文は最初の 1 回で読み切る。control の応答は JSON なので読み切っても重くない。
 *   作り直した Response は url・redirected を持たないが、描画中の GET でそれを読む呼び出し元は無い
 *   (本文をそのまま流すのは app/api/control の Route Handler だけで、そこはまとめない)
 * - 届かなかった null や 5xx も、その要求の中では使い回す(要求をまたいでは残らない)。本文を読む途中で壊れたときも null(届かなかった)
 * - GET 以外(書き込み)はまとめず、送る前と後にその要求の覚えを捨てる(書き込みの後の読み直しが古い値を返さない)
 */

type Sent = Promise<Response | null>;
/** 読み切った応答の写し。呼び出し元ごとにここから Response を作る */
type Snapshot = { status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer | null };

/** その要求の覚え。要求の範囲の外では呼ぶたびに新しい Map が返る(= 何も覚えない) */
const memoOfRequest = cacheForRequest(() => new Map<string, Promise<Snapshot | null>>());

/** 本文を持てない状態(new Response に本文を渡すと throw する) */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** 応答を読み切って写しにする。本文を読む途中で壊れたら null(届かなかったのと同じ) */
async function snapshotOf(res: Response | null): Promise<Snapshot | null> {
  if (!res) return null;
  try {
    const body = res.body === null || NULL_BODY_STATUSES.has(res.status) ? null : await res.arrayBuffer();
    return { status: res.status, statusText: res.statusText, headers: [...res.headers], body };
  } catch {
    return null;
  }
}

/** 写しから呼び出し元用の Response を作る(new Response は渡したバイト列を写して持つので、呼び出し元どうしで本文を共有しない) */
const responseOf = (s: Snapshot): Response => new Response(s.body, { status: s.status, statusText: s.statusText, headers: s.headers });

/** まとめてよい init のキー(これ以外 = body・signal・redirect などが付いた要求は素通し) */
const DEDUPABLE_KEYS = new Set(["method", "headers", "cache"]);

/** 送るヘッダーをすべて含めた鍵。Headers の列挙は名前が小文字・並びが整列済み */
const keyOf = (url: string, headers: HeadersInit | undefined): string => JSON.stringify([url, [...new Headers(headers)]]);

/** ページの描画中なら、その要求の覚え。Route Handler・要求の範囲の外は null(まとめない) */
function renderMemo(): Map<string, Promise<Snapshot | null>> | null {
  if (!isInsideUnifiedScope() || !getRequestContext().isFetchDedupeActive) return null;
  return memoOfRequest();
}

/** その要求の覚えを捨てる(書き込みの前後)。範囲の外では何もしない */
function forgetRequest(): void {
  if (isInsideUnifiedScope()) memoOfRequest().clear();
}

/**
 * `send` で control に送る。ページの描画中の同じ GET は 1 回だけ送り、呼び出し元ごとに最初の応答の写しから作った Response を返す。
 * `send` は throw せず、届かなければ null を返すこと(controlRequest の約束)
 */
export async function sendOncePerRender(url: string, init: RequestInit, send: () => Sent): Sent {
  // メソッドの名前は大小文字を問わない(fetch と同じ)
  const method = (init.method ?? "GET").toLowerCase();
  if (method !== "get") {
    forgetRequest();
    try {
      return await send();
    } finally {
      // 書き込みの最中に始まった GET の覚えも、書き込みの前の値でありうるので捨てる
      forgetRequest();
    }
  }
  const memo = renderMemo();
  if (!memo || Object.keys(init).some((k) => !DEDUPABLE_KEYS.has(k))) return send();
  const key = keyOf(url, init.headers);
  let sent = memo.get(key);
  if (!sent) {
    sent = send().then(snapshotOf);
    memo.set(key, sent);
  }
  const snapshot = await sent;
  return snapshot ? responseOf(snapshot) : null;
}
