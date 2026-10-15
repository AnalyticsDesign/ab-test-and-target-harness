"use client";
import { usePathname } from "next/navigation";
import { screenName } from "@/lib/nav";

/** パンくずの末尾(画面名)。layout は遷移をまたいで残るので、今の画面名はクライアントで pathname から出す */
export function Crumb() {
  const name = screenName(usePathname());
  return name ? <span>{name}</span> : null;
}
