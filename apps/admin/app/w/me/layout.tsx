import type { ReactNode } from "react";
import { requireUser } from "@/lib/control";
import { AppShell } from "@/components/ui/AppShell";
import { Sidebar } from "@/components/ui/Sidebar";

/**
 * 設定(個人 = API キー・画面表示、システム = システム管理者・ワークスペース)。直前のワークスペースを URL で持てないので、ワークスペース / サイトの文脈は出さない(設計書 4.1)。
 * URL の文脈が設定(`/w/me/*`)のとき Sidebar は workspaces を読まない(切替を描かない)ので、ここで summary を取得しない。
 * パンくずと本文の枠(TopBar / Content)は各ページが描く(B36: 末尾の画面名がページごとに違うため)
 */
export default async function MeLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return <AppShell sidebar={<Sidebar user={user} workspaces={[]} />}>{children}</AppShell>;
}
