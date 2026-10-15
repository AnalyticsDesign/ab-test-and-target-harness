"use client";
import { useEffect } from "react";
import { resyncStoredTheme } from "@/lib/theme";

/**
 * ハイドレーションが終わったら、保存したテーマを <html data-theme> に付け直す(backlog B44 の守り)。
 * ハイドレーションの不一致で root が描き直されると inline script が付けた属性が外れ、選んだテーマが OS の設定に戻るため。
 * effect は描き直しの後に走るので、外れていても戻る
 */
export function ThemeResync() {
  useEffect(() => {
    resyncStoredTheme(() => localStorage, document);
  }, []);
  return null;
}
