"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/Field";
import { ErrorBox } from "@/components/ErrorBox";
import { SubmitButton } from "@/components/SubmitButton";
import type { InviteView } from "@/lib/invite-view";
import { roleLabel } from "@/lib/roles";

export function AcceptInviteForm({
  id,
  email,
  role,
  workspaceName,
  view,
  signedInEmail,
}: {
  id: string;
  email: string;
  role: string;
  workspaceName: string;
  view: InviteView;
  signedInEmail: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function accept(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/session/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string; message?: string; hint?: string } | null;
      // メール不一致だけは招待先のメールを添える(封筒の message にはそれが入らない)
      if (d?.error === "invitation_email_mismatch") setError(`ログイン中のアカウントのメールアドレスが招待(${email})と一致しません`);
      else setError([d?.message, d?.hint].filter(Boolean).join(" ") || "招待を受け付けられませんでした");
      return;
    }
    const { workspaceId } = (await res.json()) as { workspaceId: string };
    router.push(`/w/${workspaceId}`);
  }
  const googleHref = `/api/session/google?next=${encodeURIComponent(`/invite/${id}`)}`;
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h1>{workspaceName} への招待</h1>
      <p>
        <strong>{email}</strong> を <span className="badge">{roleLabel(role)}</span> として招待しています
      </p>
      {view === "sign-in" || view === "sign-in-or-password" ? (
        <div>
          <p className="muted">
            <strong>{email}</strong> の Google アカウントでログインしてください。ログイン後にこのページへ戻ります
          </p>
          <a className="btn btn-primary" href={googleHref}>
            Google でログインして参加
          </a>
          {view === "sign-in-or-password" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                void accept({ name: fd.get("name"), password: fd.get("password") });
              }}
            >
              <h2>非常用: パスワードでアカウントを作る</h2>
              <Field label="お名前">
                <input name="name" required />
              </Field>
              <Field label="パスワード(8 文字以上)">
                <input name="password" type="password" minLength={8} required />
              </Field>
              <ErrorBox message={error} />
              <SubmitButton busy={busy}>参加する</SubmitButton>
            </form>
          ) : null}
        </div>
      ) : view === "accept" ? (
        <div>
          <p className="muted">
            <strong>{signedInEmail}</strong> でログイン中
          </p>
          <ErrorBox message={error} />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void accept({})}>
            この招待を受ける
          </button>
        </div>
      ) : (
        <div>
          <p className="error-box">
            ログイン中のアカウント({signedInEmail})のメールアドレスが招待({email})と一致しません。いったんログアウトし、招待されたメールアドレスの
            Google アカウントでログインしてください
          </p>
          <form action="/api/session/logout" method="post">
            <button className="btn">ログアウト</button>
          </form>
        </div>
      )}
    </div>
  );
}
