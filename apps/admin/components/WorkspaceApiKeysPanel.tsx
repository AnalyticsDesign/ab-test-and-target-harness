// apps/admin/components/WorkspaceApiKeysPanel.tsx(B33: 管理者が Workspace のメンバーの API キーを所有者付きで一覧し、失効させる)
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, describeError } from "@/lib/client";
import { capLabel, revokeBlockedReason, scopeLabel } from "@/lib/api-keys";
import type { Role, WorkspaceApiKey } from "@/lib/types";
import { ErrorBox } from "./ErrorBox";
import { ExpiryLabel, LocalTime, useNow } from "./LocalTime";

/** 時刻の列(マウントの後にブラウザのタイムゾーンで描く。B44) */
const when = (at: number | null) => (at ? <LocalTime at={at} /> : "-");

export function WorkspaceApiKeysPanel({ workspaceId, myRole, amInstanceAdmin, keys }: { workspaceId: string; myRole: Role; amInstanceAdmin: boolean; keys: WorkspaceApiKey[] }) {
  const router = useRouter();
  const ask = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = keys.filter((k) => k.revokedAt === null);
  const revoked = keys.filter((k) => k.revokedAt !== null);
  // 期限切れでも失効していないキーは上の表に残る(control は期限から 30 日で一覧から外す)ので、その旨を表の下に添える
  const now = useNow(); // 期限切れの判定はマウントの後(B44)
  const hasExpired = now !== null && active.some((k) => k.expiresAt !== null && k.expiresAt <= now);
  async function revoke(k: WorkspaceApiKey) {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", `/workspaces/${workspaceId}/api-keys/${k.id}`);
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
        このワークスペースで使えるキーです(このワークスペースを範囲にしたキーと、システム管理者の「すべてのワークスペース」のキー)。「すべてのワークスペース」のキーを失効させると、どのワークスペースでも使えなくなります。オーナーのキーを失効できるのはオーナーだけ、システム管理者のキーを失効できるのはシステム管理者だけです。自分のキーの発行は、ユーザーメニューの「設定」→「API キー」から行います。
      </p>
      <ErrorBox message={error} />
      <div className="card-flush">
        <table data-testid="workspace-api-keys">
          <thead>
            <tr>
              <th>持ち主</th>
              <th>名前</th>
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
                  有効なキーはありません
                </td>
              </tr>
            ) : null}
            {active.map((k) => {
              const blocked = revokeBlockedReason(k, myRole, amInstanceAdmin);
              return (
              <tr key={k.id}>
                <td>
                  {k.owner.email}
                  <OwnerBadge k={k} />
                </td>
                <td>{k.name}</td>
                <td>{scopeLabel(k)}</td>
                <td className="nowrap">{capLabel(k.roleCap, k.owner.role)}</td>
                <td className="nowrap"><ExpiryLabel expiresAt={k.expiresAt} /></td>
                <td className="nowrap">{when(k.createdAt)}</td>
                <td className="nowrap">{when(k.lastUsedAt)}</td>
                <td>
                  <button
                    className="btn btn-danger"
                    disabled={busy || blocked !== null}
                    title={blocked ?? undefined}
                    onClick={async () => {
                      const ok = await ask({
                        title: `${k.owner.email} のキー「${k.name}」を失効しますか?`,
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
              );
            })}
          </tbody>
        </table>
      </div>
      {hasExpired ? (
        <p className="muted" data-testid="expired-keys-note">
          期限切れのキーは期限から 30 日で一覧から消えます
        </p>
      ) : null}
      {revoked.length > 0 ? (
        <>
          <h3>失効済み(失効または期限切れから 30 日で一覧から消えます)</h3>
          <div className="card-flush">
            <table>
              <thead>
                <tr>
                  <th>持ち主</th>
                  <th>名前</th>
                  <th>範囲</th>
                  <th className="nowrap">権限</th>
                  <th className="nowrap">発行</th>
                  <th className="nowrap">失効</th>
                </tr>
              </thead>
              <tbody>
                {revoked.map((k) => (
                  <tr key={k.id} className="muted">
                    <td>
                      {k.owner.email}
                      <OwnerBadge k={k} />
                    </td>
                    <td>{k.name}</td>
                    <td>{scopeLabel(k)}</td>
                    <td className="nowrap">{capLabel(k.roleCap, k.owner.role)}</td>
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

/** B41 (3): 持ち主がシステム管理者なら印を付ける(メンバー一覧の印と同じ) */
function OwnerBadge({ k }: { k: WorkspaceApiKey }) {
  if (!k.owner.instanceAdmin) return null;
  return (
    <>
      {" "}
      <span className="badge" title="すべてのワークスペースのオーナーを兼ねます">
        システム管理者
      </span>
    </>
  );
}
