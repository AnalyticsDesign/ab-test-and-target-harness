"use client";
import { useState } from "react";
import { api, describeError } from "@/lib/client";
import { Field } from "./Field";
import { PageMatchField } from "./PageMatchField";
import { DEFAULT_PAGE_MATCH, type PageMatchValue } from "@/lib/page-match";
import { ErrorBox } from "./ErrorBox";
import { SubmitButton } from "./SubmitButton";
import { KIND_HINT, KIND_JA, createButtonLabel } from "@/lib/experiment-kind";
import { experimentIdProblem } from "@/lib/slug-id";
import type { ExperimentKind } from "@wtt/core";
import { ExperimentIdField } from "./experiment/ExperimentIdField";

export function ExperimentCreateForm({ wid, sid }: { wid: string; sid: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [urlMatch, setUrlMatch] = useState<PageMatchValue>(DEFAULT_PAGE_MATCH);
  const [kind, setKind] = useState<ExperimentKind>("test");
  return (
    <form
      className="card"
      style={{ maxWidth: 640 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        // B37: new は新規作成の画面と重なるので使えない。B136: constructor も使えない(どちらも control が 422)。送る前に日本語で止める
        const idProblem = experimentIdProblem(String(fd.get("id") ?? ""));
        setIdError(idProblem);
        if (idProblem) return;
        setBusy(true);
        try {
          const exp = await api<{ id: string }>("POST", `/sites/${sid}/experiments`, { id: fd.get("id"), name: fd.get("name"), kind, urlMatch });
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
      <ExperimentIdField error={idError} onChange={() => setIdError(null)} />
      <Field label="名前(100 字以内)">
        <input name="name" required maxLength={100} />
      </Field>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: "0 0 14px", minWidth: 0 }}>
        <legend className="field-label" style={{ padding: 0 }}>種別</legend>
        {(["test", "single"] as const).map((k) => (
          <label key={k} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
            <span>
              {KIND_JA[k]}
              <span className="muted" style={{ display: "block" }}>{KIND_HINT[k]}</span>
            </span>
          </label>
        ))}
        <p className="muted">種別は作成後に変えられません。変えるときは、作成した後に「複製」で作り直します</p>
      </fieldset>
      <Field label="対象 URL" hint="このエクスペリエンスを動かすページ。ここに一致しないページでは、配信条件にかかわらず何もしません">
        <PageMatchField value={urlMatch} onChange={setUrlMatch} />
      </Field>
      <ErrorBox message={error} />
      <SubmitButton busy={busy}>{createButtonLabel(kind)}</SubmitButton>
    </form>
  );
}
