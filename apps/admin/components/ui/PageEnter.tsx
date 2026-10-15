"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * 画面遷移のときだけ本文を「入ってくる」動きで描く。
 * pathname を key にするので、URL が変わる遷移(サイドバー・一覧のリンク・作成後の全画面遷移)で再マウントされ
 * globals.css の `.enter` が再生される。同じ URL での `router.refresh()`(保存後の再取得)では key が変わらず動かない。
 * `template.tsx` を使わないのは、配下の layout(サイドバーや上部バー)ごと再マウントされてしまうため
 */
export function PageEnter({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="enter">
      {children}
    </div>
  );
}
