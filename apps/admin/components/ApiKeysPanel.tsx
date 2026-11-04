// apps/admin/components/ApiKeysPanel.tsx(自分の API キー。決定 54 (11)、決定 55。発行・一覧・失効はユーザー自身が管理画面から)
"use client";
import { useState } from "react";
import { AppLink } from "@/components/ui/AppLink";
import { useConfirm } from "@/components/ConfirmProvider";
import { api } from "@/lib/client";
import { capLabel, ownScopeLabel, scopeLabel } from "@/lib/api-keys";
import { canManage } from "@/lib/roles";
import type { ApiKey, Workspace } from "@/lib/types";
import { ExpiryLabel, LocalTime, useNow } from "./LocalTime";
import { IssueKeyForm, type IssuedResult } from "./api-keys/IssueKeyForm";
import { IssuedKey } from "./api-keys/IssuedKey";
import { BusyScope, useBusyAction } from "./ui/BusyScope";
import { CardNotice, useBusyNotice } from "./ui/BusyNotice";

/** 時刻の列(マウントの後にブラウザのタイムゾーンで描く。B44) */
const when = (at: number | null) => (at ? <LocalTime at={at} /> : "-");

export function ApiKeysPanel({ keys, workspaces, amInstanceAdmin }: { keys: ApiKey[]; workspaces: Workspace[]; amInstanceAdmin: boolean }) {
  const active = keys.filter((k) => k.revokedAt === null);
  const revoked = keys.filter((k) => k.revokedAt !== null);
  // 期限切れでも失効していないキーは上の表に残る(control は期限から 30 日で一覧から外す)ので、その旨を表の下に添える
  const now = useNow(); // 期限切れの判定はマウントの後(B44)
  const hasExpired = now !== null && active.some((k) => k.expiresAt !== null && k.expiresAt <= now);
  const [issued, setIssued] = useState<IssuedResult | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  // 管理者以上であるワークスペース(システム管理者はすべてのワークスペースのオーナーなので、すべて)
  const managed = workspaces.filter((w) => canManage(w.role));

  return (
    <section>
      <p>
        AI エージェントやスクリプトから管理用の API を呼ぶためのキーです。キーはあなたに紐づき、範囲に選んだワークスペースで、選んだ権限までの操作ができます。メンバーの招待やキーの発行など、人とアクセス権の操作はキーではできません(この管理画面から行います)。
      </p>
      {/* 発行のフォームと結果のカードを 1 つの範囲で包む(B173 第 2 段)。発行で入れ替わっても範囲は消えないので、発行の覆いは読み直しの反映
          (一覧の新しい行)まで続く。結果を出している間は、控えずに離れる前の確認(PageLeaveGuard。リンク・ログアウト・再読み込み・戻る・進む)を掛ける */}
      <BusyScope id="issue-key" prompt={issued ? "issuedKey" : undefined}>
        {issued ? (
          <IssuedKey issued={issued} onClose={() => setIssued(null)} />
        ) : (
          <IssueKeyForm
            workspaces={workspaces}
            amInstanceAdmin={amInstanceAdmin}
            onIssued={(k) => {
              setIssued(k);
              setHighlight(k.id);
            }}
          />
        )}
      </BusyScope>
      <div className="row" style={{ alignItems: "baseline" }}>
        <h2>発行済みのキー</h2>
        <span className="muted">{active.length} 件</span>
      </div>
      {/* キーの一覧のカードを覆う(B173 第 2 段)。発行の範囲(issue-key)とは別の範囲 */}
      <BusyScope id="api-keys-list">
        <ApiKeysList active={active} workspaces={workspaces} amInstanceAdmin={amInstanceAdmin} highlight={highlight} />
      </BusyScope>
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
                <AppLink href={`/w/${w.id}/api-keys`}>{w.name} のメンバーの API キー</AppLink>
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

/** 有効なキーの一覧のカード。失効の結果はカードの先頭に 1 行で出す(失効した行は失効済みの表へ移る) */
function ApiKeysList({ active, workspaces, amInstanceAdmin, highlight }: { active: ApiKey[]; workspaces: Workspace[]; amInstanceAdmin: boolean; highlight: string | null }) {
  // 確認は範囲の中で開く(確認の持ち主をこの範囲にする)
  const ask = useConfirm();
  const { run } = useBusyAction();
  const { notice, show, clear } = useBusyNotice();

  async function revoke(k: ApiKey) {
    clear();
    const outcome = await run({
      label: "失効中…",
      // 押し間違いで失効しないよう確認する(失効は取り消せない)
      confirm: () =>
        ask({
          title: `キー「${k.name}」を失効しますか?`,
          body:
            k.scope === "full"
              ? "「すべてのワークスペース」のキーです。どのワークスペースでも使えなくなり、元に戻せません"
              : "このキーを使っているエージェントやスクリプトは使えなくなり、元に戻せません",
          confirmLabel: "失効する",
        }),
      write: (signal) => api("DELETE", `/me/api-keys/${k.id}`, undefined, { signal }),
      after: "refresh",
    });
    show(outcome, "失効させました");
  }

  return (
    <div className="card-flush" data-testid="api-keys-list">
      <CardNotice notice={notice} />
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
                <button className="btn btn-danger" onClick={() => void revoke(k)}>
                  失効
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
