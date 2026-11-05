/**
 * 画面の中の表示切替(タブ・設定の節・一覧の絞り込み)を URL に写すためのヘルパ(設計書 4.4 / 4.6 / 4.8)。
 * 書くのは history.replaceState だけ: Next のルーターを通さないので、ページの再読み込みもサーバーへの再取得も起きない
 */
/** ページの searchParams の値(文字列・配列・無し)から、許した値だけを取る。配列は先頭を見る(クエリ文字列を組み立てて読み直さない) */
export function pickParam<T extends string>(value: string | string[] | undefined, allowed: readonly T[], fallback: T): T {
  const v = Array.isArray(value) ? value[0] : value;
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
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

/**
 * replaceParam が URL を書き換えた直後に window へ出すイベントの名前(B60)。
 * vinext(1.0.0-beta.10)は、ルーターが持つ history.state のまま replaceState すると購読者(usePathname / useSearchParams)に知らせない。
 * そのため、URL の search を覚えておきたい側(設定を開いた場所の記憶 = components/ui/SettingsOrigin.tsx)は、このイベントで location を読み直す。
 * ルーターの内部の挙動に頼らないために、書く側で知らせる
 */
export const URL_PARAM_EVENT = "wtt:urlparam";

/** ブラウザ専用。サーバーで呼ばれても何もしない */
export function replaceParam(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  const next = withParam(`${window.location.pathname}${window.location.search}${window.location.hash}`, key, value);
  window.history.replaceState(window.history.state, "", next);
  window.dispatchEvent(new Event(URL_PARAM_EVENT));
}

/**
 * B129: search 全体を置き換える(複数の値を 1 回で書く絞り込み = 設定の「操作の記録」)。search は `?…` か空。
 * replaceParam と同じく history.replaceState だけで、ルーターを通さない(再読み込みもサーバーへの再取得も起きない)。ブラウザ専用
 */
export function replaceSearch(search: string): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
  window.dispatchEvent(new Event(URL_PARAM_EVENT));
}
