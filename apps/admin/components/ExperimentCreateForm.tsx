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
import { navigateDocument } from "@/lib/navigate";
import { BusyScope, useBusyAction } from "./ui/BusyScope";

/** 作成の応答が 30 秒で分からなかったとき */
const CREATE_UNKNOWN = "作成できたか分かりません。再読み込みして確かめてください";

/**
 * 新しいエクスペリエンス。作成の POST から移った先の画面が開くまで、フォームのカードを覆って押し直せなくする(B173 第 2 段。二重の作成を止める)
 */
export function ExperimentCreateForm({ wid, sid }: { wid: string; sid: string }) {
  return (
    <BusyScope id="experiment-create">
      <ExperimentCreateFormBody wid={wid} sid={sid} />
    </BusyScope>
  );
}

function ExperimentCreateFormBody({ wid, sid }: { wid: string; sid: string }) {
  const { busy, run } = useBusyAction();
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
        const body = { id: fd.get("id"), name: fd.get("name"), kind, urlMatch };
        const outcome = await run({
          label: "作成中…",
          write: (signal) => api<{ id: string }>("POST", `/sites/${sid}/experiments`, body, { signal }),
          // クライアント遷移(router.push)は共有 layout(上部バーの「未公開の変更あり」)を描き直さず、
          // router.refresh() を足しても確実には反映されない(このバージョンの Next.js/vinext で実測)ため、全画面の遷移にする。
          // 移った先が開くまで覆いと実行権を保つ(移動の間に押せる状態に戻ると、二度目の作成になるため)
          after: "navigate",
          navigate: (exp) => navigateDocument(`/w/${wid}/sites/${sid}/experiments/${exp.id}`),
        });
        if (outcome.kind === "failed") setError(describeError(outcome.error));
        else if (outcome.kind === "unknown") setError(CREATE_UNKNOWN);
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
