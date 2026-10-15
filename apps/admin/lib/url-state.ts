/**
 * 画面の中の表示切替(タブ・設定の節・一覧の絞り込み)を URL に写すためのヘルパ(設計書 4.4 / 4.6 / 4.8)。
 * 書くのは history.replaceState だけ: Next のルーターを通さないので、ページの再読み込みもサーバーへの再取得も起きない
 */
export function readParam<T extends string>(search: string, key: string, allowed: readonly T[], fallback: T): T {
  const v = new URLSearchParams(search).get(key);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function withParam(href: string, key: string, value: string | null): string {
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const rest = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const qAt = rest.indexOf("?");
  const path = qAt >= 0 ? rest.slice(0, qAt) : rest;
  const params = new URLSearchParams(qAt >= 0 ? rest.slice(qAt + 1) : "");
  if (value === null) params.delete(key);
  else params.set(key, value);
  const q = params.toString();
  return `${path}${q ? `?${q}` : ""}${hash}`;
}

/** ブラウザ専用。サーバーで呼ばれても何もしない */
export function replaceParam(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  const next = withParam(`${window.location.pathname}${window.location.search}${window.location.hash}`, key, value);
  window.history.replaceState(window.history.state, "", next);
}
