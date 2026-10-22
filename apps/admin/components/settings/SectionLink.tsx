"use client";
import type { MouseEvent, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { isPlainLeftClick } from "@/lib/leave-guard";
import { setSettingsSection } from "@/lib/settings-section";
import type { SectionId } from "./sections";

/**
 * 同じサイト設定の画面の別の節へ移るふつうの文字のリンク(B60 / B123)。
 * ボタンにしないのは、URL の ?section= が変わる移動なので、新しいタブで開く・リンクをコピーするも効くようにするため。
 * 修飾キー無しの左クリックだけ、ルーターを通さず store と URL(replaceState)を変える(サイドバーの節と同じ作法。再取得でフォームの状態とずれないため)。
 * それ以外はブラウザに任せる。未保存の編集があるときは、フォームの離脱の確認が同じ画面の節への移動を確認なしで通す
 */
export function SectionLink({ to, children }: { to: SectionId; children: ReactNode }) {
  const pathname = usePathname();
  const href = to === "general" ? pathname : `${pathname}?section=${to}`;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(e)) return;
    e.preventDefault();
    setSettingsSection(to);
  };
  return (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  );
}
