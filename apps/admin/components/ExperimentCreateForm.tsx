"use client";
import { useState } from "react";
import { api, describeError } from "@/lib/client";
import { Field } from "./Field";
import { PageMatchField } from "./PageMatchField";
import { DEFAULT_PAGE_MATCH, type PageMatchValue } from "@/lib/page-match";
import { ErrorBox } from "./ErrorBox";
import { SubmitButton } from "./SubmitButton";

export function ExperimentCreateForm({ wid, sid }: { wid: string; sid: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlMatch, setUrlMatch] = useState<PageMatchValue>(DEFAULT_PAGE_MATCH);
  return (
    <form
      className="card"
      style={{ maxWidth: 640 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const fd = new FormData(e.currentTarget);
        try {
          const exp = await api<{ id: string }>("POST", `/sites/${sid}/experiments`, { id: fd.get("id"), name: fd.get("name"), urlMatch });
          // クライアント遷移(router.push)は共有 layout(上部バーの「未公開の変更あり」)を描き直さず、
          // router.refresh() を足しても確実には反映されない(このバージョンの Next.js/vinext で実測)ため、全画面の遷移にする
          window.location.assign(`/w/${wid}/sites/${sid}/experiments/${exp.id}`);
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>新しいエクスペリエンス</h1>
      <Field label="エクスペリエンス ID(スラッグ)" hint="GA4 の experimentId としてそのまま送られます。割当ハッシュの入力でもあるため作成後は変更できません">
        <input name="id" required pattern="[a-z0-9][a-z0-9_\-]{0,63}" placeholder="exp_hero_copy" />
      </Field>
      <Field label="名前(100 字以内)">
        <input name="name" required maxLength={100} />
      </Field>
      <Field label="対象 URL" hint="このエクスペリエンスを動かすページ。ここに一致しないページでは、配信条件にかかわらず何もしません">
        <PageMatchField value={urlMatch} onChange={setUrlMatch} />
      </Field>
      <ErrorBox message={error} />
      <SubmitButton busy={busy}>作成(パターン A / B を 50:50 で用意します)</SubmitButton>
    </form>
  );
}
