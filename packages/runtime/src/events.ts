/**
 * spec §9.2: /event は fire-and-forget。keepalive でページ遷移をまたぐ CLICK の取りこぼしを減らす。
 * 戻り値は settle(成功・失敗のいずれでも resolve)— 撤回時に in-flight の goal event を待ち、forget を再 grant が待てるようにする。
 * 中断はしない(abort は送信済みリクエストのサーバー処理を止められない。r2 CX-High-2)
 */
export function sendEvent(fetchFn: typeof fetch, url: string, body: Record<string, unknown>): Promise<void> {
  return fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).then(() => undefined, () => undefined);
}
