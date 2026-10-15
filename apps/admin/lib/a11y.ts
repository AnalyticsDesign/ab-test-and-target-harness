/**
 * アクセシビリティ設定「ドラッグの代わりにボタンで操作する」(決定 49、設計書 §12。既定オフ)。テーマと同じくブラウザの localStorage にだけ持つ。
 * オンのときだけ、オーディエンスの作成画面とエクスペリエンスの配信条件に「ここに追加」・↑↓・「移動先」が出る(WCAG 2.2 の 2.5.7)
 */
import { useSyncExternalStore } from "react";

export const DRAG_ALT_KEY = "wtt-drag-alternatives";
const EVENT = "wtt-drag-alternatives";
let memory: boolean | null = null; // localStorage が使えない環境では、この画面の中だけ効く

export const parseDragAlternatives = (v: string | null): boolean => v === "1";

function read(): boolean {
  try {
    return parseDragAlternatives(localStorage.getItem(DRAG_ALT_KEY));
  } catch {
    return memory ?? false;
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === DRAG_ALT_KEY) onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setDragAlternatives(on: boolean): void {
  memory = on;
  try {
    localStorage.setItem(DRAG_ALT_KEY, on ? "1" : "0");
  } catch {
    /* 保存できなくてもこの画面では効く(memory) */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** サーバーの描画と初回の hydration ではオフ(既定)。マウント後に保存値へ切り替わる */
export function useDragAlternatives(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
