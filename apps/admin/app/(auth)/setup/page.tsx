"use client";
import { useState } from "react";
import { Field } from "@/components/Field";
import { ErrorBox } from "@/components/ErrorBox";
import { SubmitButton } from "@/components/SubmitButton";

export default function SetupPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null); // 登録したメールアドレス
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/session/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(fd.entries())),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { message?: string; hint?: string } | null;
      setError([d?.message, d?.hint].filter(Boolean).join(" ") || "セットアップに失敗しました");
      return;
    }
    setDone(String(fd.get("email") ?? ""));
  }
  if (done) {
    return (
      <div className="card" style={{ maxWidth: 480 }}>
        <h1>セットアップが完了しました</h1>
        <p>
          <strong>{done}</strong> をオーナーとして登録しました。同じメールアドレスの Google アカウントでログインしてください
        </p>
        <a className="btn btn-primary" href="/api/session/google">
          Google でログイン
        </a>
        <p className="muted">
          control の <code>AB_SETUP_TOKEN</code> は忘れずに削除してください
        </p>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="card" style={{ maxWidth: 480 }}>
      <h1>初回セットアップ</h1>
      <p className="muted">
        control Worker の <code>AB_SETUP_TOKEN</code> を入力し、最初のオーナーとワークスペースを作ります。パスワードは決めません
        — ログインはオーナーのメールアドレスと同じ Google アカウントで行います。以後のユーザーは招待リンクで追加します
      </p>
      <Field label="セットアップトークン">
        <input name="setupToken" required />
      </Field>
      <Field label="ワークスペース名">
        <input name="workspaceName" required />
      </Field>
      <Field label="お名前">
        <input name="name" required />
      </Field>
      <Field label="メールアドレス">
        <input name="email" type="email" required />
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: "0 0 16px" }}>
        <legend>使用状況を見られる人</legend>
        <label style={{ display: "block" }}>
          <input type="radio" name="usageVisibility" value="members" defaultChecked /> すべてのメンバー(ホームに Cloudflare の使用状況の要約が出ます)
        </label>
        <label style={{ display: "block" }}>
          <input type="radio" name="usageVisibility" value="instance_admins" /> システム管理者のみ
        </label>
        <p className="muted">後から 設定 &gt; システム &gt; Cloudflare 使用状況 で変えられます</p>
      </fieldset>
      <ErrorBox message={error} />
      <SubmitButton busy={busy}>オーナーを作成</SubmitButton>
    </form>
  );
}
