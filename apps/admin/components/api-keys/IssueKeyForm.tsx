"use client";
import { useState } from "react";
import { capAfterScopeChange, capCeiling, capFromChoice, capOptions, EXPIRY_OPTIONS, expiresInDaysOf, expiryAt, formatDeadline, FULL_SCOPE, initialScope, issueMissing, scopeOptions, validChoice, type CapChoice, type ExpiryChoice } from "@/lib/api-keys";
import { api, describeError } from "@/lib/client";
import type { ApiKey, Workspace } from "@/lib/types";
import { Field } from "../Field";
import { ErrorBox } from "../ErrorBox";
import { Picker } from "../ui/Picker";

export type IssuedResult = ApiKey & { key: string };

/**
 * 「新しい API キーを発行」のカード(決定 54 (11)・B43)。項目は縦に並べ、それぞれに説明。名前・範囲・権限・有効期限の 4 つとも必須で、
 * そろうまで「発行する」は押せず、足りないものを横に出す。権限と有効期限は既定を未選択にする。権限は範囲を選ぶまで押せず、
 * 範囲を替えて選べなくなった権限は state から消す(範囲を戻してもよみがえらない)
 */
export function IssueKeyForm({ workspaces, amInstanceAdmin, onIssued }: { workspaces: Workspace[]; amInstanceAdmin: boolean; onIssued: (k: IssuedResult) => void }) {
  const scopes = scopeOptions(workspaces, amInstanceAdmin);
  const [name, setName] = useState("");
  const [chosenScope, setScope] = useState<string | null>(initialScope(scopes));
  const scope = validChoice(chosenScope, scopes.map((o) => o.value));
  const caps = capOptions(capCeiling(scope, workspaces));
  const [chosenCap, setCap] = useState<string | null>(null);
  // 画面の更新で選択肢が変わった場合(ワークスペースから外された等)も、表示と送信は今の選択肢で絞る
  const cap = validChoice(chosenCap, caps.map((o) => o.value));
  const [expiry, setExpiry] = useState<ExpiryChoice | null>(null);
  // 期限の目安は、選んだ時刻から数える(描画の中で時計を読まない。B44)。control は発行の時刻から数えるので数秒〜数分ずれ得る目安
  const [chosenAt, setChosenAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = issueMissing(name, scope, cap, expiry);
  const deadline = expiry === null || chosenAt === null ? null : expiryAt(expiry, chosenAt);
  async function issue() {
    if (missing || scope === null || cap === null || expiry === null) return;
    setBusy(true);
    setError(null);
    try {
      const k = await api<IssuedResult>("POST", "/me/api-keys", {
        name: name.trim(),
        workspaceId: scope === FULL_SCOPE ? null : scope,
        roleCap: capFromChoice(cap as CapChoice),
        expiresInDays: expiresInDaysOf(expiry), // 期限なしは送らない(undefined は JSON から落ちる)
      });
      onIssued(k);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-labelledby="issue-title">
      <h2 id="issue-title">新しい API キーを発行</h2>
      <p className="muted">発行したキーは 1 度だけ表示されます。用途ごとに分けて発行すると、不要になったときに個別に失効できます。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void issue();
        }}
      >
        <Field label="名前(必須)" hint="どこで何に使うキーかが分かる名前。一覧と、管理者が見るメンバーのキーの一覧に出ます。">
          <input name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例: Claude Code(下書きの作成)" autoComplete="off" />
        </Field>
        <Field label="範囲(必須)" group hint="キーで操作できるワークスペース。">
          <Picker
            label="範囲"
            value={scope}
            options={scopes}
            placeholder="選んでください"
            onChange={(next) => {
              setScope(next);
              setCap((c) => capAfterScopeChange(c, next, workspaces)); // r1 CX-Medium-2
            }}
          />
        </Field>
        <Field
          label="権限(必須)"
          group
          hint="キーでできる操作。あなたのロールを超えることはなく、あなたのロールが下がるとキーの権限も下がります。必要な分だけを選んでください(例: 下書きだけ作らせるなら「編集者」、集計だけなら「閲覧者」)。"
        >
          <Picker label="権限" value={cap} options={caps} disabled={scope === null} placeholder={scope === null ? "先に範囲を選んでください" : "選んでください"} onChange={setCap} />
        </Field>
        <Field label="有効期限(必須)" group hint="期限を過ぎると使えなくなります。更新や確認のためだけに使うキーは「1 日」にしてください。期限は発行した時刻から数えます。">
          <div className="row">
            <Picker label="有効期限" value={expiry} options={EXPIRY_OPTIONS} placeholder="選んでください" onChange={(v) => {
                setExpiry(v as ExpiryChoice);
                setChosenAt(Date.now()); // イベントの中で読む(描画の中ではない)
              }}
            />
            {expiry === null ? null : (
              <span className="muted" data-testid="expiry-preview">
                {deadline === null ? "期限なし" : `${formatDeadline(deadline)} まで`}
              </span>
            )}
          </div>
        </Field>
        <ErrorBox message={error} />
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy || missing !== null}>
            発行する
          </button>
          <span className="muted" aria-live="polite">
            {missing ?? ""}
          </span>
        </div>
      </form>
    </section>
  );
}
