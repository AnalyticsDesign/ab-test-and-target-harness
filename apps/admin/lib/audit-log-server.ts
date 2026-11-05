import { auditApiQuery, type AuditFilter, type AuditPageData } from "./audit-log";
import { controlFetch } from "./control";

/** 最初のページ。query = 読んだ引数(続きの読み込みは同じ引数に cursor を足す。直近 N 日の起点をずらさない) */
export type AuditFirstPage = { status: number; data: AuditPageData | null; query: string };

/**
 * B129(spec §7.2・§10.2): 設定の「操作の記録」の最初のページ(サーバーの描画で 1 本。lib/control.ts の controlFetch = controlRequest を通す)。
 * path は `/workspaces/:wid/audit-events` か `/audit-events`。直近 N 日の起点はこの描画の時刻(画面の文字にはしないので、時刻の描画の決まりの外)
 */
export async function loadAuditFirstPage(path: string, filter: AuditFilter): Promise<AuditFirstPage> {
  const query = auditApiQuery(filter, Date.now());
  const r = await controlFetch<AuditPageData | null>(`${path}?${query}`);
  return { status: r.status, data: r.status === 200 ? r.data : null, query };
}
