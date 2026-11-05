import { requireUser } from "@/lib/control";
import { parseAuditFilter } from "@/lib/audit-log";
import { loadAuditFirstPage } from "@/lib/audit-log-server";
import { allInOrder } from "@/lib/loaders";
import { AuditLogPanel } from "@/components/audit/AuditLogPanel";
import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageMark } from "@/components/ui/PageMark";

/**
 * 設定 > システム > 操作の記録(B129 spec §7.2)。導入全体(すべてのワークスペースと、システム管理者・非常口・パスワードのログインなど)の記録。
 * システム管理者だけ(メニューの入口もシステム管理者だけ。権限は control の 403 で判定する)。
 * 要求(spec §10.2・§10.6): layout の 3 本 + `/audit-events` の 1 本(allInOrder で並べる。ワークスペースの名前は control が各行に付ける)
 */
export default async function InstanceAuditEventsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const filter = parseAuditFilter(search);
  const apiPath = "/audit-events";
  const [, first] = await allInOrder([requireUser(), loadAuditFirstPage(apiPath, filter)]);
  return (
    <>
      <PageMark path={`/w/me/audit-events`} search={search} />
      <TopBar crumbs={[{ label: "設定" }, { label: "操作の記録" }]} scope={{ wid: null, sid: null }} />
      <Content>
        <PageHeader title="操作の記録" />
        {first.status === 200 && first.data ? (
          <>
            <p className="muted">この導入のすべての操作の記録です(システム管理者・ワークスペースの作成と削除・非常口を含む)。記録は 365 日残ります。</p>
            {/* 読んだ引数ごとに作り直す(パネルは props を状態の初期値として 1 回だけ取るので、同じ画面への移動・戻る・進むでサーバーが読み直した表と絞り込みに揃える) */}
            <AuditLogPanel key={`${apiPath}?${first.query}`} scope="instance" apiPath={apiPath} initialFilter={filter} initialQuery={first.query} initialPage={first.data} />
          </>
        ) : first.status === 403 ? (
          <p className="error-box">この画面はシステム管理者だけが開けます</p>
        ) : (
          <p className="error-box">操作の記録を取得できませんでした(HTTP {first.status})。時間をおいて開き直してください</p>
        )}
      </Content>
    </>
  );
}
