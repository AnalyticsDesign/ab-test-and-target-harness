// apps/admin/app/w/me/static-delivery/page.tsx
import { controlFetch, requireUser } from "@/lib/control";
import { parseStaticHealth } from "@/lib/static-health";
import { StaticDeliveryPanel } from "@/components/static/StaticDeliveryPanel";
import { Content } from "@/components/ui/AppShell";
import { PageHeader } from "@/components/ui/PageHeader";
import { TopBar } from "@/components/ui/TopBar";
import { PageMark } from "@/components/ui/PageMark";

/**
 * 設定 > システム > 配信ファイル(7o K14)。システム管理者だけ。設置タグの配信ファイルの配置の状態(すべてのワークスペース)と、
 * 公開中の全サイトの作り直し。状態の GET(control → デプロイ専用の Worker)が取れない(503 など)ときはエラーの箱だけを出す
 */
export default async function StaticDeliveryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireUser();
  // 印と見出しの帯は、どの分岐でも同じものを出す(印の無い分岐に移ると、遷移の待ち表示が打ち切りまで終わらない)
  const crumbs = (
    <>
      <PageMark path={`/w/me/static-delivery`} search={await searchParams} />
      <TopBar crumbs={[{ label: "設定" }, { label: "配信ファイル" }]} scope={{ wid: null, sid: null }} />
    </>
  );
  if (!me.instanceAdmin) {
    return (
      <>
        {crumbs}
        <Content>
          <p className="error-box">この画面はシステム管理者だけが開けます</p>
        </Content>
      </>
    );
  }
  // 503 の本文はエラー封筒とは限らないので unknown で受け、形を確かめてから渡す
  const res = await controlFetch<unknown>("/static/status");
  const health = res.status === 200 ? parseStaticHealth(res.data) : null;
  return (
    <>
      {crumbs}
      <Content>
        <PageHeader title="配信ファイル" meta="設置タグの配信ファイルの配置の状態(すべてのワークスペース)" />
        {health ? (
          <StaticDeliveryPanel initial={health} />
        ) : (
          <p className="error-box">デプロイ専用の Worker の状態を取得できませんでした(HTTP {res.status})。時間をおいて開き直してください</p>
        )}
      </Content>
    </>
  );
}
