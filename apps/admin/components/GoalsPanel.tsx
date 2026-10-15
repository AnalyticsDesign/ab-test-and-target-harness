"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, describeError, fieldErrors } from "@/lib/client";
import type { Goal } from "@/lib/types";
import { Field } from "./Field";
import { PageMatchField } from "./PageMatchField";
import { DEFAULT_PAGE_MATCH, describePageMatch, type PageMatchValue } from "@/lib/page-match";
import { ErrorBox } from "./ErrorBox";
import { SubmitButton } from "./SubmitButton";
import { PageHeader } from "./ui/PageHeader";
import { Picker } from "./ui/Picker";

const GOAL_TYPES = [
  { value: "PAGEVIEW", label: "ページの表示(PAGEVIEW)" },
  { value: "CLICK", label: "クリック(CLICK)" },
  { value: "CUSTOM", label: "コードから送る(CUSTOM)" },
];
export function GoalsPanel({ siteId, goals, canEdit }: { siteId: string; goals: Goal[]; canEdit: boolean }) {
  const router = useRouter();
  const ask = useConfirm();
  const [type, setType] = useState<Goal["type"]>("PAGEVIEW");
  const [goalId, setGoalId] = useState(""); // CUSTOM の送り方の例に入れる
  const [page, setPage] = useState<PageMatchValue>(DEFAULT_PAGE_MATCH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(describeError(e));
      setFields(fieldErrors(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <PageHeader title="目標" />
      <p className="muted">
        目標はサイト単位です。達成するたびに <code>dataLayer</code> に <code>ab_conversion</code> が送られ、GTM から GA4 に送ると、エクスペリエンスのパターンごとに CV を比べられます。配信条件の「目標を達成した人」にも使えます。
        ページの表示は指定したページの読み込みごと、クリックはセレクタに一致する要素のクリックごとに達成になります(重複は除きません)。
        履歴条件(converted)を使うサイトでは <code>/event</code> にも転送され、訪問者プロフィールに達成回数が記録されます。名前は GA4 の <code>ab_goal_name</code> に載るため 100 字以内です
      </p>
      <ErrorBox message={error} />
      <div className="card-flush">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>名前</th>
              <th>種類</th>
              <th>設定</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {goals.map((g) => (
              <tr key={g.id}>
                <td>
                  <code>{g.id}</code>
                </td>
                <td>
                  {canEdit ? (
                    <input
                      defaultValue={g.name}
                      maxLength={100}
                      disabled={busy}
                      onBlur={(e) => e.target.value !== g.name && run(() => api("PATCH", `/sites/${siteId}/goals/${g.id}`, { name: e.target.value }))}
                    />
                  ) : (
                    g.name
                  )}
                </td>
                <td>{GOAL_TYPES.find((t) => t.value === g.type)?.label ?? g.type}</td>
                <td>{g.type === "PAGEVIEW" ? describePageMatch((g.config as { page: PageMatchValue }).page) : <code>{JSON.stringify(g.config)}</code>}</td>
                <td>{canEdit ? <button
                      className="btn"
                      disabled={busy}
                      onClick={async () => {
                        // 押した瞬間に消えるので確認する(B45)。配信条件などから参照されている目標は control が 409 で断る
                        const ok = await ask({ title: `目標「${g.name}」を削除しますか?`, body: "元に戻せません", confirmLabel: "削除する" });
                        if (ok) await run(() => api("DELETE", `/sites/${siteId}/goals/${g.id}`));
                      }}
                    >
                      削除
                    </button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit ? (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const form = e.currentTarget;
            const config = type === "PAGEVIEW" ? { page } : type === "CLICK" ? { selector: fd.get("selector") } : {};
            setFields({});
            run(async () => {
              await api("POST", `/sites/${siteId}/goals`, { id: fd.get("id"), name: fd.get("name"), type, config });
              form.reset();
              setGoalId("");
              setPage(DEFAULT_PAGE_MATCH);
            });
          }}
        >
          <h2>追加</h2>
          <Field label="ID(スラッグ)" error={fields.id}>
            <input name="id" required pattern="[a-z0-9][a-z0-9_\-]{0,63}" placeholder="g_purchase" onChange={(e) => setGoalId(e.target.value)} />
          </Field>
          <Field label="名前(100 字以内)" error={fields.name}>
            <input name="name" required maxLength={100} />
          </Field>
          <Field label="種類" group error={fields.type}>
            <Picker label="種類" value={type} options={GOAL_TYPES} onChange={(v) => setType(v as Goal["type"])} />
          </Field>
          {type === "PAGEVIEW" ? (
            <Field label="ページ" error={fields["config.page.value"] ?? fields["config.page.op"] ?? fields["config.page.part"]}>
              <PageMatchField value={page} onChange={setPage} />
            </Field>
          ) : null}
          {type === "CUSTOM" ? (
            <p className="muted" data-testid="custom-goal-hint">
              ページの表示やクリックでは捉えられない達成(フォームの送信の成功・動画の再生完了など)に使います。ツールは自動では検知しません。達成した瞬間に、サイトのコードか GTM のカスタム HTML のタグで{" "}
              <code>window.AB &amp;&amp; window.AB.track(&quot;{goalId || "<この目標の ID>"}&quot;)</code> を実行してください
            </p>
          ) : null}
          {type === "CLICK" ? (
            <Field label="セレクタ" error={fields["config.selector"]}>
              <input name="selector" required placeholder="a.cta" />
            </Field>
          ) : null}
          <SubmitButton busy={busy}>追加</SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
