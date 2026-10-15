"use client";
import { useState } from "react";
import { api, describeError, fieldErrors } from "@/lib/client";
import type { Site } from "@/lib/types";
import { Field } from "./Field";
import { ErrorBox } from "./ErrorBox";
import { SubmitButton } from "./SubmitButton";
import { Picker } from "./ui/Picker";

export function SiteCreateForm({ workspaceId }: { workspaceId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [mode, setMode] = useState("A");
  const [consent, setConsent] = useState("implicit");
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setFields({});
        const fd = new FormData(e.currentTarget);
        const body: Record<string, unknown> = { name: fd.get("name"), domain: String(fd.get("domain")).toLowerCase(), mode: fd.get("mode"), consentMode: fd.get("consentMode") };
        if (fd.get("id")) body.id = fd.get("id");
        try {
          const s = await api<Site>("POST", `/workspaces/${workspaceId}/sites`, body);
          // クライアント遷移(router.push)は共有 layout(サイドバーの Site 一覧)を描き直さず、
          // router.refresh() を足しても確実には反映されない(このバージョンの Next.js/vinext で実測)ため、全画面の遷移にする
          window.location.assign(`/w/${workspaceId}/sites/${s.id}`);
        } catch (err) {
          setError(describeError(err));
          setFields(fieldErrors(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>新しいサイト</h2>
      <Field label="名前" error={fields.name}>
        <input name="name" required />
      </Field>
      <Field label="ドメイン(ホスト名)" hint="受け付けるサイトのアドレス(Origin)の初期値(https://<ドメイン>)になります" error={fields.domain}>
        <input name="domain" required pattern="[a-z0-9.\-]+" placeholder="www.example.com" />
      </Field>
      <Field label="サイト ID(任意)" hint="タグの URL(/s/<サイト ID>.js)になります。既存タグを引き継ぐ場合はその ID を指定します。作成後は変更できません" error={fields.id}>
        <input name="id" pattern="[A-Za-z0-9_\-]{1,64}" placeholder="site_example" />
      </Field>
      <Field label="導入の形" group error={fields.mode}>
        <Picker
          label="導入の形"
          name="mode"
          value={mode}
          options={[
            { value: "A", label: "A: JS Cookie(タグ 1 本)" },
            { value: "B", label: "D-lite: 同一ゾーンの Workers Route(サイトが Cloudflare 配下のとき)" },
          ]}
          onChange={setMode}
        />
      </Field>
      <Field label="同意の扱い" group hint="EU など、訪問者の同意が必要なサイトでは「訪問者が同意するまで動かさない」を選びます(同意の受け渡しはサイト導入ガイドの 7 節)" error={fields.consentMode}>
        <Picker
          label="同意の扱い"
          name="consentMode"
          value={consent}
          options={[
            { value: "implicit", label: "同意を待たずに動かす(既定。同意管理ツールを使っていないサイト向け)" },
            { value: "required", label: "訪問者が同意するまで動かさない(同意管理ツールから同意が届くまで、割り当ても計測もしない)" },
          ]}
          onChange={setConsent}
        />
      </Field>
      <ErrorBox message={error} />
      <SubmitButton busy={busy}>作成</SubmitButton>
    </form>
  );
}
