import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/control";
import { loadSummary } from "@/lib/loaders";
import { AppShell, Content } from "@/components/ui/AppShell";
import { Sidebar } from "@/components/ui/Sidebar";

/**
 * ワークスペースの文脈を持つ枠。切替の一覧(全ワークスペースのサイト)はここで 1 回だけ取る(決定 54 (9))。
 *
 * summary が取れないときは、例外にせずこの枠の中にエラーを描く(子の layout / page は描かない)。
 * vinext ではこの layout の例外を app/error.tsx が受けず、素の 500(英語の文面)になったため(B35 Task 4 で実測)。
 * ページの例外(ホーム・設定)は app/error.tsx が受けるので、そちらは requireSummary の例外のままでよい
 */
export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ wid: string }> }) {
  const user = await requireUser();
  const { wid } = await params;
  const summary = await loadSummary();
  if (summary.status !== 200) {
    return (
      <AppShell sidebar={<Sidebar user={user} workspaces={[]} />}>
        <Content>
          <p className="error-box">ワークスペースの一覧を取得できませんでした(HTTP {summary.status})。時間をおいて開き直してください</p>
        </Content>
      </AppShell>
    );
  }
  if (!summary.data.some((w) => w.id === wid)) notFound();
  return <AppShell sidebar={<Sidebar user={user} workspaces={summary.data} />}>{children}</AppShell>;
}
