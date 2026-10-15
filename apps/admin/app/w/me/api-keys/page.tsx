import { ApiKeysPanel } from "@/components/ApiKeysPanel";
import { controlFetch, requireUser } from "@/lib/control";
import { loadWorkspaces } from "@/lib/loaders";
import type { ApiKey } from "@/lib/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { TopBar } from "@/components/ui/TopBar";
import { Content } from "@/components/ui/AppShell";

export default async function ApiKeysPage() {
  const me = await requireUser();
  // ワークスペースの一覧は共有 loader(summary から作る。取れなければ画面全体のエラー)。B42: 範囲の選択肢と、範囲ごとの権限の上限を決めるのに使う
  const [keys, workspaces] = await Promise.all([controlFetch<ApiKey[]>("/me/api-keys"), loadWorkspaces()]);
  return (
    <>
      <TopBar crumbs={[{ label: "設定" }, { label: "API キー" }]} />
      <Content>
        <div>
          <PageHeader title="API キー" />
          <ApiKeysPanel keys={keys.data} workspaces={workspaces} amInstanceAdmin={me.instanceAdmin === true} />
        </div>
      </Content>
    </>
  );
}
