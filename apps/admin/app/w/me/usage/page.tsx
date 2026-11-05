// apps/admin/app/w/me/usage/page.tsx
import { controlFetch, requireUser } from "@/lib/control";
import type { UsageReport, UsageSettingsView } from "@/lib/types";
import { pickControlCapacity, usageFailure } from "@/lib/usage";
import { UsagePanel } from "@/components/usage/UsagePanel";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageMark } from "@/components/ui/PageMark";

/**
 * 設定 > システム > Cloudflare 使用状況(backlog D10、決定 54 (7))。システム管理者だけ。
 * 設定は GraphQL の取得に関係なく出す(未設定・取得の失敗でも、見られる人とプランは変えられる)
 */
export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireUser();
  // どの分岐でも同じ印を出す(印の無い分岐に移ると、遷移の待ち表示が打ち切りまで終わらない)
  const mark = <PageMark path={`/w/me/usage`} search={await searchParams} />;
  if (!me.instanceAdmin) {
    return (
      <>
        {mark}
        <TopBar crumbs={[{ label: "設定" }, { label: "Cloudflare 使用状況" }]} scope={{ wid: null, sid: null }} />
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
      {mark}
      <TopBar crumbs={[{ label: "設定" }, { label: "Cloudflare 使用状況" }]} scope={{ wid: null, sid: null }} />
      <Content>
        {settings.status === 200 ? (
          <UsagePanel
            // configured は読み取り専用なので、フォーム(PATCH の body)には 3 項目だけを渡す
            settings={{ usageVisibility: settings.data.usageVisibility, cloudflarePlan: settings.data.cloudflarePlan, showPaidReference: settings.data.showPaidReference }}
            usage={usage.status === 200 ? { ok: true, report: usage.data as UsageReport } : { ok: false, ...usageFailure(usage.status, usage.data) }}
            // B129: 制御用のデータベースの大きさは GET /usage/settings の値を使う(GET /usage が失敗しても出す。要求は増やさない)
            controlCapacity={pickControlCapacity(settings.data, usage.status === 200 ? (usage.data as UsageReport) : null)}
          />
        ) : (
          <p className="error-box">使用状況の設定を取得できませんでした(HTTP {settings.status})。時間をおいて開き直してください</p>
        )}
      </Content>
    </>
  );
}
