import type { PublishRow } from "@/lib/types";
import { LocalTime } from "./LocalTime";
import { StatusPill } from "./ui/StatusPill";

const ROW_TONE = { active: "gray", superseded: "gray", reserved: "warn", failed: "danger" } as const;
/** 配信中でない行の状態。active = 公開に成功した記録(いま配信中の行は別に「配信中」と出す)、superseded = 後の版に置き換わった */
const ROW_STATUS_JA: Record<PublishRow["status"], string> = { active: "公開済み", superseded: "置き換え済み", reserved: "処理中", failed: "失敗" };

/**
 * 公開履歴。行の status は activate に成功した「出来事の記録」で active のまま残り続ける(複数行が active になりうる)。
 * いま配信中かは site.activeVersion と version が一致する 1 行だけで判定する
 */
export function PublishHistory({ history, activeVersion }: { history: PublishRow[]; activeVersion: number | null }) {
  if (history.length === 0) return <p className="muted">まだ公開していません</p>;
  return (
    <>
      <div className="card-flush">
        <table>
          <thead>
            <tr>
              <th>版</th>
              <th>状態</th>
              <th>日時</th>
              <th>実行者</th>
              <th>needsProfile</th>
              <th>エラー</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.version} data-testid={`publish-row-${h.version}`}>
                <td className="mono">v{h.version}</td>
                <td>{h.version === activeVersion ? <StatusPill tone="ok">配信中</StatusPill> : <StatusPill tone={ROW_TONE[h.status]}>{ROW_STATUS_JA[h.status]}</StatusPill>}</td>
                <td><LocalTime at={h.activatedAt ?? h.createdAt} /></td>
                <td>{h.publishedBy.name}</td>
                <td>{h.needsProfile === null ? "-" : String(h.needsProfile)}</td>
                <td className="muted">{h.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        ロールバックの操作は今後追加します(過去の版の config は control の <code>GET /sites/:sid/publishes/:version</code> で取得できます)
      </p>
    </>
  );
}
