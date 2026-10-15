"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, describeError, fieldErrors } from "@/lib/client";
import { Field } from "./Field";
import { ErrorBox } from "./ErrorBox";
import { SubmitButton } from "./SubmitButton";

/** 新しいワークスペース(システム管理者だけ。決定 54 (10))。ホームの「新しいワークスペース」は `?new=1` 付きで来るので、名前欄にフォーカスを移す(K18) */
export function WorkspaceCreateForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  return (
    <form
      id="new"
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setFields({});
        try {
          const { id } = await api<{ id: string }>("POST", "/workspaces", { name: new FormData(e.currentTarget).get("name") });
          router.push(`/w/${id}`); // K12: 作った直後にすること(サイトの追加・招待)はそのワークスペースの画面にある
        } catch (err) {
          setError(describeError(err));
          setFields(fieldErrors(err));
        } finally {
          setBusy(false);
        }
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
