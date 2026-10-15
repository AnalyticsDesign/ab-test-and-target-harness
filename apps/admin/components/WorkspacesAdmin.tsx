"use client";
import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, describeError } from "@/lib/client";
import { deleteBlocked, runningIn } from "@/lib/workspaces";
import type { WorkspaceSummary } from "@/lib/types";
import { WorkspaceCreateForm } from "./WorkspaceForms";

/**
 * 設定 > ワークスペース(決定 54 (10)。システム管理者だけ)= 作成 + 一覧(サイト数・メンバー数・配信中の数)+ 削除。
 * 削除できないときはボタンを無効にして理由を出す。確認はその場(行の下)に開き、消えるものを列挙し、名前を打ち込むまで押せない。
 * ゴミ箱は無いので「元に戻せません」と書く
 */
export function WorkspacesAdmin({ workspaces, focusNew }: { workspaces: WorkspaceSummary[]; focusNew: boolean }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  async function remove(w: WorkspaceSummary) {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", `/workspaces/${w.id}`);
      setDeleting(null);
      setTyped("");
      router.refresh();
    } catch (e) {
      // 押せる状態から削除するまでの間に誰かが開始した等。サーバーの 409 の文をその行に出す(Review Focus 3)
      setError({ id: w.id, message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p className="muted">この導入にあるワークスペースです。人やサイトを分けて管理したいときに作ります。作成と削除はシステム管理者だけが行えます。</p>
      <WorkspaceCreateForm autoFocus={focusNew} />
      <div className="card-flush">
        <table data-testid="workspaces-admin">
          <thead>
            <tr>
              <th>名前</th>
              <th>サイト</th>
              <th>メンバー</th>
              <th>配信中</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w) => {
              const blocked = deleteBlocked(w, workspaces.length);
              const open = deleting === w.id;
              return (
                <Fragment key={w.id}>
                  <tr>
                    <td>
                      <Link href={`/w/${w.id}`}>{w.name}</Link>
                    </td>
                    <td className="num">{w.sites.length}</td>
                    {/* memberCount は管理者以上のときだけ数(システム管理者は全ワークスペースのオーナーなので通常は数が来る) */}
                    <td className="num">{w.memberCount ?? "—"}</td>
                    <td className="num">{runningIn(w)}</td>
                    <td>
                      {open ? null : (
                        <>
                          <button
                            type="button"
                            className="btn btn-danger"
                            disabled={busy || blocked !== null}
                            onClick={() => {
                              setDeleting(w.id);
                              setTyped("");
                              setError(null);
                            }}
                          >
                            削除
                          </button>
                          {blocked ? <div className="muted" style={{ fontSize: 12 }}>{blocked}</div> : null}
                        </>
                      )}
                    </td>
                  </tr>
                  {open ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="danger-zone" role="group" aria-label={`「${w.name}」の削除の確認`}>
                          <strong>「{w.name}」を削除します。元に戻せません。</strong>
                          <p>次のものがすべて消えます:</p>
                          <ul>
                            <li>
                              サイト {w.sites.length} 件{w.sites.length > 0 ? `(${w.sites.map((s) => s.name).join("・")})` : ""}と、その配信ファイル
                            </li>
                            <li>エクスペリエンス・目標・オーディエンス・公開の履歴</li>
                            <li>
                              メンバー{w.memberCount !== null ? ` ${w.memberCount} 人` : ""}の参加と、未受諾の招待(ほかのワークスペースにも参加している人は、そちらには残ります)
                            </li>
                          </ul>
                          <label className="field">
                            <span className="field-label">確認のため、ワークスペース名「{w.name}」を入力してください</span>
                            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
                          </label>
                          {error?.id === w.id ? (
                            <p className="error-box" role="alert">
                              {error.message}
                            </p>
                          ) : null}
                          <div className="row">
                            <button type="button" className="btn btn-danger" disabled={busy || typed !== w.name} onClick={() => void remove(w)}>
                              削除する
                            </button>
                            <button type="button" className="btn" disabled={busy} onClick={() => setDeleting(null)}>
                              やめる
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
