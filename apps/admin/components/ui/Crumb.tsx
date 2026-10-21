"use client";
import { usePathname } from "next/navigation";
import { screenName } from "@/lib/nav";

/**
 * パンくずの末尾(画面名)。layout は遷移をまたいで残るので、今の画面名はクライアントで pathname から出す。
 * 前の区切りもここで出す: 画面名が無い画面で区切りだけが末尾に残らないように(B31 ⑧)
 */
export function Crumb({ sepClassName }: { sepClassName?: string }) {
  const name = screenName(usePathname());
  if (!name) return null;
  return (
    <>
      <span className={sepClassName}>/</span>
      <span>{name}</span>
    </>
  );
}
