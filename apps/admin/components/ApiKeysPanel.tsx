// apps/admin/components/ApiKeysPanel.tsx(自分の API キー。決定 54 (11)、決定 55。発行・一覧・失効はユーザー自身が管理画面から)
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, describeError } from "@/lib/client";
import { capLabel, ownScopeLabel, scopeLabel } from "@/lib/api-keys";
import { canManage } from "@/lib/roles";
import type { ApiKey, Workspace } from "@/lib/types";
import { ErrorBox } from "./ErrorBox";
import { ExpiryLabel, LocalTime, useNow } from "./LocalTime";
import { IssueKeyForm, type IssuedResult } from "./api-keys/IssueKeyForm";
import { IssuedKey } from "./api-keys/IssuedKey";
import { LeaveKeyDialog } from "./api-keys/LeaveKeyDialog";
import { useLeaveGuard, type LeaveAttempt } from "./api-keys/useLeaveGuard";

/** 時刻の列(マウントの後にブラウザのタイムゾーンで描く。B44) */
const when = (at: number | null) => (at ? <LocalTime at={at} /> : "-");

export function ApiKeysPanel({ keys, workspaces, amInstanceAdmin }: { keys: ApiKey[]; workspaces: Workspace[]; amInstanceAdmin: boolean }) {
  const router = useRouter();
  const ask = useConfirm();
  const active = keys.filter((k) => k.revokedAt === null);
  const revoked = keys.filter((k) => k.revokedAt !== null);
  // 期限切れでも失効していないキーは上の表に残る(control は期限から 30 日で一覧から外す)ので、その旨を表の下に添える
  const now = useNow(); // 期限切れの判定はマウントの後(B44)
  const hasExpired = now !== null && active.some((k) => k.expiresAt !== null && k.expiresAt <= now);
  const [issued, setIssued] = useState<IssuedResult | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [pending, setPending] = useState<LeaveAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onAttempt = useCallback((a: LeaveAttempt) => setPending(a), []);
  const { bypass } = useLeaveGuard(issued !== null, onAttempt);
  // 管理者以上であるワークスペース(システム管理者はすべてのワークスペースのオーナーなので、すべて)
  const managed = workspaces.filter((w) => canManage(w.role));

  function leave() {
    const a = pending;
    setPending(null);
    if (!a) return;
    bypass();
    setIssued(null);
    if (a.kind === "href") router.push(a.href);
    else a.form.requestSubmit();
  }
  function stay() {
    // ログアウトを止めたときは、開いたままのユーザーメニュー(<details>)を閉じる
    if (pending?.kind === "logout") pending.form.closest("details")?.removeAttribute("open");
    refocusResult.current = true;
    setPending(null);
  }
  // 「戻って控える」の後は結果の見出しにフォーカスを戻す。モーダルが開いている間は外側が inert でフォーカスが載らず、
  // close() でブラウザが押したリンクへフォーカスを戻すため、ダイアログが閉じた後(子の effect が先に走る = close() の後)に移す
  const refocusResult = useRef(false);
  useEffect(() => {
    if (pending !== null || !refocusResult.current) return;
    refocusResult.current = false;
    document.getElementById("issued-title")?.focus();
  }, [pending]);
  async function revoke(k: ApiKey) {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", `/me/api-keys/${k.id}`);
      router.refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <p>
        AI エージェントやスクリプトから管理用の API を呼ぶためのキーです。キーはあなたに紐づき、範囲に選んだワークスペースで、選んだ権限までの操作ができます。メンバーの招待やキーの発行など、人とアクセス権の操作はキーではできません(この管理画面から行います)。
      </p>
      {issued ? (
        <IssuedKey issued={issued} onClose={() => setIssued(null)} />
      ) : (
        <IssueKeyForm
          workspaces={workspaces}
          amInstanceAdmin={amInstanceAdmin}
          onIssued={(k) => {
            setIssued(k);
            setHighlight(k.id);
            router.refresh();
          }}
        />
      )}
      <LeaveKeyDialog open={pending !== null} onStay={stay} onLeave={leave} />
      <div className="row" style={{ alignItems: "baseline" }}>
        <h2>発行済みのキー</h2>
        <span className="muted">{active.length} 件</span>
      </div>
      <ErrorBox message={error} />
      <div className="card-flush">
        <table data-testid="api-keys">
          <thead>
            <tr>
              <th>名前</th>
              <th>接頭辞</th>
              <th>範囲</th>
              <th className="nowrap">権限</th>
              <th className="nowrap">期限</th>
              <th className="nowrap">作成</th>
              <th className="nowrap">最終使用</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {active.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  まだキーはありません
                </td>
              </tr>
            ) : null}
            {active.map((k) => (
              <tr key={k.id} className={k.id === highlight ? "row-new" : undefined}>
                <td>{k.name}</td>
                <td>
                  <code>{k.prefix}…</code>
                </td>
                <td>{ownScopeLabel(k, workspaces, amInstanceAdmin)}</td>
                <td className="nowrap">{capLabel(k.roleCap)}</td>
                <td className="nowrap"><ExpiryLabel expiresAt={k.expiresAt} /></td>
                <td className="nowrap">{when(k.createdAt)}</td>
                <td className="nowrap">{when(k.lastUsedAt)}</td>
                <td>
                  {/* 押し間違いで失効しないよう確認する(失効は取り消せない) */}
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={async () => {
                      const ok = await ask({
                        title: `キー「${k.name}」を失効しますか?`,
                        body:
                          k.scope === "full"
                            ? "「すべてのワークスペース」のキーです。どのワークスペースでも使えなくなり、元に戻せません"
                            : "このキーを使っているエージェントやスクリプトは使えなくなり、元に戻せません",
                        confirmLabel: "失効する",
                      });
                      if (ok) await revoke(k);
                    }}
                  >
                    失効
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasExpired ? (
        <p className="muted" data-testid="expired-keys-note">
          期限切れのキーは期限から 30 日で一覧から消えます
        </p>
      ) : null}
      {managed.length > 0 ? (
        <div className="card">
          <strong>メンバーのキーを確認・失効する</strong>
          <ul>
            {managed.map((w) => (
              <li key={w.id}>
                <Link href={`/w/${w.id}/api-keys`}>{w.name} のメンバーの API キー</Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {revoked.length > 0 ? (
        <>
          <h3>失効済み(失効または期限切れから 30 日で一覧から消えます)</h3>
          <div className="card-flush">
            <table data-testid="revoked-api-keys">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>接頭辞</th>
                  <th>範囲</th>
                  <th className="nowrap">権限</th>
                  <th className="nowrap">発行</th>
                  <th className="nowrap">失効</th>
                </tr>
              </thead>
              <tbody>
                {revoked.map((k) => (
                  <tr key={k.id} className="muted">
                    <td>{k.name}</td>
                    <td>
                      <code>{k.prefix}…</code>
                    </td>
                    <td>{scopeLabel(k)}</td>
                    <td className="nowrap">{capLabel(k.roleCap)}</td>
                    <td className="nowrap">{when(k.createdAt)}</td>
                    <td className="nowrap">{when(k.revokedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
