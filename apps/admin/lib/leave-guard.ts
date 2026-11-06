// apps/admin/lib/leave-guard.ts — 発行したキーを控えずに管理画面の中で移動しようとしたときに止めるかの判断(決定 54 (11)、K11)

export type ClickLike = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean };
/** inPlace = 画面の中で開くリンク(data-in-place。遷移せず、行の onClick が画面を切り替える。B68) */
export type AnchorLike = { href: string; target: string; hasDownload: boolean; inPlace?: boolean };

/**
 * 修飾キー無しの左クリックで、まだ誰も処理していない(defaultPrevented でない)ものか。
 * 修飾キー付き・中ボタンは新しいタブ / ウィンドウで開く操作なので、画面の中の移動として扱わない(B60: サイドバーの節のリンクも同じ判定を使う)
 */
export function isPlainLeftClick(e: ClickLike): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * 止めるクリックなら移動先のパス(pathname + search + hash)、止めないなら null。
 * 止めないもの = 修飾キー付き・中ボタン(新しいタブで開く。キーは画面に残る)・target 付き・download・別オリジン・既に処理されたクリック・
 * 画面の中で開くリンク(data-in-place。capture 段で止めると、行の onClick が呼ばれずに移動の確認と router の遷移になるため)
 */
export function guardedHref(e: ClickLike, a: AnchorLike | null, origin: string): string | null {
  if (!a || !isPlainLeftClick(e)) return null;
  if ((a.target && a.target !== "_self") || a.hasDownload || a.inPlace) return null;
  let url: URL;
  try {
    url = new URL(a.href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** 止めるフォームの送信か(ログアウトだけ。ログアウトは全画面の遷移なので、確認の後は beforeunload を二重に出さない) */
export const isLogoutSubmit = (action: string | null): boolean => action === "/api/session/logout";
