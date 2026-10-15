"use client";
import type { Audience, Goal, Site } from "@/lib/types";
import type { TabProps } from "@/lib/experiment-draft";
import { Field } from "../Field";
import { PageMatchField } from "../PageMatchField";
import { ExperimentTargeting } from "../targeting/ExperimentTargeting";

export function OverviewTab({ draft, set, ro, goals, audiences, site }: TabProps & { goals: Goal[]; audiences: Audience[]; site: Pick<Site, "retentionDays" | "timezone"> }) {
  return (
    <section className="card">
      <h2>基本</h2>
      <Field label="名前(100 字以内)">
        <input value={draft.name} maxLength={100} disabled={ro} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label="対象 URL" hint="このエクスペリエンスを動かすページ。ここに一致しないページでは、配信条件にかかわらず何もしません">
        <PageMatchField value={draft.urlMatch} disabled={ro} onChange={(v) => set("urlMatch", v)} />
      </Field>
      <Field label="配信率(1〜100%。0% にしたいときは一時停止します)">
        <input type="number" min={1} max={100} value={draft.traffic} disabled={ro} onChange={(e) => set("traffic", Number(e.target.value))} />
      </Field>
      <Field
        label="割当の固定"
        hint="オンにすると初回の割当を訪問者プロフィールに保存し、配分を変えても既存訪問者は再割当されません(needsProfile が立ち、判定のたびに edge へ往復します)。オフでは配分変更で一部訪問者が再割当されます"
      >
        <span className="row">
          <input type="checkbox" checked={draft.persist} disabled={ro} onChange={(e) => set("persist", e.target.checked)} /> 有効
        </span>
      </Field>
      <h2>配信条件</h2>
      <ExperimentTargeting value={draft.targeting} onChange={(v) => set("targeting", v)} ctx={{ goals, audiences, retentionDays: site.retentionDays, timezone: site.timezone, disabled: ro }} />
    </section>
  );
}
