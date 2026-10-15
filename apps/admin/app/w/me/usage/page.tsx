// apps/admin/app/w/me/usage/page.tsx
import { controlFetch, requireUser } from "@/lib/control";
import type { UsageReport, UsageSettingsView } from "@/lib/types";
import { usageFailure } from "@/lib/usage";
import { UsagePanel } from "@/components/usage/UsagePanel";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";

/**
 * 設定 > システム > Cloudflare 使用状況(backlog D10、決定 54 (7))。システム管理者だけ。
 * 設定は GraphQL の取得に関係なく出す(未設定・取得の失敗でも、見られる人とプランは変えられる)
 */
export default async function UsagePage() {
  const me = await requireUser();
  if (!me.instanceAdmin) {
    return (
      <>
        <TopBar crumbs={[{ label: "設定" }, { label: "Cloudflare 使用状況" }]} />
        <Content>
          <p className="error-box">この画面はシステム管理者だけが開けます</p>
        </Content>
      </>
    );
  }
  // /usage の失敗はエラー封筒とは限らない(HTML の 503 なら data は null)ので unknown で受け、usageFailure で案内にする
  const [settings, usage] = await Promise.all([controlFetch<UsageSettingsView>("/usage/settings"), controlFetch<unknown>("/usage")]);
  return (
    <>
      <TopBar crumbs={[{ label: "設定" }, { label: "Cloudflare 使用状況" }]} />
      <Content>
        {settings.status === 200 ? (
          <UsagePanel
            // configured は読み取り専用なので、フォーム(PATCH の body)には 3 項目だけを渡す
            settings={{ usageVisibility: settings.data.usageVisibility, cloudflarePlan: settings.data.cloudflarePlan, showPaidReference: settings.data.showPaidReference }}
            usage={usage.status === 200 ? { ok: true, report: usage.data as UsageReport } : { ok: false, ...usageFailure(usage.status, usage.data) }}
          />
        ) : (
          <p className="error-box">使用状況の設定を取得できませんでした(HTTP {settings.status})。時間をおいて開き直してください</p>
        )}
      </Content>
    </>
  );
}
