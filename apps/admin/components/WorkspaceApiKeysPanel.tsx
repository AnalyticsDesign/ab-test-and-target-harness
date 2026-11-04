// apps/admin/components/WorkspaceApiKeysPanel.tsx(B33: 管理者が Workspace のメンバーの API キーを所有者付きで一覧し、失効させる)
"use client";
import { useConfirm } from "@/components/ConfirmProvider";
import { api } from "@/lib/client";
import { capLabel, revokeBlockedReason, scopeLabel } from "@/lib/api-keys";
import type { Role, WorkspaceApiKey } from "@/lib/types";
import { ExpiryLabel, LocalTime, useNow } from "./LocalTime";
import { BusyScope, useBusyAction } from "./ui/BusyScope";
import { CardNotice, useBusyNotice } from "./ui/BusyNotice";

/** 時刻の列(マウントの後にブラウザのタイムゾーンで描く。B44) */
const when = (at: number | null) => (at ? <LocalTime at={at} /> : "-");

export function WorkspaceApiKeysPanel({ workspaceId, myRole, amInstanceAdmin, keys }: { workspaceId: string; myRole: Role; amInstanceAdmin: boolean; keys: WorkspaceApiKey[] }) {
  const active = keys.filter((k) => k.revokedAt === null);
  const revoked = keys.filter((k) => k.revokedAt !== null);
  // 期限切れでも失効していないキーは上の表に残る(control は期限から 30 日で一覧から外す)ので、その旨を表の下に添える
  const now = useNow(); // 期限切れの判定はマウントの後(B44)
  const hasExpired = now !== null && active.some((k) => k.expiresAt !== null && k.expiresAt <= now);
  return (
    <section>
      <p>
        このワークスペースで使えるキーです(このワークスペースを範囲にしたキーと、システム管理者の「すべてのワークスペース」のキー)。「すべてのワークスペース」のキーを失効させると、どのワークスペースでも使えなくなります。オーナーのキーを失効できるのはオーナーだけ、システム管理者のキーを失効できるのはシステム管理者だけです。自分のキーの発行は、左メニューの下の「設定」→「API キー」から行います。
      </p>
      {/* キーの一覧のカードを覆う(B173 第 2 段) */}
      <BusyScope id="workspace-api-keys-list">
        <WorkspaceKeysList workspaceId={workspaceId} myRole={myRole} amInstanceAdmin={amInstanceAdmin} active={active} />
      </BusyScope>
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

/** 有効なキーの一覧のカード。失効の結果はカードの先頭に 1 行で出す */
function WorkspaceKeysList({ workspaceId, myRole, amInstanceAdmin, active }: { workspaceId: string; myRole: Role; amInstanceAdmin: boolean; active: WorkspaceApiKey[] }) {
  // 確認は範囲の中で開く(確認の持ち主をこの範囲にする)
  const ask = useConfirm();
  const { run } = useBusyAction();
  const { notice, show, clear } = useBusyNotice();

  async function revoke(k: WorkspaceApiKey) {
    clear();
    const outcome = await run({
      label: "失効中…",
      confirm: () =>
        ask({
          title: `${k.owner.email} のキー「${k.name}」を失効しますか?`,
          body:
            k.scope === "full"
              ? "「すべてのワークスペース」のキーです。どのワークスペースでも使えなくなり、元に戻せません"
              : "このキーを使っているエージェントやスクリプトは使えなくなり、元に戻せません",
          confirmLabel: "失効する",
        }),
      write: (signal) => api("DELETE", `/workspaces/${workspaceId}/api-keys/${k.id}`, undefined, { signal }),
      after: "refresh",
    });
    show(outcome, "失効させました");
  }

  return (
    <div className="card-flush" data-testid="workspace-api-keys-list">
      <CardNotice notice={notice} />
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
                  disabled={blocked !== null}
                  title={blocked ?? undefined}
                  onClick={() => void revoke(k)}
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
  );
}
