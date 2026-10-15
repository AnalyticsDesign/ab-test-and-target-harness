"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, describeError, fieldErrors } from "@/lib/client";
import { expiryLabel } from "@/lib/invitation-expiry";
import { invitationResultCopy, resetLinkCopy, type IssuedLinkCopy } from "@/lib/issued-link";
import { formatLocalTime } from "@/lib/local-time";
import { roleLabel } from "@/lib/roles";
import type { Invitation, InvitationResult, Member, Role } from "@/lib/types";
import { Field } from "./Field";
import { ErrorBox } from "./ErrorBox";
import { useNow } from "./LocalTime";
import { SubmitButton } from "./SubmitButton";
import { IssuedCard } from "./ui/IssuedCard";
import { PageHeader } from "./ui/PageHeader";
import { Picker } from "./ui/Picker";

/** 招待のロールの説明(ロール名は roleLabel) */
const ROLE_HINT: Record<Role, string> = {
  owner: "サイトの削除まで",
  admin: "サイトの設定・公開・メンバーの管理",
  editor: "エクスペリエンスの作成・編集(コードの変更を含む。公開はできない)",
  viewer: "閲覧のみ",
};

/** 期限の表示(見ている人のタイムゾーン。秒は出さない)。例: `9/25 14:30` */
const deadline = (at: number): string => formatLocalTime(at, "deadline");

/** 招待リンク・リセットリンクの発行結果(B47)。API キーと同じ形のカードで、移動の確認は付けない(文言と理由は lib/issued-link.ts) */
function IssuedLinkCard({ testId, copy, url, closeLabel, onClose }: { testId: string; copy: IssuedLinkCopy; url: string; closeLabel: string; onClose: () => void }) {
  return (
    <IssuedCard title={copy.title} testId={testId} notice={copy.notice} code={url} copyLabel="リンクをコピー" closeLabel={closeLabel} onClose={onClose}>
      <p>{copy.lead}</p>
    </IssuedCard>
  );
}

