import { publishRowStatus } from "@/lib/publish-status";
import type { PublishRow } from "@/lib/types";
import { LocalTime } from "./LocalTime";
import { StatusPill } from "./ui/StatusPill";

/**
 * 公開履歴。状態の言葉と色(いま配信中の 1 行の判定を含む)は、上部バーの「直近の公開」と同じ publishRowStatus で決める
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
            {history.map((h) => {
              const st = publishRowStatus(h, activeVersion);
              return (
                <tr key={h.version} data-testid={`publish-row-${h.version}`}>
                  <td className="mono">v{h.version}</td>
                  <td><StatusPill tone={st.tone}>{st.label}</StatusPill></td>
                  <td><LocalTime at={h.activatedAt ?? h.createdAt} /></td>
                  <td>{h.publishedBy.name}</td>
                  <td>{h.needsProfile === null ? "-" : String(h.needsProfile)}</td>
                  <td className="muted">{h.error ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">
        ロールバックの操作は今後追加します(過去の版の config は control の <code>GET /sites/:sid/publishes/:version</code> で取得できます)
      </p>
    </>
  );
}
