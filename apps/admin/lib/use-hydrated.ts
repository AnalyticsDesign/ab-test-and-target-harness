"use client";
import { useEffect, useState } from "react";

/** 当該フォームのイベント処理が付くまで、SSR と最初の client render では送信を止める。 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
