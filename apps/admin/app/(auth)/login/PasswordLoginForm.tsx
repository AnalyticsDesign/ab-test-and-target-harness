"use client";
import { useHydrated } from "@/lib/use-hydrated";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/Field";
import { ErrorBox } from "@/components/ErrorBox";
import { SubmitButton } from "@/components/SubmitButton";
import { browserVersionHeaders } from "@/lib/client";

export function PasswordLoginForm() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/session/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...browserVersionHeaders() },
      body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
    });
    setBusy(false);
    if (!res.ok) {
      // 封筒の message / hint をそのまま出す(429 rate_limited なども正しい文言になる)
      const d = (await res.json().catch(() => null)) as { message?: string; hint?: string } | null;
      setError([d?.message, d?.hint].filter(Boolean).join(" ") || "メールアドレスかパスワードが違います");
      return;
    }
    router.push("/w");
  }
  return (
    // 枠はこのフォームを載せるログイン画面の card が持つ(入れ子にしない)
    <form method="post" onSubmit={onSubmit}>
      <h2>非常用: メールアドレスとパスワード</h2>
      <Field label="メールアドレス">
        <input name="email" type="email" required autoComplete="username" />
      </Field>
      <Field label="パスワード">
        <input name="password" type="password" required autoComplete="current-password" />
      </Field>
      <ErrorBox message={error} />
      <SubmitButton busy={busy} disabled={!hydrated}>ログイン</SubmitButton>
      <p className="muted">この欄は非常時だけ表示されます。用が済んだら control の非常用トークンを削除してください</p>
    </form>
  );
}
