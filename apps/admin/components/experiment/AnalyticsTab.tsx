"use client";
import type { TabProps } from "@/lib/experiment-draft";
import { Field } from "../Field";
import { ExtraEditor } from "../ExtraEditor";

export function AnalyticsTab({ draft, set, ro }: TabProps) {
  return (
    <section className="card">
      <h2>外部計測(このエクスペリエンスの値)</h2>
      <Field label="experimentName の上書き(空 = 名前をそのまま)">
        <input value={draft.expName} maxLength={100} disabled={ro} onChange={(e) => set("expName", e.target.value)} />
      </Field>
      <span className="field-label">extra(全パターン共通。パターン側の同名キーが優先)</span>
      <ExtraEditor value={draft.extra} disabled={ro} onChange={(extra) => set("extra", extra)} />
    </section>
  );
}
