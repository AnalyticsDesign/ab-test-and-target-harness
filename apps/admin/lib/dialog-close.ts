/**
 * 確認のモーダル(components/ui/ConfirmDialog.tsx)の close イベントの判定(B173 第 1 段 最終レビュー FR-Medium-3)。
 *
 * close イベントは close() の後のタスクで届く。閉じた直後に次の確認を開くと(「とどまる」の直後の戻るなど)、前の close() のイベントが
 * 次の確認の open=true の後に届く。届くのが effect の showModal() の前だと、要素はまだ閉じているので、DOM の今の open だけでは
 * 「ブラウザが勝手に閉じた」と見分けられず、次の確認を取り消してしまう。そこで自分で呼んだ close() の数(selfClosePending)を数え、
 * その数だけのイベントは自分のものとして消費して無視する。close() は開いている要素にだけ呼ぶので、1 回の close() にイベントは 1 つ
 *
 * open = React の側の確認が開いているか / elementOpen = <dialog> 要素の今の open / selfClosePending = まだイベントが届いていない自分の close() の数
 */
export function dialogCloseEvent(input: { open: boolean; elementOpen: boolean; selfClosePending: number }): { cancel: boolean; selfClosePending: number } {
  const { open, elementOpen, selfClosePending } = input;
  if (selfClosePending > 0) return { cancel: false, selfClosePending: selfClosePending - 1 };
  // 自分の close() ではない: cancel を経ずにブラウザ側で閉じられた(実装の差など)ときだけ、React の状態もキャンセルとしてそろえる
  return { cancel: open && !elementOpen, selfClosePending: 0 };
}
