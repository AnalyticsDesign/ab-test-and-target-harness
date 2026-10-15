// apps/admin/lib/workspaces.ts — 設定 > ワークスペースの削除の判断(決定 54 (10))。認可と最終判断は control(409)、ここは押す前に分かるようにするだけ

/** 配下のサイトの配信中のエクスペリエンスの合計(runningCount は control の定義 = Desired か公開済みが running) */
export const runningIn = (w: { sites: Array<{ runningCount: number }> }): number => w.sites.reduce((n, s) => n + s.runningCount, 0);

/** 削除できない理由(できるなら null)。control の判定と同じ順: 配信中が先(409 workspace_has_running_experiments)、最後の 1 つが後(409 last_workspace) */
export function deleteBlocked(w: { sites: Array<{ runningCount: number }> }, total: number): string | null {
  const n = runningIn(w);
  if (n > 0) return `配信中のエクスペリエンスが ${n} 件あります。終了してから削除してください`;
  if (total <= 1) return "最後のワークスペースは削除できません。先に別のワークスペースを作ってください";
  return null;
}
