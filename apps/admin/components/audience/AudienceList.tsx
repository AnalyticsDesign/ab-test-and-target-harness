"use client";
import { useState } from "react";
import Link from "next/link";
import { dslHasHistory, makeNames, summarizeDsl } from "@/lib/conditions";
import type { Audience, Goal } from "@/lib/types";
import { LocalTime } from "../LocalTime";
import { PageHeader } from "../ui/PageHeader";
import styles from "./Audience.module.css";

/** オーディエンスの一覧(設計書 §12): 名前・条件の要約・履歴の印・使用中のエクスペリエンスの数・更新日。名前と条件で絞り込める */
export function AudienceList({ wid, siteId, audiences, goals, canEdit }: { wid: string; siteId: string; audiences: Audience[]; goals: Goal[]; canEdit: boolean }) {
  const [query, setQuery] = useState("");
  const names = makeNames(goals, audiences);
  const base = `/w/${wid}/sites/${siteId}/audiences`;
  const rows = audiences
    .map((a) => ({ a, summary: summarizeDsl(a.definition, names) }))
    .filter(({ a, summary }) => {
      const q = query.trim().toLowerCase();
      return !q || a.name.toLowerCase().includes(q) || a.id.includes(q) || summary.toLowerCase().includes(q);
    });
  return (
    <div>
      <PageHeader
        title="オーディエンス"
        meta={`${audiences.length} 件`}
        actions={
          canEdit ? (
            <Link className="btn btn-primary" href={`${base}/new`}>
              新しいオーディエンス
            </Link>
          ) : null
        }
      />
      <p className="muted">エクスペリエンスの配信条件で選べる、名前付きの訪問者の条件です。閲覧したページの条件は URL・パス・ホストを直接書きます。編集は次の公開で、参照するすべてのエクスペリエンスに反映されます。</p>
      <input type="search" className={styles.filter} aria-label="絞り込み" placeholder="名前・条件で絞り込み" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="card-flush">
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>条件の要約</th>
              <th>履歴</th>
              <th>使用中のエクスペリエンス</th>
              <th>更新</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ a, summary }) => (
              <tr key={a.id}>
                <td>
                  <Link className={styles.listName} href={`${base}/${a.id}`}>
                    {a.name}
                  </Link>
                  <div className="muted mono">{a.id}</div>
                </td>
                <td>{summary}</td>
                <td>{dslHasHistory(a.definition) ? <span className="badge badge-warn">履歴</span> : <span className="muted">—</span>}</td>
                <td className={styles.right}>{a.usedBy.length > 0 ? `${a.usedBy.length} 件` : <span className="muted">未使用</span>}</td>
                <td className={styles.right}><LocalTime at={a.updatedAt} kind="date" /></td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  {audiences.length === 0 ? "まだオーディエンスがありません" : "一致するオーディエンスはありません"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