export function MembersPanel({
  workspaceId,
  myRole,
  myUserId,
  members,
  invitations,
  canIssueResetLink,
  amInstanceAdmin,
}: {
  workspaceId: string;
  myRole: Role;
  myUserId: string;
  members: Member[];
  invitations: Invitation[];
  canIssueResetLink: boolean;
  amInstanceAdmin: boolean;
}) {
  const router = useRouter();
  const ask = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteFields, setInviteFields] = useState<Record<string, string>>({});
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [issued, setIssued] = useState<{ email: string; url: string; extended: boolean; expiresAt: number } | null>(null);
  const [resetLink, setResetLink] = useState<{ email: string; url: string } | null>(null);
  // 残り時間はブラウザの時計で出す(サーバー側の描画で Date.now() を焼き込むとハイドレーションで食い違う)。
  // 開いたままでも残りが古びないよう 60 秒ごとに進める(最初の描画は null のまま = サーバー側と同じ)
  const now = useNow(60_000);
  /**
   * 招待の発行。同じメール・同じ Role で呼ぶと control が既存のリンクの期限を延ばして `extended: true` を返す
   * (リンクは変わらない)。違う Role のときは 409 で断られ、その message / hint が上のエラー枠に出る
   */
  async function issue(email: string, role: string) {
    const r = await api<InvitationResult>("POST", `/workspaces/${workspaceId}/invitations`, { email, role });
    setIssued({ email, url: r.url, extended: r.extended, expiresAt: r.expiresAt });
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  /**
   * 招待まわりの操作(発行 / 期限を延ばす・発行し直す / 取り消す)専用の実行ヘルパ(B28)。
   * エラーはページ上部の ErrorBox ではなく、フォームのすぐ下の inviteError に出す。
   * 開始時に古い issued(「延ばしました」箱)を必ず消すので、失敗した操作が古い成功結果を残さない
   */
  async function runInvite(fn: () => Promise<void>) {
    setBusy(true);
    setInviteError(null);
    setIssued(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setInviteError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <PageHeader title="メンバー" />
      <ErrorBox message={error} />
      <div className="card-flush has-menu">
        <table data-testid="members">
          <thead>
            <tr>
              <th>名前</th>
              <th>メール</th>
              <th>ロール</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.memberId}>
                <td>
                  {m.name}
                  {m.instanceAdmin ? (
                    <>
                      {" "}
                      <span className="badge" title="すべてのワークスペースのオーナーを兼ねます">
                        システム管理者
                      </span>
                    </>
                  ) : null}
                </td>
                <td>{m.email}</td>
                <td title={m.instanceAdmin ? "システム管理者のロールは、設定 > システム管理者 から外すときだけ変わります" : undefined}>
                  <Picker
                    label={`${m.name} のロール`}
                    value={m.role}
                    disabled={busy || m.userId === myUserId || (m.role === "owner" && myRole !== "owner") || m.instanceAdmin}
                    options={(["owner", "admin", "editor", "viewer"] as Role[]).map((r) => ({ value: r, label: roleLabel(r), disabled: r === "owner" && myRole !== "owner" }))}
                    onChange={async (role) => {
                      // 選んだ瞬間に反映されるので、押し間違いで権限が変わらないよう確認する(B45)
                      const next = role as Role;
                      const ok = await ask({
                        title: `${m.name} のロールを変更しますか?`,
                        body: `${m.email} のロールを「${roleLabel(m.role)}」から「${roleLabel(next)}」に変更します`,
                        confirmLabel: "変更する",
                        tone: "primary",
                      });
                      if (ok) await run(() => api("PATCH", `/workspaces/${workspaceId}/members/${m.memberId}`, { role }));
                    }}
                  />
                </td>
                <td><div className="actions">
                  {canIssueResetLink ? (
                    <button
                      className="btn"
                      disabled={busy || (m.role === "owner" && myRole !== "owner") || (m.instanceAdmin && !amInstanceAdmin)}
                      title={m.instanceAdmin && !amInstanceAdmin ? "システム管理者のリセットリンクは、システム管理者だけが発行できます" : undefined}
                      onClick={() =>
                        run(async () => {
                          const { url } = await api<{ url: string }>("POST", `/workspaces/${workspaceId}/members/${m.memberId}/reset-link`);
                          setResetLink({ email: m.email, url });
                        })
                      }
                    >
                      リセットリンク
                    </button>
                  ) : null}
                  {m.userId !== myUserId && !m.instanceAdmin ? (
                    <button
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={async () => {
                        const ok = await ask({ title: `${m.email} を外しますか?`, body: "このワークスペースに入れなくなります。戻すときは招待し直します", confirmLabel: "外す" });
                        if (ok) await run(() => api("DELETE", `/workspaces/${workspaceId}/members/${m.memberId}`));
                      }}
                    >
                      外す
                    </button>
                  ) : null}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {resetLink ? <IssuedLinkCard key={resetLink.url} testId="issued-reset-link" copy={resetLinkCopy(resetLink.email)} url={resetLink.url} closeLabel="控えたので閉じる" onClose={() => setResetLink(null)} /> : null}
      <h2>招待</h2>
      <div className="invite-section">
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            setInviteFields({});
            runInvite(async () => {
              try {
                await issue(String(fd.get("email")), String(fd.get("role")));
              } catch (err) {
                setInviteFields(fieldErrors(err));
                throw err;
              }
            });
          }}
        >
          <Field label="メールアドレス" error={inviteFields.email}>
            <input name="email" type="email" required />
          </Field>
          <Field
            label="ロール"
            group
            error={inviteFields.role}
            hint="境界は「作成」と「本番化」です。編集者はコードの変更を含むあらゆる下書きを作れますが、訪問者に届く操作(公開・開始・一時停止・終了)は管理者以上だけです"
          >
            <Picker
              label="ロール"
              name="role"
              value={inviteRole}
              options={(["admin", "editor", "viewer"] as Role[]).map((r) => ({ value: r, label: roleLabel(r), hint: ROLE_HINT[r] }))}
              onChange={(v) => setInviteRole(v as Role)}
            />
          </Field>
          <SubmitButton busy={busy}>招待リンクを発行</SubmitButton>
        </form>
        <ErrorBox message={inviteError} />
        {/* 結果はフォームを置き換えずに下へ出す。リンクは招待中の一覧に出続けるので、API キーと違い次の招待を止めない(B47 (a)) */}
        {issued ? (
          <IssuedLinkCard
            testId="issued-invite"
            copy={invitationResultCopy({ email: issued.email, deadline: deadline(issued.expiresAt), extended: issued.extended })}
            url={issued.url}
            closeLabel="閉じる"
            onClose={() => setIssued(null)}
          />
        ) : null}
      </div>
      {invitations.length > 0 ? (
        <div className="card-flush">
          <table>
            <thead>
              <tr>
                <th>メール</th>
                <th className="nowrap">ロール</th>
                <th className="nowrap">期限</th>
                <th>リンク</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  {/* role は Better Auth 側で null になり得る(lib/types.ts) */}
                  <td className="nowrap">{i.role ? roleLabel(i.role) : "-"}</td>
                  {/* 残りはブラウザの時計で描く(サーバー側では出さない。ハイドレーションの食い違いを避ける) */}
                  <td className="nowrap">{now === null ? null : `${deadline(i.expiresAt)} まで(${expiryLabel(i.expiresAt, now)})`}</td>
                  <td className="break-anywhere">
                    <code>{i.url}</code>
                  </td>
                  <td><div className="actions">
                    {i.role ? (
                      <button className="btn" disabled={busy} onClick={() => runInvite(() => issue(i.email, i.role!))}>
                        {/* 期限切れの行では新しいリンクになる(Better Auth は未失効の招待だけを延長する) */}
                        {now !== null && i.expiresAt <= now ? "発行し直す" : "期限を延ばす"}
                      </button>
                    ) : null}
                    <button
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={async () => {
                        const ok = await ask({ title: `${i.email} への招待を取り消しますか?`, body: "このリンクは使えなくなります", confirmLabel: "招待を取り消す" });
                        if (ok)
                          await runInvite(async () => {
                            await api("DELETE", `/workspaces/${workspaceId}/invitations/${i.id}`);
                          });
                      }}
                    >
                      取り消す
                    </button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
