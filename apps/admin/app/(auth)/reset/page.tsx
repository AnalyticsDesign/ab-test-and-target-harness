"use client";
import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Field } from "@/components/Field";
import { ErrorBox } from "@/components/ErrorBox";
import { SubmitButton } from "@/components/SubmitButton";
import { resetErrorMessage } from "@/lib/reset-errors";

/** control の reset-link API が配る URL がこのページ(`/reset?token=…`)。token を control の `POST /auth/reset-password` に渡す(決定 35 (2)) */
export default function ResetPage() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error") ? "リンクが無効か期限切れです" : null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/control/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: fd.get("password") }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(resetErrorMessage(res.status, await res.json().catch(() => null)));
      return;
    }
    router.push("/login");
  }
  if (!token) return <ErrorBox message={error ?? "リンクが無効です。URL が途中で切れていないか確認してください(末尾までコピーして開く)"} />;
  return (
    <form onSubmit={onSubmit} className="card">
      <h1>パスワードの再設定</h1>
      <Field label="新しいパスワード(8 文字以上)">
        <input name="password" type="password" minLength={8} required autoComplete="new-password" />
      </Field>
      <ErrorBox message={error} />
      <SubmitButton busy={busy}>変更する</SubmitButton>
    </form>
  );
}
