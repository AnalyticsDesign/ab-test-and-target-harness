import type { PublishRow } from "./types";

/**
 * 公開の行の状態の言葉と色(B60 D2)。公開履歴の画面と、上部バーの版の札から開く「直近の公開」で同じものを使う。
 * 行の status は activate に成功した「出来事の記録」で active のまま残り続ける(複数行が active になりうる)。
 * いま配信中かは site.activeVersion と version が一致する 1 行だけで判定する
 */
export type PublishRowStatus = { label: "配信中" | "公開済み" | "置き換え済み" | "処理中" | "失敗"; tone: "ok" | "gray" | "warn" | "danger" };

/** 配信中でない行の状態。active = 公開に成功した記録、superseded = 後の版に置き換わった */
const BY_STATUS: Record<PublishRow["status"], PublishRowStatus> = {
  active: { label: "公開済み", tone: "gray" },
  superseded: { label: "置き換え済み", tone: "gray" },
  reserved: { label: "処理中", tone: "warn" },
  failed: { label: "失敗", tone: "danger" },
};

export function publishRowStatus(row: Pick<PublishRow, "version" | "status">, activeVersion: number | null): PublishRowStatus {
  if (activeVersion !== null && row.version === activeVersion) return { label: "配信中", tone: "ok" };
  return BY_STATUS[row.status];
}

/** 版の降順の先頭 n 件(既定 5)。control の一覧の並びに頼らず、渡された配列も並べ替えない */
export function recentPublishes(rows: PublishRow[], n = 5): PublishRow[] {
  return [...rows].sort((a, b) => b.version - a.version).slice(0, n);
}
