"use client";
import { useEffect } from "react";

/**
 * ハイドレーションが終わったら <html data-hydrated="1"> を付ける。E2E 専用の合図(画面の見た目・挙動には使わない)。
 * 再読み込み・直接遷移の直後は SSR の HTML が見えていても React の onClick / onFocus がまだ付いていない。
 * この属性は SSR の HTML には無く、effect でだけ付くので、E2E はこれを待ってから操作する(e2e/fixtures.ts の waitForHydration)
 */
export function HydrationMark() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "1";
  }, []);
  return null;
}
