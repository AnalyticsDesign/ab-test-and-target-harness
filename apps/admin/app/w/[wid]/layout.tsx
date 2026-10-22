import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { loadSummary } from "@/lib/loaders";
import { Content } from "@/components/ui/AppShell";
import { SummarySync } from "@/components/ui/SettingsOrigin";

/**
 * ワークスペースの文脈の確認。外枠(AppShell + Sidebar)は app/w/layout.tsx が描く(B60)。
 * 切替の一覧(全ワークスペースのサイト)は loadSummary(React の cache で外枠の layout と 1 回を共有)から取る(決定 54 (9))。
 *
 * SummarySync を置くのは、外枠の layout がクライアント遷移で描き直されず、そこで読んだ summary が古いまま残りうるため
 * (components/settings/DangerZone.tsx の実測の記録)。`[wid]` が変わる遷移ではこの layout が描き直されるので、ここで provider の summary を新しくする。
 *
 * summary が取れないときは、例外にせず外枠の中にエラーを描く(子の layout / page は描かない)。
 * vinext ではこの layout の例外を app/error.tsx が受けず、素の 500(英語の文面)になったため(B35 Task 4 で実測)。
 * ページの例外(ホーム・設定)は app/error.tsx が受けるので、そちらは requireSummary の例外のままでよい
 */
export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const summary = await loadSummary();
  if (summary.status !== 200) {
    return (
      <Content>
        <p className="error-box">ワークスペースの一覧を取得できませんでした(HTTP {summary.status})。時間をおいて開き直してください</p>
      </Content>
    );
  }
  if (!summary.data.some((w) => w.id === wid)) notFound();
  return (
    <>
      <SummarySync summary={summary.data} />
      {children}
    </>
  );
}
