"use client";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

/** コピーした後の表示(「コピーしました」・チェックの印)を出しておく時間 */
export const COPIED_MS = 2000;

/** 戻すタイマーの置き場所(コンポーネントでは useRef。押すたびとアンマウントで前のタイマーを消すため) */
export type CopiedTimer = { current: ReturnType<typeof setTimeout> | null };

/**
 * 押したときの処理。書き込めたらコピーした状態にして COPIED_MS 後に戻し、書き込めなければ呼ぶ側の扱いに任せる。
 * 前のタイマーは書き込めた後に消す(続けて押したとき、1 回目のタイマーで 2 回目のチェックの印が早く消えないように。
 * 書き込めなかったときは前の表示をそのまま戻させる)
 */
export async function copyText(text: string, setCopied: (copied: boolean) => void, timer: CopiedTimer, onUnavailable?: () => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    onUnavailable?.();
    return;
  }
  setCopied(true);
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = setTimeout(() => {
    timer.current = null;
    setCopied(false);
  }, COPIED_MS);
}

/** アイコンだけのときは、見える文字の代わりにアイコンで結果を知らせる(コピーした間だけチェックの印)。文字付きは文字が変わるのでアイコンは替えない */
export function copyIconName(iconOnly: boolean, copied: boolean): IconName {
  return iconOnly && copied ? "check" : "copy";
}

/**
 * コピーのボタン + コピーしたことの読み上げ(CodeBlock から切り出した部品。パンくずのサイト ID でも使う)。
 * clipboard が使えないときの扱いは呼ぶ側が onUnavailable で決める(CodeBlock はコードを選択状態にする)。
 * iconOnly は見える文字を出さずアイコンだけにする(上部バーのように幅の余裕が無い所。名前と status は同じ)。
 * コピーした間はアイコンをチェックの印に替え、ボタンに data-copied を付ける(呼ぶ側が CSS で成功の色にする)
 */
// label は「〜をコピー」の形(読み上げの名前に見える文字「コピー」を含め、コピーした後は「〜をコピーしました」にするため)
export function CopyButton({ text, label, className = "btn", testId, iconOnly = false, onUnavailable }: { text: string; label: `${string}コピー`; className?: string; testId?: string; iconOnly?: boolean; onUnavailable?: () => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // アンマウントのときは戻すタイマーを消す
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const name = copied ? `${label}しました` : label;
  return (
    <>
      {/* 読み上げの名前は見える文字を含める(label は「リンクをコピー」などで、見える「コピー」を含む)。コピーした後も名前と表示をそろえる。
          アイコンだけのときは、マウスを重ねて何のボタンか分かるよう名前を title にも出す */}
      <button type="button" className={className} aria-label={name} title={iconOnly ? name : undefined} data-testid={testId} data-copied={iconOnly && copied ? "true" : undefined} onClick={() => void copyText(text, setCopied, timer, onUnavailable)}>
        <Icon name={copyIconName(iconOnly, copied)} size={iconOnly ? 13 : 16} />
        {iconOnly ? null : copied ? "コピーしました" : "コピー"}
      </button>
      {/* コピーしたことは、ボタンの名前が変わるだけでは読み上げられないので、status で知らせる */}
      <span role="status" className="visually-hidden">
        {copied ? "コピーしました" : ""}
      </span>
    </>
  );
}
