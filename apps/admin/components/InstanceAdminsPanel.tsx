"use client";
import { useHydrated } from "@/lib/use-hydrated";
import { useState } from "react";
import { useConfirm, useConfirmWithOption } from "@/components/ConfirmProvider";
import { api } from "@/lib/client";
import { candidateItems, validChoice } from "@/lib/api-keys";
import { demotionConfirmBody, fullRemovalConfirmBody, offersFullRemoval } from "@/lib/instance-admins";
import type { InstanceAdmin, InstanceAdminCandidate } from "@/lib/types";
import { Combo } from "./ui/Combo";
import { SubmitButton } from "./SubmitButton";
import { PageHeader } from "./ui/PageHeader";
import { navigateDocument } from "@/lib/navigate";
import { BusyScope, useBusyAction } from "./ui/BusyScope";
import { CardNotice, useBusyNotice } from "./ui/BusyNotice";

/**
 * B36 / 決定 53: システム管理者の一覧・追加・外す。追加はワークスペースのメンバーから選ぶ(B41 (2)。招待は作らない)。
 * `candidates` が null = 候補を取得できなかった(追加のフォームの代わりに案内を出す)。
 * 最後の 1 人は外せない(ボタンを無効にし、control も 409 で断る)。外すと、システム管理者になる前に参加していたワークスペースでは元のロールに戻り、それ以外のワークスペースからは外れる(B46)。
 * 自分を外したときは、戻るワークスペースも有効な招待も無ければログイン状態も切れ、次の画面の更新でログイン画面に戻る。
 * 一覧のカードと追加のフォームを 1 つの範囲(BusyScope)で覆う(B173 第 2 段)。追加・外すの結果は一覧のカードの先頭に 1 行で出す。
 * 自分を外すときは、全画面で /w へ移り終えるまで覆い続けて押し直せなくする
 */
export function InstanceAdminsPanel({
  admins,
  candidates,
  workspaces,
  myUserId,
}: {
  admins: InstanceAdmin[];
  candidates: InstanceAdminCandidate[] | null;
  /** 外れる側の名前を確認に出すための全ワークスペース。null = 取得できなかった */
  workspaces: Array<{ id: string; name: string }> | null;
  myUserId: string;
}) {
  return (
    <div>
      <PageHeader title="システム管理者" />
      <p className="muted">
        システム管理者は、この導入のすべてのワークスペースのオーナーを兼ね、新しいワークスペースを作れます。誰も管理できない状態を避けるため、2 人以上にしておくことをおすすめします。外すと、システム管理者になる前に参加していたワークスペースでは元のロールに戻ります。
      </p>
      <BusyScope id="instance-admins">
        <InstanceAdminsBody admins={admins} candidates={candidates} workspaces={workspaces} myUserId={myUserId} />
      </BusyScope>
    </div>
  );
}

/**
 * 一覧のカードと追加のフォーム(範囲の中)。外す前に確認を出す(記録のある人だけ、元のロールに戻さず完全に外すチェックボックスを出す)。
 * 自分を外すときは DELETE の後に全画面で /w へ移る(同じ画面を描き直すと「この画面はシステム管理者だけが開けます」になる。B46)。
 * ほかの人を外す・追加は、読み直しの反映まで覆う
 */
