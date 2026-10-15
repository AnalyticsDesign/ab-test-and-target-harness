"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm, useConfirmWithOption } from "@/components/ConfirmProvider";
import { api, describeError } from "@/lib/client";
import { candidateItems, validChoice } from "@/lib/api-keys";
import { demotionConfirmBody, fullRemovalConfirmBody, offersFullRemoval } from "@/lib/instance-admins";
import type { InstanceAdmin, InstanceAdminCandidate } from "@/lib/types";
import { ErrorBox } from "./ErrorBox";
import { Combo } from "./ui/Combo";
import { SubmitButton } from "./SubmitButton";
import { PageHeader } from "./ui/PageHeader";

/**
 * B36 / 決定 53: システム管理者の一覧・追加・外す。追加はワークスペースのメンバーから選ぶ(B41 (2)。招待は作らない)。
 * `candidates` が null = 候補を取得できなかった(追加のフォームの代わりに案内を出す)。
 * 最後の 1 人は外せない(ボタンを無効にし、control も 409 で断る)。外すと、システム管理者になる前に参加していたワークスペースでは元のロールに戻り、それ以外のワークスペースからは外れる(B46)。
 * 自分を外したときは、戻るワークスペースも有効な招待も無ければログイン状態も切れ、次の画面の更新でログイン画面に戻る
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
  const router = useRouter();
  const ask = useConfirm();
  const askWithOption = useConfirmWithOption();
  const [chosen, setPicked] = useState<string | null>(null);
  // 画面の更新で候補から消えた人(別の人が先に追加した等)は未選択に戻し、押しても何も起きない状態にしない
  const picked = validChoice(chosen, (candidates ?? []).map((c) => c.userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>, afterSuccess: () => void = () => router.refresh()) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      afterSuccess();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  const last = admins.length <= 1;
  return (
    <div>
      <PageHeader title="システム管理者" />
      <p className="muted">
        システム管理者は、この導入のすべてのワークスペースのオーナーを兼ね、新しいワークスペースを作れます。誰も管理できない状態を避けるため、2 人以上にしておくことをおすすめします。外すと、システム管理者になる前に参加していたワークスペースでは元のロールに戻ります。
      </p>
      <ErrorBox message={error} />
      <div className="card-flush">
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
                  <button
                    className="btn btn-danger"
                    disabled={busy || last}
                    title={last ? "最後のシステム管理者は外せません" : undefined}
                    onClick={async () => {
                      const self = a.userId === myUserId;
                      const options = {
                        title: self ? "自分をシステム管理者から外しますか?" : `${a.email} をシステム管理者から外しますか?`,
                        body: demotionConfirmBody(a, self, workspaces),
                        confirmLabel: "外す",
                      };
                      // B46 K12: 記録のある人だけ、元のロールに戻さず完全に外すチェックボックスを出す(記録の無い人はどちらでも全部外れる)。
                      // チェックを入れたら本文を目立つ注意に差し替え(自分ならログアウトも)、ボタンも結果を表す文言にする(2026-10-06 ユーザー決定)
                      const { confirmed, optionChecked } = offersFullRemoval(a)
                        ? await askWithOption({
                            ...options,
                            option: {
                              label: "元のロールに戻さず、すべてのワークスペースから外す",
                              checkedBody: fullRemovalConfirmBody(self, workspaces),
                              checkedConfirmLabel: "すべてから外す",
                            },
                          })
                        : { confirmed: await ask(options), optionChecked: false };
                      if (confirmed)
                        await run(
                          // B46 K11: チェックを入れたら元のロールに戻さず、すべてのワークスペースから外す
                          () => api("DELETE", `/instance-admins/${a.userId}${optionChecked ? "?restore=false" : ""}`),
                          // B46: 自分を外したら全画面で /w へ(同じ画面を描き直すと「この画面はシステム管理者だけが開けます」になる)。完全に外したときも同じ
                          self ? () => window.location.assign("/w") : undefined,
                        );
                    }}
                  >
                    システム管理者から外す
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          const target = candidates?.find((c) => c.userId === picked);
          if (!target) return;
          void run(async () => {
            await api("POST", "/instance-admins", { email: target.email });
            setPicked(null);
          });
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
                onChange={setPicked}
                disabled={busy || candidates.length === 0}
                placeholder={candidates.length === 0 ? "追加できるメンバーがいません" : `名前・メールで絞り込む(${candidates.length} 人)`}
              />
            </div>
            {candidates.length === 0 ? <p className="muted">先にワークスペースへ招待し、受諾してもらってください。</p> : null}
            <SubmitButton busy={busy} disabled={picked === null}>
              システム管理者にする
            </SubmitButton>
          </>
        )}
      </form>
    </div>
  );
}
