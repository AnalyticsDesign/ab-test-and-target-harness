/**
 * AppLink(components/ui/AppLink.tsx)の先読みの呼び出しを、イベントの処理の外へ例外を出さない形で包む(管理画面の速さ D)。
 * どちらも失敗したら「先読みしないだけ」にする。遷移はもともと止まらないが、イベントの処理から throw するとエラーとして記録に出るため。
 * console にも出さない(先読みは本番の build だけで走り、失敗しても利用者にできることは無い)
 */

/** router.prefetch() を呼ぶ。URL にできない href などで throw しても外に出さない(vinext の navigation.js の prefetch は同期で throw する) */
export function prefetchQuietly(router: { prefetch: (href: string) => unknown }, href: string): void {
  try {
    const pending = router.prefetch(href);
    // 今の vinext は何も返さないが、Promise を返す形に変わっても拒否を外に漏らさない
    if (pending instanceof Promise) pending.catch(() => {});
  } catch {
    // 先読みしないだけ
  }
}

/** キーボードで移ったフォーカス(:focus-visible)か。:focus-visible を知らない古いブラウザでは matches が SyntaxError を投げるので、false(先読みしない) */
export function isFocusVisible(el: { matches: (selector: string) => boolean }): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * 修飾キーなしの左クリックで、同じタブで開くリンクか(新しいタブ・ダウンロードではない)。遷移を後に回してよいのはこのクリックだけ
 * (管理画面のフィードバックの spec §4.1 と同じ名前。lib/refresh-wait.ts)
 */
export function isPlainLeftClick(e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  currentTarget: { getAttribute: (name: string) => string | null; hasAttribute: (name: string) => boolean };
}): boolean {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const target = e.currentTarget.getAttribute("target");
  if (target && target !== "_self") return false;
  return !e.currentTarget.hasAttribute("download");
}