function InstanceAdminsBody({
  admins,
  candidates,
  workspaces,
  myUserId,
}: {
  admins: InstanceAdmin[];
  candidates: InstanceAdminCandidate[] | null;
  workspaces: Array<{ id: string; name: string }> | null;
  myUserId: string;
}) {
  const hydrated = useHydrated();
  // 確認は範囲の中で開く(確認の持ち主をこの範囲にする)
  const ask = useConfirm();
  const askWithOption = useConfirmWithOption();
  const { run } = useBusyAction();
  const { notice, show, clear, clearStatus } = useBusyNotice();
  const [chosen, setPicked] = useState<string | null>(null);
  // 画面の更新で候補から消えた人(別の人が先に追加した等)は未選択に戻し、押しても何も起きない状態にしない
  const picked = validChoice(chosen, (candidates ?? []).map((c) => c.userId));
  const last = admins.length <= 1;

  /** 外す確認。B46 K12: 記録のある人だけ、元のロールに戻さず完全に外すチェックボックスを出す(記録の無い人はどちらでも全部外れる)。
   * チェックを入れたら本文を目立つ注意に差し替え(自分ならログアウトも)、ボタンも結果を表す文言にする(2026-10-06 ユーザー決定) */
  const confirmRemoval = async (a: InstanceAdmin, self: boolean) => {
    const options = {
      title: self ? "自分をシステム管理者から外しますか?" : `${a.email} をシステム管理者から外しますか?`,
      body: demotionConfirmBody(a, self, workspaces),
      confirmLabel: "外す",
    };
    return offersFullRemoval(a)
      ? await askWithOption({
          ...options,
          option: {
            label: "元のロールに戻さず、すべてのワークスペースから外す",
            checkedBody: fullRemovalConfirmBody(self, workspaces),
            checkedConfirmLabel: "すべてから外す",
          },
        })
      : { confirmed: await ask(options), optionChecked: false };
  };

  const remove = async (a: InstanceAdmin) => {
    const self = a.userId === myUserId;
    clear();
    let optionChecked = false;
    const confirm = async () => {
      const r = await confirmRemoval(a, self);
      optionChecked = r.optionChecked;
      return r.confirmed;
    };
    // B46 K11: チェックを入れたら元のロールに戻さず、すべてのワークスペースから外す
    const write = (signal: AbortSignal) => api("DELETE", `/instance-admins/${a.userId}${optionChecked ? "?restore=false" : ""}`, undefined, { signal });
    const outcome = self
      ? // B46: 全画面で /w へ(完全に外したときも同じ)。移り終えるまで覆いと実行権を保つ
        await run({ label: "削除中…", confirm, write, after: "navigate", navigate: () => navigateDocument("/w") })
      : await run({ label: "削除中…", confirm, write, after: "refresh" });
    // 自分を外して移り終えなかった(navigated)ときは何も出さない(打ち切りの文は範囲が出す)
    show(outcome, self ? null : "外しました");
  };

  const add = async (target: InstanceAdminCandidate) => {
    clear();
    const outcome = await run({
      label: "追加中…",
      write: (signal) => api("POST", "/instance-admins", { email: target.email }, { signal }),
      onWritten: () => setPicked(null),
      after: "refresh",
    });
    show(outcome, "追加しました");
  };

  // 書き込みの間は範囲の覆い(inert)で押せないので、busy では無効にしない
  return (
    <>
      <div className="card-flush" data-testid="instance-admins-list">
        <CardNotice notice={notice} />
        <table data-testid="instance-admins">
          <thead>
            <tr>
              <th>名前</th>
              <th>メール</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.userId}>
                <td>{a.name}</td>
                <td>{a.email}</td>
                <td>
                  <button className="btn btn-danger" disabled={last} title={last ? "最後のシステム管理者は外せません" : undefined} onClick={() => void remove(a)}>
                    システム管理者から外す
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form method="post"
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          const target = candidates?.find((c) => c.userId === picked);
          if (target) void add(target);
        }}
      >
        <h2>システム管理者を追加</h2>
        <p className="muted">ワークスペースのメンバーから選びます。まだメンバーでない人は、先にワークスペースへ招待して受諾してもらってください。追加した人は、すべてのワークスペースのオーナーになります。</p>
        {candidates === null ? (
          <p className="error-box">追加できるメンバーの一覧を取得できませんでした。時間をおいて開き直してください</p>
        ) : (
          <>
            {/* Combo は listbox を持つので label で包まない(選択肢のクリックが input に転送されないように) */}
            <div className="field">
              <span className="field-label">追加するメンバー</span>
              <Combo
                label="追加するメンバー"
                value={picked}
                items={candidateItems(candidates)}
                // 選び直したら前の「追加しました」を消す(Combo の選択はフォームの onChange に頼らない。最終レビュー M2)
                onChange={(v) => {
                  setPicked(v);
                  clearStatus();
                }}
                disabled={candidates.length === 0}
                placeholder={candidates.length === 0 ? "追加できるメンバーがいません" : `名前・メールで絞り込む(${candidates.length} 人)`}
              />
            </div>
            {candidates.length === 0 ? <p className="muted">先にワークスペースへ招待し、受諾してもらってください。</p> : null}
            <SubmitButton busy={false} disabled={!hydrated || picked === null}>
              システム管理者にする
            </SubmitButton>
          </>
        )}
      </form>
    </>
  );
}
