"use client";
import { Fragment, useEffect, useState } from "react";
import { AppLink } from "@/components/ui/AppLink";
import { api, describeError } from "@/lib/client";
import { deleteBlocked, runningIn } from "@/lib/workspaces";
import type { WorkspaceSummary } from "@/lib/types";
import { WorkspaceCreateForm } from "./WorkspaceForms";
import { reloadDocument } from "@/lib/navigate";
import { BusyScope, useBusyAction } from "./ui/BusyScope";

/** 削除の応答が 30 秒で分からなかったとき */
const WRITE_UNKNOWN = "保存できたか分かりません。再読み込みして確かめてください";

/**
 * 設定 > ワークスペース(決定 54 (10)。システム管理者だけ)= 作成 + 一覧(サイト数・メンバー数・配信中の数)+ 削除。
 * 削除できないときはボタンを無効にして理由を出す。確認はその場(行の下)に開き、消えるものを列挙し、名前を打ち込むまで押せない。
 * ゴミ箱は無いので「元に戻せません」と書く。
 * 削除は、確認の行を覆い(BusyScope)、全画面の読み直しでページが閉じるまで押し直せなくする(B173 第 2 段)
 */
export function WorkspacesAdmin({ workspaces, focusNew }: { workspaces: WorkspaceSummary[]; focusNew: boolean }) {
  const [deleting, setDeleting] = useState<string | null>(null);
  // 削除の途中(確認の行の範囲から知らせる)。ほかの行の「削除」も押せなくする(押すと削除の途中の行が閉じ、読み直しが始まらなくなるため)
  const [busy, setBusy] = useState(false);
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
                      <AppLink href={`/w/${w.id}`}>{w.name}</AppLink>
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
                            onClick={() => setDeleting(w.id)}
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
                        <BusyScope id={`workspace-delete-${w.id}`}>
                          <WorkspaceDeleteConfirm workspace={w} onBusy={setBusy} onCancel={() => setDeleting(null)} />
                        </BusyScope>
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

/** 削除の確認の行(開くたびに入力・失敗は空から)。消えるものを列挙し、名前を打ち込むまで押せない */
function WorkspaceDeleteConfirm({ workspace: w, onBusy, onCancel }: { workspace: WorkspaceSummary; onBusy: (busy: boolean) => void; onCancel: () => void }) {
  const { busy, run } = useBusyAction();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onBusy(busy), [busy, onBusy]);
  async function remove() {
    setError(null);
    const outcome = await run({
      label: "削除中…",
      write: (signal) => api("DELETE", `/workspaces/${w.id}`, undefined, { signal }),
      // クライアントの再取得(router.refresh)は共有 layout(サイドバーの切り替えの一覧)を確実には描き直さない
      // (このバージョンの Next.js/vinext で実測)ため、全画面で読み直す。ページが閉じるまで覆いと実行権を保つ
      after: "navigate",
      navigate: () => reloadDocument(),
    });
    // 押せる状態から削除するまでの間に誰かが開始した等。サーバーの 409 の文をその行に出す(Review Focus 3)
    if (outcome.kind === "failed") setError(describeError(outcome.error));
    else if (outcome.kind === "unknown") setError(WRITE_UNKNOWN);
  }
  return (
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
      {error ? (
        <p className="error-box" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <button type="button" className="btn btn-danger" disabled={busy || typed !== w.name} onClick={() => void remove()}>
          削除する
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  );
}
