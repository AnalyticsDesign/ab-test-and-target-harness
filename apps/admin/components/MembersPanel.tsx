"use client";
import { useHydrated } from "@/lib/use-hydrated";
import { useState } from "react";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, fieldErrors } from "@/lib/client";
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
import { BusyScope, useBusyAction } from "./ui/BusyScope";
import { CardNotice, useBusyNotice } from "./ui/BusyNotice";

/** 招待のロールの説明(ロール名は roleLabel) */
const ROLE_HINT: Record<Role, string> = {
  owner: "サイトの削除まで",
  admin: "サイト設定・公開・メンバーの管理",
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

/**
 * メンバーの画面(B173 第 2 段 Task 6)。メンバーの一覧のカードと、招待(発行のフォーム + 招待中の一覧)を別々の範囲(BusyScope)で覆う。
 * 別々の範囲なので、ロールの変更の間も招待は押せる。結果の文も範囲ごとに持つ
 */
export function MembersPanel({
  workspaceId,
  myRole,
  myUserId,
  members,
  invitations,
  canIssueResetLink,
  amInstanceAdmin,
  scopeText,
}: {
  workspaceId: string;
  myRole: Role;
  myUserId: string;
  members: Member[];
  invitations: Invitation[];
  canIssueResetLink: boolean;
  amInstanceAdmin: boolean;
  /** ロールが効く範囲の 1 文(lib/member-scope.ts)。PageHeader の下の 1 か所だけに出す */
  scopeText: string;
}) {
  const [resetLink, setResetLink] = useState<{ email: string; url: string } | null>(null);
  return (
    <div>
      <PageHeader title="メンバー" />
      <p className="muted" data-testid="member-scope">{scopeText}</p>
      <BusyScope id="members-list">
        <MembersList
          workspaceId={workspaceId}
          myRole={myRole}
          myUserId={myUserId}
          members={members}
          canIssueResetLink={canIssueResetLink}
          amInstanceAdmin={amInstanceAdmin}
          onResetLink={setResetLink}
        />
      </BusyScope>
      {resetLink ? <IssuedLinkCard key={resetLink.url} testId="issued-reset-link" copy={resetLinkCopy(resetLink.email)} url={resetLink.url} closeLabel="控えたので閉じる" onClose={() => setResetLink(null)} /> : null}
      <h2>招待</h2>
      <BusyScope id="members-invite">
        <Invitations workspaceId={workspaceId} invitations={invitations} />
      </BusyScope>
    </div>
  );
}

/** メンバーの一覧のカード。ロールの変更・外すの結果はカードの先頭に 1 行で出す。リセットリンクの結果は一覧の下の箱(onResetLink) */
function MembersList({
  workspaceId,
  myRole,
  myUserId,
  members,
  canIssueResetLink,
  amInstanceAdmin,
  onResetLink,
}: {
  workspaceId: string;
  myRole: Role;
  myUserId: string;
  members: Member[];
  canIssueResetLink: boolean;
  amInstanceAdmin: boolean;
  onResetLink: (link: { email: string; url: string }) => void;
}) {
  // 確認は範囲の中で開く(確認の持ち主をこの範囲にする)
  const ask = useConfirm();
  const { run } = useBusyAction();
  const { notice, show, clear } = useBusyNotice();

  async function changeRole(m: Member, next: Role) {
    clear();
    const outcome = await run({
      label: "変更中…",
      // 選んだ瞬間に反映されるので、押し間違いで権限が変わらないよう確認する(B45)
      confirm: () =>
        ask({
          title: `${m.name} のロールを変更しますか?`,
          body: `${m.email} のロールを「${roleLabel(m.role)}」から「${roleLabel(next)}」に変更します`,
          confirmLabel: "変更する",
          tone: "primary",
        }),
      write: (signal) => api("PATCH", `/workspaces/${workspaceId}/members/${m.memberId}`, { role: next }, { signal }),
      after: "refresh",
    });
    show(outcome, "ロールを変更しました");
  }

  async function issueResetLink(m: Member) {
    clear();
    const outcome = await run({
      label: "発行中…",
      write: (signal) => api<{ url: string }>("POST", `/workspaces/${workspaceId}/members/${m.memberId}/reset-link`, undefined, { signal }),
      onWritten: ({ url }) => onResetLink({ email: m.email, url }),
      // 一覧は変わらないので読み直さない。結果は一覧の下の箱
      after: "none",
    });
    show(outcome, null);
  }

  async function remove(m: Member) {
    clear();
    const outcome = await run({
      label: "削除中…",
      confirm: () => ask({ title: `${m.email} を外しますか?`, body: "このワークスペースに入れなくなります。戻すときは招待し直します", confirmLabel: "外す" }),
      write: (signal) => api("DELETE", `/workspaces/${workspaceId}/members/${m.memberId}`, undefined, { signal }),
      after: "refresh",
    });
    show(outcome, "外しました");
  }

  // 書き込みの間は範囲の覆い(inert)で押せないので、busy では無効にしない
  return (
    <div className="card-flush has-menu" data-testid="members-list">
      <CardNotice notice={notice} />
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
                  disabled={m.userId === myUserId || (m.role === "owner" && myRole !== "owner") || m.instanceAdmin}
                  options={(["owner", "admin", "editor", "viewer"] as Role[]).map((r) => ({ value: r, label: roleLabel(r), disabled: r === "owner" && myRole !== "owner" }))}
                  onChange={(role) => void changeRole(m, role as Role)}
                />
              </td>
              <td><div className="actions">
                {canIssueResetLink ? (
                  <button
                    className="btn"
                    disabled={(m.role === "owner" && myRole !== "owner") || (m.instanceAdmin && !amInstanceAdmin)}
                    title={m.instanceAdmin && !amInstanceAdmin ? "システム管理者のリセットリンクは、システム管理者だけが発行できます" : undefined}
                    onClick={() => void issueResetLink(m)}
                  >
                    リセットリンク
                  </button>
                ) : null}
                {m.userId !== myUserId && !m.instanceAdmin ? (
                  <button className="btn btn-danger" onClick={() => void remove(m)}>
                    外す
                  </button>
                ) : null}
              </div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 招待の範囲: 発行のフォームと招待中の一覧。発行・期限の延長の結果は今の箱(フォームの下)、失敗はフォームのすぐ下(B28)。
 * 取り消しの結果は招待中の一覧のカードの先頭。どの操作も、始めたときに古い発行の箱を消す(失敗した操作が古い成功の結果を残さない)
 */
function Invitations({ workspaceId, invitations }: { workspaceId: string; invitations: Invitation[] }) {
  const hydrated = useHydrated();
  const ask = useConfirm();
  const { run } = useBusyAction();
  const form = useBusyNotice();
  const list = useBusyNotice();
  const [inviteFields, setInviteFields] = useState<Record<string, string>>({});
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [issued, setIssued] = useState<{ email: string; url: string; extended: boolean; expiresAt: number } | null>(null);
  // 残り時間はブラウザの時計で出す(サーバー側の描画で Date.now() を焼き込むとハイドレーションで食い違う)。
  // 開いたままでも残りが古びないよう 60 秒ごとに進める(最初の描画は null のまま = サーバー側と同じ)
  const now = useNow(60_000);

  const start = () => {
    form.clear();
    list.clear();
    setIssued(null);
  };

  /**
   * 招待の発行。同じメール・同じ Role で呼ぶと control が既存のリンクの期限を延ばして `extended: true` を返す
   * (リンクは変わらない)。違う Role のときは 409 で断られ、その message / hint がフォームの下のエラー枠に出る
   */
  async function issue(email: string, role: string) {
    start();
    setInviteFields({});
    const outcome = await run({
      label: "招待中…",
      write: (signal) => api<InvitationResult>("POST", `/workspaces/${workspaceId}/invitations`, { email, role }, { signal }),
      after: "refresh",
    });
    // 結果の箱は覆いが外れてから出す(覆いの中は inert で、箱の見出しへフォーカスを移せないため)。
    // 読み直しを待ち切れなかったときも、発行は通っているので出す
    if (outcome.kind === "saved") setIssued({ email, url: outcome.value.url, extended: outcome.value.extended, expiresAt: outcome.value.expiresAt });
    else if (outcome.kind === "failed") setInviteFields(fieldErrors(outcome.error));
    form.show(outcome, null);
  }

  async function cancel(i: Invitation) {
    start();
    const outcome = await run({
      label: "削除中…",
      confirm: () => ask({ title: `${i.email} への招待を取り消しますか?`, body: "このリンクは使えなくなります", confirmLabel: "招待を取り消す" }),
      write: (signal) => api("DELETE", `/workspaces/${workspaceId}/invitations/${i.id}`, undefined, { signal }),
      after: "refresh",
    });
    list.show(outcome, "招待を取り消しました");
  }

  const hasListNotice = list.notice.status !== null || list.notice.error !== null;
  return (
    <>
      <div className="invite-section">
        <form
          method="post"
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            void issue(String(fd.get("email")), String(fd.get("role")));
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
          <SubmitButton busy={false} disabled={!hydrated}>招待リンクを発行</SubmitButton>
        </form>
        <ErrorBox message={form.notice.error} />
        {form.notice.status ? <p role="status">{form.notice.status}</p> : null}
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
      {/* 最後の招待を取り消した後も、結果の文を出すためにカードを残す */}
      {invitations.length > 0 || hasListNotice ? (
        <div className="card-flush" data-testid="invitations">
          <CardNotice notice={list.notice} />
          {invitations.length > 0 ? (
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
                        <button className="btn" onClick={() => void issue(i.email, i.role!)}>
                          {/* 期限切れの行では新しいリンクになる(Better Auth は未失効の招待だけを延長する) */}
                          {now !== null && i.expiresAt <= now ? "発行し直す" : "期限を延ばす"}
                        </button>
                      ) : null}
                      <button className="btn btn-danger" onClick={() => void cancel(i)}>
                        取り消す
                      </button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
