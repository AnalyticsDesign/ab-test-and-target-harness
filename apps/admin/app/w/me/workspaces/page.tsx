import { requireUser } from "@/lib/control";
import { loadSummary } from "@/lib/loaders";
import { WorkspacesAdmin } from "@/components/WorkspacesAdmin";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";

/** 設定 > ワークスペース(システム管理者だけ)。システム管理者はすべてのワークスペースのオーナーなので、概要の API で全件が取れる */
export default async function WorkspacesSettingsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const me = await requireUser();
  const summary = me.instanceAdmin ? await loadSummary() : null;
  const focusNew = (await searchParams).new === "1"; // ホームの「新しいワークスペース」から来た(K18)
  return (
    <>
      <TopBar crumbs={[{ label: "設定" }, { label: "ワークスペース" }]} />
      <Content>
        <PageHeader title="ワークスペース" />
        {!me.instanceAdmin ? (
          <p className="error-box">この画面はシステム管理者だけが開けます</p>
        ) : summary && summary.status === 200 ? (
          <WorkspacesAdmin workspaces={summary.data} focusNew={focusNew} />
        ) : (
          <p className="error-box">ワークスペースの一覧を取得できませんでした(HTTP {summary?.status})。時間をおいて開き直してください</p>
        )}
      </Content>
    </>
  );
}
