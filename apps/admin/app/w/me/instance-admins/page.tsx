import { controlFetch, requireUser } from "@/lib/control";
import type { InstanceAdmin, InstanceAdminCandidate, Workspace } from "@/lib/types";
import { InstanceAdminsPanel } from "@/components/InstanceAdminsPanel";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";

/** B36: システム管理者の一覧・追加・外す。403 はシステム管理者でない人、それ以外の失敗は取得の失敗として出し分ける */
export default async function InstanceAdminsPage() {
  const me = await requireUser();
  // B41 (2): 追加はメンバーから選ぶ。候補は一覧と同じ権限(システム管理者だけ)なので、並べて取る
  const [r, candidates, workspaces] = await Promise.all([
    controlFetch<InstanceAdmin[]>("/instance-admins"),
    controlFetch<InstanceAdminCandidate[]>("/instance-admins/candidates"),
    // B46: 外したときに外れるワークスペースを確認画面に出す(システム管理者には全件が返る)
    controlFetch<Workspace[]>("/workspaces"),
  ]);
  return (
    <>
      <TopBar crumbs={[{ label: "設定" }, { label: "システム管理者" }]} />
      <Content>
        {r.status === 200 ? (
          <InstanceAdminsPanel
            admins={r.data}
            candidates={candidates.status === 200 ? candidates.data : null}
            workspaces={workspaces.status === 200 ? workspaces.data.map(({ id, name }) => ({ id, name })) : null}
            myUserId={me.id}
          />
        ) : r.status === 403 ? (
          <p className="error-box">この画面はシステム管理者だけが開けます</p>
        ) : (
          <p className="error-box">システム管理者の一覧を取得できませんでした(HTTP {r.status})。時間をおいて開き直してください</p>
        )}
      </Content>
    </>
  );
}
