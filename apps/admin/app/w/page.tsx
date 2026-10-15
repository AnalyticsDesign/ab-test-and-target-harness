import Link from "next/link";
import { requireUser } from "@/lib/control";
import { requireSummary } from "@/lib/loaders";
import { AppShell, Content } from "@/components/ui/AppShell";
import { Sidebar } from "@/components/ui/Sidebar";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { WorkspaceCards } from "@/components/home/WorkspaceCards";
import { UsageSummary } from "@/components/usage/UsageSummary";

/**
 * ホーム(決定 54 (8))。参加しているワークスペースが 1 つでも自動で移らず、ログイン後は必ずここに来る。
 * 中身 = ワークスペースごとのカード。システム管理者には「新しいワークスペース」(設定 > ワークスペースの作成の欄へ)。
 * summary が取れなければ画面全体のエラー(requireSummary が例外にする)。使用状況(D10)の要約はワークスペースの節の下(クライアントで読む)
 */
export default async function HomePage() {
  const user = await requireUser();
  const workspaces = await requireSummary();
  return (
    <AppShell sidebar={<Sidebar user={user} workspaces={[]} />}>
      <TopBar crumbs={[]} />
      <Content>
        <PageHeader title="ホーム" />
        {workspaces.length === 0 ? (
          <div className="card" data-testid="no-workspace">
            <h2>まだどのワークスペースにも参加していません</h2>
            <p>招待を受けた方は、招待メッセージにあるリンクを開いて「参加する」を押してください。ログインしただけでは参加になりません。</p>
            <p className="muted">リンクが見つからない・期限が切れている場合は、招待した管理者に発行し直してもらってください。新しいワークスペースを作れるのはシステム管理者だけです。</p>
          </div>
        ) : (
          <section aria-labelledby="home-ws">
            <div className="row" style={{ alignItems: "baseline", marginBottom: 12 }}>
              <h2 id="home-ws" style={{ margin: 0 }}>
                ワークスペース
              </h2>
              <span className="muted">{workspaces.length}</span>
              {user.instanceAdmin ? (
                <Link className="btn" href="/w/me/workspaces?new=1" style={{ marginLeft: "auto" }}>
                  新しいワークスペース
                </Link>
              ) : null}
            </div>
            <WorkspaceCards workspaces={workspaces} />
          </section>
        )}
        <UsageSummary instanceAdmin={user.instanceAdmin === true} />
      </Content>
    </AppShell>
  );
}
