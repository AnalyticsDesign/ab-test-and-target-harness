"use client";
import type { AnalyticsSettings, Audience, Experiment, Goal, Site } from "@/lib/types";
import { groupText, makeNames, summarizeDsl, type Names } from "@/lib/conditions";
import type { Draft, TabProps, TargetingDraft } from "@/lib/experiment-draft";
import { isStartedTest, testLockMessage, trafficError } from "@/lib/test-locks";
import { Field } from "../Field";
import { MemoField } from "../MemoField";
import { TargetUrlField } from "../TargetUrlField";
import { ExperimentTargeting } from "../targeting/ExperimentTargeting";
import { DeliverySummary } from "./DeliverySummary";
import { ExperimentAnalyticsCard } from "./ExperimentAnalyticsCard";
import { PersistFold } from "./PersistFold";
import d from "./Delivery.module.css";
import styles from "./VariantsTab.module.css";

const NAME_MAX = 100;

/** 配信条件のカードの段の小見出し(番号 + 名前 + 補足。admin_ui_rules 2.1) */
function Step({ n, title, hint, first }: { n: string; title: string; hint: string; first?: boolean }) {
  return (
    <h3 className={`${d.step} ${first ? d.firstStep : ""}`}>
      <span className={d.num} aria-hidden="true">
        {n}
      </span>
      {title}{" "}
      <span className={d.stepHint}>{hint}</span>
    </h3>
  );
}

/** 要約の 1 文の「訪問者の条件」の部分(条件なしは空文字 = すべての訪問者。画面で表せない保存値は summarizeDsl の文) */
function targetingText(t: TargetingDraft, names: Names): string {
  if (t.kind === "raw") return summarizeDsl(t.json, names);
  if (t.form.rows.length === 0) return "";
  return groupText({ id: "root", kind: "group", logic: t.form.logic, exclude: false, collapsed: false, children: t.form.rows }, names, true);
}

/**
 * 基本設定のタブ(B77 Q30・B69 spec §7.1)。カード「基本」(名前・メモ)、カード「配信条件」(① どのページで = 対象 URL → ② どの訪問者に = 配信条件 →
 * ③ そのうち何 % に = 配信率と、畳んだ割当の固定 → 要約の 1 文)、下部の外部計測のカードの 3 枚。
 * memoRo: メモは状態にかかわらず編集できる(終了したエクスペリエンスでも。閉じるのは閲覧者と保存中だけ)。
 * lock: 保存済みの種別・状態・配信率(D9 ③ Task 14、設計書 §5.5)。実行中・一時停止中のテストは配信率を下げられず(欄の下にエラー)、割当の固定は灰色
 */
export function OverviewTab({
  draft,
  set,
  ro,
  memoRo,
  goals,
  audiences,
  site,
  experimentId,
  saved,
  saveTried,
  analyticsOpen,
  onAnalyticsOpen,
  lock,
  goalsHref,
  trafficSent,
}: TabProps & {
  memoRo: boolean;
  /** 目標の画面(配信条件で目標が 0 件のときの案内のリンク。B66 c) */
  goalsHref: string;
  goals: Goal[];
  audiences: Audience[];
  site: Pick<Site, "retentionDays" | "timezone"> & { analytics: AnalyticsSettings };
  experimentId: string;
  /** 保存済みの値(外部計測の値の検査で、変えていない値を見ないため) */
  saved: Draft;
  saveTried: boolean;
  analyticsOpen: boolean;
  onAnalyticsOpen: (open: boolean) => void;
  lock: Pick<Experiment, "kind" | "status" | "trafficPercentage">;
  /** 配信率の欄を保存で送るか(下書きが開いたときの値と違う)。送らない欄には、ほかの人が上げた保存済みの値との比較で赤字を出さない */
  trafficSent: boolean;
}) {
  const started = isStartedTest(lock);
  const persistLocked = testLockMessage(lock, "persistAssignment");
  // 赤字は送る欄のときだけ(保存の前の検査 preSaveLockProblem と同じ条件。名前だけの保存を止めないのに、欄だけ赤いままにしない)
  const trafficProblem = !ro && trafficSent ? trafficError(lock, draft.traffic) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="card" aria-label="基本">
        <h2>基本</h2>
        <div className={styles.countRow}>
          <Field label="名前(100 字以内)">
            <input value={draft.name} maxLength={NAME_MAX} disabled={ro} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <span className={styles.count}>
            {draft.name.length} / {NAME_MAX}
          </span>
        </div>
        <MemoField value={draft.description} disabled={memoRo} placeholder="例: 目的・仮説・担当・関連するチケット" onChange={(v) => set("description", v)} />
      </section>
      <section className="card" aria-label="配信条件">
        <h2>配信条件</h2>
        <Step n="①" title="どのページで" hint="対象 URL" first />
        <p className={`muted ${d.stepNote}`}>このエクスペリエンスを動かすページ。ページの URL・ホスト・パス・パラメータの条件はここだけで指定します</p>
        <TargetUrlField value={draft.urlMatch} disabled={ro} onChange={(v) => set("urlMatch", v)} />
        <hr className={d.sep} />
        <Step n="②" title="どの訪問者に" hint="訪問者の条件。無ければ全員" />
        <ExperimentTargeting value={draft.targeting} onChange={(v) => set("targeting", v)} ctx={{ goals, goalsHref, audiences, retentionDays: site.retentionDays, timezone: site.timezone, disabled: ro }} />
        <hr className={d.sep} />
        <Step n="③" title="そのうち何 % に" hint="配信率" />
        <Field
          label="配信率(1〜100%。0% にしたいときは一時停止します)"
          hint={started ? `テストの開始後は、今の値(${lock.trafficPercentage}%)より上げることだけができます` : undefined}
          error={trafficProblem}
        >
          <input
            type="number"
            min={started ? lock.trafficPercentage : 1}
            max={100}
            value={draft.traffic}
            disabled={ro}
            aria-invalid={trafficProblem ? true : undefined}
            onChange={(e) => set("traffic", Number(e.target.value))}
          />
        </Field>
        <PersistFold checked={draft.persist} disabled={ro || persistLocked !== null} lockMessage={ro ? null : persistLocked} onChange={(v) => set("persist", v)} />
        <DeliverySummary urlMatch={draft.urlMatch} targetingText={targetingText(draft.targeting, makeNames(goals, audiences))} traffic={draft.traffic} persist={draft.persist} />
      </section>
      <ExperimentAnalyticsCard
        experimentId={experimentId}
        expName={draft.expName}
        extra={draft.extra}
        saved={{ expName: saved.expName, extra: saved.extra }}
        variants={draft.variants}
        names={site.analytics}
        disabled={ro}
        saveTried={saveTried}
        open={analyticsOpen}
        onOpenChange={onAnalyticsOpen}
        onChange={(next) => {
          if (next.expName !== draft.expName) set("expName", next.expName);
          if (next.extra !== draft.extra) set("extra", next.extra);
        }}
      />
    </div>
  );
}
