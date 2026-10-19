"use client";
import type { AnalyticsSettings, Audience, Experiment, Goal, Site } from "@/lib/types";
import type { Draft, TabProps } from "@/lib/experiment-draft";
import { isStartedTest, PERSIST_HINT, testLockMessage, trafficError } from "@/lib/test-locks";
import { Field } from "../Field";
import { MemoField } from "../MemoField";
import { PageMatchField } from "../PageMatchField";
import { ExperimentTargeting } from "../targeting/ExperimentTargeting";
import { ExperimentAnalyticsCard } from "./ExperimentAnalyticsCard";
import styles from "./VariantsTab.module.css";

const NAME_MAX = 100;

/**
 * 基本設定のタブ(B77 Q30)。名前 → メモ → 対象 URL・配信率・割当の固定 → 配信条件 のカードと、下部の外部計測のカード。
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
}: TabProps & {
  memoRo: boolean;
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
}) {
  const started = isStartedTest(lock);
  const persistLocked = testLockMessage(lock, "persistAssignment");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section className="card" aria-label="基本設定">
        <div className={styles.countRow}>
          <Field label="名前(100 字以内)">
            <input value={draft.name} maxLength={NAME_MAX} disabled={ro} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <span className={styles.count}>
            {draft.name.length} / {NAME_MAX}
          </span>
        </div>
        <MemoField value={draft.description} disabled={memoRo} placeholder="例: 目的・仮説・担当・関連するチケット" onChange={(v) => set("description", v)} />
        <Field label="対象 URL" hint="このエクスペリエンスを動かすページ。ここに一致しないページでは、配信条件にかかわらず何もしません">
          <PageMatchField value={draft.urlMatch} disabled={ro} onChange={(v) => set("urlMatch", v)} />
        </Field>
        <Field
          label="配信率(1〜100%。0% にしたいときは一時停止します)"
          hint={started ? `テストの開始後は、今の値(${lock.trafficPercentage}%)より上げることだけができます` : undefined}
          error={ro ? null : trafficError(lock, draft.traffic)}
        >
          <input
            type="number"
            min={started ? lock.trafficPercentage : 1}
            max={100}
            value={draft.traffic}
            disabled={ro}
            aria-invalid={!ro && trafficError(lock, draft.traffic) ? true : undefined}
            onChange={(e) => set("traffic", Number(e.target.value))}
          />
        </Field>
        <Field
          label="割当の固定"
          hint={
            <>
              {PERSIST_HINT}
              {persistLocked && !ro ? <span style={{ display: "block", marginTop: 4 }}>{persistLocked}</span> : null}
            </>
          }
        >
          <span className="row">
            <input type="checkbox" checked={draft.persist} disabled={ro || persistLocked !== null} onChange={(e) => set("persist", e.target.checked)} /> 有効
          </span>
        </Field>
        <h2>配信条件</h2>
        <ExperimentTargeting value={draft.targeting} onChange={(v) => set("targeting", v)} ctx={{ goals, audiences, retentionDays: site.retentionDays, timezone: site.timezone, disabled: ro }} />
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
