// apps/admin/lib/leave-guard.ts — 発行したキーを控えずに管理画面の中で移動しようとしたときに止めるかの判断(決定 54 (11)、K11)

export type ClickLike = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean };
export type AnchorLike = { href: string; target: string; hasDownload: boolean };

/**
 * 止めるクリックなら移動先のパス(pathname + search + hash)、止めないなら null。
 * 止めないもの = 修飾キー付き・中ボタン(新しいタブで開く。キーは画面に残る)・target 付き・download・別オリジン・既に処理されたクリック
 */
export function guardedHref(e: ClickLike, a: AnchorLike | null, origin: string): string | null {
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if ((a.target && a.target !== "_self") || a.hasDownload) return null;
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
