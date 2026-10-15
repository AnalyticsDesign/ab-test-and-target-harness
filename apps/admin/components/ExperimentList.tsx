"use client";
import { describePageMatch } from "@/lib/page-match";
import { useState } from "react";
import Link from "next/link";
import type { Experiment } from "@/lib/types";
import { FILTER_JA, STATUS_FILTERS, STATUS_JA, STATUS_TONE, countByFilter, filterExperiments, type StatusFilter } from "@/lib/experiment-filter";
import { replaceParam } from "@/lib/url-state";
import { LocalTime } from "./LocalTime";
import { StatusPill } from "./ui/StatusPill";

/** 状態の pill = Desired(status)。「本番」列 = Published(publishedStatus)との差。initialFilter はサーバーが ?status= から読んで渡す */
export function ExperimentList({ wid, sid, experiments, canPublish, initialFilter }: { wid: string; sid: string; experiments: Experiment[]; canPublish: boolean; initialFilter: StatusFilter }) {
  const [filter, setFilter] = useState<StatusFilter>(initialFilter);
  if (experiments.length === 0) return <p className="muted">エクスペリエンスはまだありません</p>;
  const counts = countByFilter(experiments);
  const shown = filterExperiments(experiments, filter);
  return (
    <>
      <div role="group" aria-label="状態で絞り込む" className="row" style={{ gap: 4, marginBottom: 12 }}>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className="btn"
            aria-pressed={filter === f}
            data-testid={`filter-${f}`}
            style={filter === f ? { background: "var(--nav-active)", borderColor: "var(--border-strong)" } : { background: "transparent", borderColor: "transparent", color: "var(--muted)" }}
            onClick={() => {
              setFilter(f);
              replaceParam("status", f === "all" ? null : f);
            }}
          >
            {FILTER_JA[f]} <span className="muted">{counts[f]}</span>
          </button>
        ))}
      </div>
      <div className="card-flush">
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>状態</th>
              <th>本番</th>
              <th>URL</th>
              <th>配信率</th>
              <th>更新</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => {
              const pending = e.publishedStatus ? `配信中: ${STATUS_JA[e.publishedStatus]}(${STATUS_JA[e.status]} は未反映)` : "未反映";
              return (
                <tr key={e.id} data-testid={`experiment-row-${e.id}`}>
                  <td>
                    <Link href={`/w/${wid}/sites/${sid}/experiments/${e.id}`}>{e.name}</Link>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="muted mono">{e.id}</span>
                      {e.unpublished ? <span className="badge badge-warn">未公開の編集あり</span> : null}
                    </div>
                  </td>
                  <td>
                    <StatusPill tone={STATUS_TONE[e.status]}>{STATUS_JA[e.status]}</StatusPill>
                  </td>
                  <td>
                    {e.publishedStatus === e.status ? (
                      <span className="muted">反映済み</span>
                    ) : (
                      <StatusPill tone="warn" title={`公開が失敗したか、まだ公開していません。${pending}${canPublish ? " → 公開で再試行" : ""}`}>
                        未反映
                      </StatusPill>
                    )}
                  </td>
                  <td>
                    {describePageMatch(e.urlMatch)}
                  </td>
                  <td>{e.trafficPercentage}%</td>
                  <td className="muted"><LocalTime at={e.updatedAt} /></td>
                </tr>
              );
            })}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  この状態のエクスペリエンスはありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
