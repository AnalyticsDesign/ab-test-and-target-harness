"use client";
import Link from "next/link";
import { useDragAlternatives } from "@/lib/a11y";

/**
 * ドラッグを使う画面の条件の下に置く 1 行の案内(決定 54 (7))。設定がオフのときだけ出す。
 * 切り替えはこの画面に置かず「設定 > 画面表示」へ導く(WCAG 2.5.7 の代わりの手段へ、困っている画面から辿れるように)
 */
export function DragAltHint() {
  const on = useDragAlternatives();
  if (on) return null;
  return (
    <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
      ドラッグ操作が難しい場合は、<Link href="/w/me/display">設定 &gt; 画面表示</Link> でボタン操作に切り替えられます
    </p>
  );
}
