"use client";
import { useState } from "react";
import { api, describeError, fieldErrors } from "@/lib/client";
import { Field } from "./Field";
import { ErrorBox } from "./ErrorBox";
import { SubmitButton } from "./SubmitButton";
import { navigateDocument } from "@/lib/navigate";
import { BusyScope, useBusyAction } from "./ui/BusyScope";

/** 作成の応答が 30 秒で分からなかったとき */
const CREATE_UNKNOWN = "作成できたか分かりません。再読み込みして確かめてください";

/**
 * 新しいワークスペース(システム管理者だけ。決定 54 (10))。ホームの「新しいワークスペース」は `?new=1` 付きで来るので、名前欄にフォーカスを移す(K18)。
 * 作成の POST から移った先の画面が開くまで、フォームのカードを覆って押し直せなくする(B173 第 2 段。二重の作成を止める)
 */
export function WorkspaceCreateForm({ autoFocus = false }: { autoFocus?: boolean }) {
  return (
    <BusyScope id="workspace-create">
      <WorkspaceCreateFormBody autoFocus={autoFocus} />
    </BusyScope>
  );
}

function WorkspaceCreateFormBody({ autoFocus }: { autoFocus: boolean }) {
  const { busy, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  return (
    <form
      id="new"
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setFields({});
        // 入力は送る前に読む(e.currentTarget は待った後には無い)
        const name = new FormData(e.currentTarget).get("name");
        const outcome = await run({
          label: "作成中…",
          write: (signal) => api<{ id: string }>("POST", "/workspaces", { name }, { signal }),
          // K12: 作った直後にすること(サイトの追加・招待)はそのワークスペースの画面にある。
          // クライアント遷移(router.push)は共有 layout(サイドバーの切り替えの一覧)を描き直さず、
          // router.refresh() を足しても確実には反映されない(このバージョンの Next.js/vinext で実測)ため、全画面の遷移にする。
          // 移った先が開くまで覆いと実行権を保つ(移動の間に押せる状態に戻ると、二度目の作成になるため)
          after: "navigate",
          navigate: ({ id }) => navigateDocument(`/w/${id}`),
        });
        if (outcome.kind === "failed") {
          setError(describeError(outcome.error));
          setFields(fieldErrors(outcome.error));
        } else if (outcome.kind === "unknown") setError(CREATE_UNKNOWN);
      }}
    >
      <h2>新しいワークスペース</h2>
      <Field label="名前" error={fields.name}>
        <input name="name" required placeholder="例: 採用広報" autoFocus={autoFocus} />
      </Field>
      <ErrorBox message={error} />
      <SubmitButton busy={busy}>作成</SubmitButton>
    </form>
  );
}
