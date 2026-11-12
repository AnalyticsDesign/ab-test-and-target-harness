"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { HelpKey } from "@/generated/help.ja";
import { HelpPanel } from "./HelpPanel";

/**
 * 説明(ヘルプ)の右のパネルを 1 つだけ置き、どの画面の <HelpTip> からも開けるようにする(D9 plan ③ K22・設計書 §11.1)。
 * パネルの開閉と、閉じたときのフォーカスの戻り先(パネルを開いた「?」のボタン)をここで持つ。/w layout に置く
 */
type HelpContextValue = {
  /** 開いているパネルで強調する項目(閉じていれば null) */
  panelKey: HelpKey | null;
  /** パネルを開き、その項目まで送って強調する。returnTo = 閉じたときにフォーカスを戻す要素 */
  openPanel: (key: HelpKey, returnTo?: HTMLElement | null) => void;
  closePanel: () => void;
};

const HelpContext = createContext<HelpContextValue | null>(null);

export function HelpProvider({ children, releaseVersion }: { children: ReactNode; releaseVersion: string }) {
  const [panelKey, setPanelKey] = useState<HelpKey | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const focusBack = useRef(false);

  const openPanel = useCallback((key: HelpKey, el?: HTMLElement | null) => {
    returnTo.current = el ?? null;
    setPanelKey(key);
  }, []);
  const closePanel = useCallback(() => {
    focusBack.current = true;
    setPanelKey(null);
  }, []);

  // 閉じた後(パネルが消えた後)にフォーカスを戻す。戻り先が画面から消えていれば何もしない
  useEffect(() => {
    if (panelKey !== null || !focusBack.current) return;
    focusBack.current = false;
    const el = returnTo.current;
    returnTo.current = null;
    if (el?.isConnected) el.focus();
  }, [panelKey]);

  // ページを移動したら閉じる(Provider は /w layout にあり移動で消えないため。戻り先のボタンも前のページのもの)
  const pathname = usePathname();
  useEffect(() => {
    returnTo.current = null;
    setPanelKey(null);
  }, [pathname]);

  const value = useMemo(() => ({ panelKey, openPanel, closePanel }), [panelKey, openPanel, closePanel]);
  return (
    <HelpContext.Provider value={value}>
      {children}
      <HelpPanel releaseVersion={releaseVersion} />
    </HelpContext.Provider>
  );
}

export function useHelp(): HelpContextValue {
  const v = useContext(HelpContext);
  if (!v) throw new Error("HelpTip / HelpPanel は HelpProvider の中で使う(app/w/layout.tsx)");
  return v;
}
