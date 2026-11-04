/**
 * 確認のモーダル(components/ui/ConfirmDialog.tsx)の close イベントの判定(B173 第 1 段 最終レビュー FR-Medium-3)。
 *
 * close イベントは close() の後のタスクで届く。閉じた直後に次の確認を開くと(「とどまる」の直後の戻るなど)、前の close() のイベントが
 * 次の確認の open=true の後に届く。届くのが effect の showModal() の前だと、要素はまだ閉じているので、DOM の今の open だけでは
 * 「ブラウザが勝手に閉じた」と見分けられず、次の確認を取り消してしまう。そこで自分で呼んだ close() の数(selfClosePending)を数え、
 * その数だけのイベントは自分のものとして消費して無視する。close() は開いている要素にだけ呼ぶので、1 回の close() にイベントは 1 つ
 *
 * open = React の側の確認が開いているか / elementOpen = <dialog> 要素の今の open / selfClosePending = まだイベントが届いていない自分の close() の数 /
 * holding = 書き込みを待つ覆いの間か(B173 第 2 段 Task 2。レビューの H2)。HTML の close watcher の決まりで、cancel の preventDefault は
 * 利用者の操作が残っているときしか効かず、続けて押した 2 回目の Esc では要素が閉じうる(Chrome)。覆いの間に閉じられたら、
 * 取り消さずに開き直す(reopen)。書き込みの結果は呼び出し元が hold.close() / hold.fail() で返すまで待つ
 */
export function dialogCloseEvent(input: { open: boolean; elementOpen: boolean; selfClosePending: number; holding?: boolean }): {
  cancel: boolean;
  reopen: boolean;
  selfClosePending: number;
} {
  const { open, elementOpen, selfClosePending, holding = false } = input;
  if (selfClosePending > 0) return { cancel: false, reopen: false, selfClosePending: selfClosePending - 1 };
  // 自分の close() ではない: cancel を経ずにブラウザ側で閉じられた(実装の差など)ときだけ、React の状態もキャンセルとしてそろえる。
  // 覆いの間は取り消さずに開き直す
  const closedByBrowser = open && !elementOpen;
  if (closedByBrowser && holding) return { cancel: false, reopen: true, selfClosePending: 0 };
  return { cancel: closedByBrowser, reopen: false, selfClosePending: 0 };
}
