"use client";
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, describeError, fieldErrors } from "@/lib/client";
import {
  baselineNote,
  cautionMessage,
  comparisonsOf,
  draftEvaluationEstimate,
  extensionErrors,
  fieldsFor,
  fmt,
  notRecordingNotice,
  planCautionsOf,
  planFormErrors,
  planMode,
  PLAN_MODE_NOTICE,
  planPutBody,
  sampleSizeEstimate,
  thresholdLabel,
  type PlanField,
  type PlanForm,
  type PlanView,
} from "@/lib/evaluation-plan";
import type { Goal, Status, Variant } from "@/lib/types";
import { ErrorBox } from "../ErrorBox";
import { LocalTime, useNow } from "../LocalTime";
import { HelpTip } from "../help/HelpTip";
import { Picker } from "../ui/Picker";
import styles from "./EvaluationPlanTab.module.css";

const DAY_MS = 24 * 60 * 60 * 1000;

type Props = {
  wid: string;
  siteId: string;
  experimentId: string;
  status: Status;
  canEdit: boolean;
  /** 読めなかったときは null */
  view: PlanView | null;
  form: PlanForm | null;
  onForm: (f: PlanForm) => void;
  reason: string;
  onReason: (r: string) => void;
  onSaved: (v: PlanView) => void;
  goals: Goal[];
  /** 保存済みのパターン(基準の選択肢。保存していないパターンは control が受けない) */
  variants: Variant[];
  /** このサイトが結果を記録するか(Site の設定が有効で、導入に計測用のデータベースがある) */
  recording: boolean;
  resultsStore: boolean;
  /** 日付の表示のタイムゾーン(サイトのタイムゾーン。設計書 §5.3) */
  timeZone: string;
};

/**
 * 評価計画のタブ(D9 ③ Task 14、設計書 §5・§10、モック (a))。判定の基本 / 期間と人数(補助計算・時間の線)/ 判定の基準(詳細設定)。
 * 保存はこのタブの「評価計画を保存」(PUT …/evaluation-plan)。エクスペリエンスの下書きの保存とは別で、公開の対象にならない。
 * 入力の値はエディタの本体が持つ(タブを移っても失われない)。開始後は延ばす向きだけ、評価時点の後・終了・結果を記録しないで開始したテストは表示のみ
 */
export function EvaluationPlanTab(p: Props) {
  if (!p.view || !p.form) {
    return <p className="error-box">評価計画を読めませんでした。画面を読み込み直してください</p>;
  }
  return <PlanBody {...p} view={p.view} form={p.form} />;
}

function PlanBody({ wid, siteId, experimentId, status, canEdit, view, form, onForm, reason, onReason, onSaved, goals, variants, recording, resultsStore, timeZone }: Props & { view: PlanView; form: PlanForm }) {
  const router = useRouter();
  const ask = useConfirm();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  // 補助計算の入力(保存しない。モックの初期値)
  const [calc, setCalc] = useState({ cvr: "5", diff: "1", perDay: "250" });

  const mode = planMode({ status, canEdit, view, now });
  const editable = fieldsFor(mode);
  const can = (f: PlanField) => editable.has(f) && !busy;
  const before = view.plan;
  const typeErrors = planFormErrors(form);
  const extErrors = mode === "extend" ? extensionErrors(before, form) : {};
  const errorOf = (f: PlanField): string | null => typeErrors[f] ?? extErrors[f] ?? serverFields[`plan.${f}`] ?? null;
  const body = planPutBody(form, before, mode === "extend" ? reason : undefined);
  const dirty = Object.keys(body.plan).length > 0;
  const set = <K extends keyof PlanForm>(k: K, v: PlanForm[K]) => {
    setSaved(false);
    onForm({ ...form, [k]: v });
  };

  const active = variants.filter((v) => v.weight > 0);
  const activeCount = Math.max(active.length, 2);
  const comparisons = comparisonsOf(active.length);
  const baseline = variants.find((v) => v.id === form.baselineVariantId) ?? null;
  const thresholdNum = Number(form.threshold);
  const maxWeeksNum = typeErrors.maxWeeks ? before.maxWeeks : Number(form.maxWeeks);
  const minDaysNum = typeErrors.minDays ? before.minDays : Number(form.minDays);
  const targetNum = form.targetPerVariant.trim() === "" || typeErrors.targetPerVariant ? null : Number(form.targetPerVariant);
  const estimate = sampleSizeEstimate({
    cvrPercent: Number(calc.cvr),
    diffPoints: Number(calc.diff),
    perDay: Number(calc.perDay),
    activeVariants: activeCount,
    threshold: Number.isFinite(thresholdNum) && !typeErrors.threshold ? thresholdNum : before.threshold,
    maxWeeks: maxWeeksNum,
  });
  const cautions = planCautionsOf(form, before).map(cautionMessage);
  const cautionFor = (keys: string[]) =>
    planCautionsOf(form, before)
      .filter((c) => keys.includes(c.key))
      .map((c) => cautionMessage(c));
  const anyError = Object.keys(typeErrors).length > 0 || Object.keys(extErrors).length > 0;

  async function save() {
    setError(null);
    setServerFields({});
    if (anyError || !dirty) return;
    if (
      mode === "extend" &&
      !(await ask({
        title: "評価計画を延ばしますか?",
        body: "変更は日時・変更した人・前後の値とともに記録され、結果の画面に表示されます。延ばした後は元に戻せません(短くする変更はできません)",
        confirmLabel: "延ばして保存",
        tone: "primary",
      }))
    )
      return;
    setBusy(true);
    try {
      const fresh = await api<PlanView>("PUT", `/sites/${siteId}/experiments/${experimentId}/evaluation-plan`, body);
      onSaved(fresh);
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(describeError(e));
      setServerFields(fieldErrors(e));
    } finally {
      setBusy(false);
    }
  }

  // 終了したテストの文はエディタの上部の帯に出ているので、タブでは重ねない
  const notice = mode === "extend" || mode === "evaluated" || mode === "unfixed" ? PLAN_MODE_NOTICE[mode] : null;
  const notRecording = status === "draft" && !recording ? notRecordingNotice(resultsStore) : null;
  const showRequired = status === "draft" && recording;
  const goalOptions = goals.map((g) => ({ value: g.id, label: g.name, hint: g.id }));
  const variantOptions = variants.map((v) => ({ value: v.id, label: v.name, hint: v.original ? "オリジナル" : v.changes.length > 0 ? `変更 ${v.changes.length} 件` : "変更なし" }));
  const note = baseline ? baselineNote(baseline) : null;
  const def = before.definition;

  return (
    <div className={styles.stack}>
      <ErrorBox message={error} />
      {notRecording ? (
        <div className={`${styles.callout} ${styles.warn}`} role="note" data-testid="plan-not-recording">
          <strong>{notRecording.title}</strong>
          <span>{notRecording.body}</span>
          <span className="row">
            {notRecording.canEnable ? (
              <a className="btn btn-sm" href={`/w/${wid}/sites/${siteId}/settings`}>
                サイトの設定で有効にする
              </a>
            ) : null}
            <HelpTip helpKey="enable" label="有効にするときの注意" />
          </span>
        </div>
      ) : null}
      {notice ? (
        <div className={`${styles.callout} ${styles.info}`} role="note" data-testid="plan-mode-notice">
          <span>{notice}</span>
          {mode === "extend" ? (
            <span>
              <HelpTip helpKey="plan-changes" label="計画を変えるとき" />
            </span>
          ) : null}
        </div>
      ) : status === "draft" ? (
        <div className={`${styles.callout} ${styles.info}`}>
          <span>
            評価計画は<b>開始の時点で固定</b>されます。開始後も期間と人数を延ばす変更はできますが、変更は記録され、結果の画面に表示されます。 <HelpTip helpKey="why-plan" label="なぜ開始前に決めるのか" />
          </span>
        </div>
      ) : null}

      <section className="card" aria-label="判定の基本">
        <div className={styles.cardHead}>
          <h2>判定の基本</h2>
          <span className={styles.spacer} />
          <HelpTip helpKey="plan" label="評価計画とは" />
        </div>
        <div className={styles.grid}>
          <Label text="判定に使う目標" help={<HelpTip helpKey="primary-goal" />} tag={showRequired ? <span className={styles.req}>必須</span> : null} />
          <div className={styles.field}>
            <Picker label="判定に使う目標" value={form.primaryGoalId} options={goalOptions} disabled={!can("primaryGoalId")} placeholder="選んでください" onChange={(v) => set("primaryGoalId", v)} />
            {showRequired && form.primaryGoalId === null ? <span className={styles.err}>目標を選ぶと開始できます</span> : null}
            {goals.length === 0 ? <span className={styles.hint}>目標がありません。サイトの「目標」で作ってから選んでください</span> : null}
            <FieldError text={errorOf("primaryGoalId")} />
            <span className={styles.hint}>ほかの目標は参考として表示しますが、判定には使いません</span>
          </div>

          <Label text="基準" help={<HelpTip helpKey="baseline" />} />
          <div className={styles.field}>
            <Picker label="基準" value={form.baselineVariantId} options={variantOptions} disabled={!can("baselineVariantId")} onChange={(v) => set("baselineVariantId", v)} />
            {note ? <div className={`${styles.callout} ${styles.warn}`}>{note}</div> : null}
            <FieldError text={errorOf("baselineVariantId")} />
            <span className={styles.hint}>既定はオリジナルの中で先頭のパターンです(オリジナルが無ければ先頭のパターン)。パターンを追加したときは、エクスペリエンスを保存してから選べます</span>
          </div>
        </div>
      </section>

      <section className="card" aria-label="期間と人数">
        <div className={styles.cardHead}>
          <h2>期間と人数</h2>
          <span className={styles.spacer} />
          <HelpTip helpKey="evaluation-point" label="評価時点の決まり方" />
        </div>
        <div className={styles.grid}>
          <Label text="最低期間" help={<HelpTip helpKey="min-period" />} />
          <div className={styles.field}>
            <span className="row">
              <input aria-label="最低期間" type="number" min={mode === "extend" ? before.minDays : 1} step={1} value={form.minDays} disabled={!can("minDays")} onChange={(e) => set("minDays", e.target.value)} />
              <span className={styles.unit}>日(推奨 14 日)</span>
            </span>
            {cautionFor(["min_days_short", "min_days_very_short"]).map((c) => (
              <div key={c.text} className={`${styles.callout} ${c.tone === "warn" ? styles.warn : styles.info}`}>
                {c.text}
              </div>
            ))}
            <FieldError text={errorOf("minDays")} />
          </div>

          <Label text="最大期間" />
          <div className={styles.field}>
            <span className="row">
              <input aria-label="最大期間" type="number" min={mode === "extend" ? before.maxWeeks : 2} max={26} step={1} value={form.maxWeeks} disabled={!can("maxWeeks")} onChange={(e) => set("maxWeeks", e.target.value)} />
              <span className={styles.unit}>週(2〜26 週)</span>
            </span>
            <FieldError text={errorOf("maxWeeks")} />
            <span className={styles.hint}>ここまでに目標参加者数に届かなければ、この日に判定します(多くは「判断材料が不足」)</span>
          </div>

          <Label text="目標参加者数" tag={<span className={styles.opt}>任意・パターンごと</span>} />
          <div className={styles.field}>
            <span className="row">
              <input
                aria-label="目標参加者数"
                type="number"
                min={mode === "extend" && before.targetPerVariant !== null ? before.targetPerVariant : 100}
                step={100}
                placeholder="なし"
                value={form.targetPerVariant}
                disabled={!can("targetPerVariant")}
                onChange={(e) => set("targetPerVariant", e.target.value)}
              />
              <span className={styles.unit}>人 / パターン</span>
              {estimate && can("targetPerVariant") ? (
                <button type="button" className="btn btn-sm" onClick={() => set("targetPerVariant", String(estimate.perVariant))}>
                  計算結果({fmt(estimate.perVariant)} 人)を使う
                </button>
              ) : null}
            </span>
            <FieldError text={errorOf("targetPerVariant")} />
            {cautionFor(["no_target"]).map((c) => (
              <div key={c.text} className={`${styles.callout} ${styles.info}`}>
                {c.text}
              </div>
            ))}
            <div className={styles.calc}>
              <div className="row" style={{ gap: 6 }}>
                <strong style={{ fontSize: 12.5 }}>必要な人数の目安</strong>
                <HelpTip helpKey="sample-size" />
              </div>
              <div className={styles.calcInputs}>
                <label>
                  今の CVR
                  <span className="row" style={{ gap: 6 }}>
                    <input type="number" step={0.1} min={0.1} value={calc.cvr} onChange={(e) => setCalc({ ...calc, cvr: e.target.value })} />
                    <span className={styles.unit}>%</span>
                  </span>
                </label>
                <label>
                  見つけたい差
                  <span className="row" style={{ gap: 6 }}>
                    <input type="number" step={0.1} min={0.1} value={calc.diff} onChange={(e) => setCalc({ ...calc, diff: e.target.value })} />
                    <span className={styles.unit}>ポイント</span>
                  </span>
                </label>
                <label>
                  1 日の参加者の見込み(合計)
                  <span className="row" style={{ gap: 6 }}>
                    <input type="number" step={10} min={10} value={calc.perDay} onChange={(e) => setCalc({ ...calc, perDay: e.target.value })} />
                    <span className={styles.unit}>人</span>
                  </span>
                </label>
              </div>
              {estimate ? (
                <>
                  <div className={styles.calcOut} data-testid="sample-size">
                    {estimate.text}
                  </div>
                  <div className={`${styles.callout} ${estimate.fit.ok ? styles.ok : styles.warn}`}>{estimate.fit.text}</div>
                  {estimate.raised ? <span className="muted">{estimate.raised}</span> : null}
                </>
              ) : (
                <span className={styles.err}>入力を確かめてください(CVR と差は 0 より大きく、合わせて 100% 未満)</span>
              )}
            </div>
          </div>
        </div>
        <Timeline view={view} status={status} now={now} timeZone={timeZone} minDays={minDaysNum} maxWeeks={maxWeeksNum} target={targetNum} perDay={Number(calc.perDay)} activeVariants={activeCount} />
        {view.changes.length > 0 ? <p className="muted">計画の変更 {view.changes.length} 件(結果の画面で一覧を見られます)</p> : null}
      </section>

      <section className="card" aria-label="判定の基準">
        <details className={styles.adv} open={before.delta !== 0 || before.rope !== null || before.threshold !== 95 || undefined}>
          <summary>判定の基準(詳細設定。ふつうは既定のままで構いません)</summary>
          <div className={styles.grid}>
            <Label text="最小改善幅" help={<HelpTip helpKey="min-improvement" />} tag={<span className={styles.opt}>既定 0</span>} />
            <div className={styles.field}>
              <span className="row">
                <span className={styles.unit}>+</span>
                <input aria-label="最小改善幅" type="number" step={0.1} min={0} value={form.delta} disabled={!can("delta")} onChange={(e) => set("delta", e.target.value)} />
                <span className={styles.unit}>ポイントを超えて良くならなければ採用候補にしない</span>
              </span>
              <FieldError text={errorOf("delta")} />
            </div>

            <Label text="同等とみなす幅" help={<HelpTip helpKey="equivalence" />} tag={<span className={styles.opt}>任意</span>} />
            <div className={styles.field}>
              <span className="row">
                <span className={styles.unit}>±</span>
                <input aria-label="同等とみなす幅" type="number" step={0.01} min={0.01} placeholder="なし" value={form.rope} disabled={!can("rope")} onChange={(e) => set("rope", e.target.value)} />
                <span className={styles.unit}>ポイント以内なら「実務上ほぼ同等」</span>
              </span>
              <FieldError text={errorOf("rope")} />
            </div>

            <Label text="確率のしきい値" help={<HelpTip helpKey="threshold" />} tag={<span className={styles.opt}>既定 95%</span>} />
            <div className={styles.field}>
              <span className="row">
                <input aria-label="確率のしきい値" type="number" min={90} max={99.9} step={0.5} value={form.threshold} disabled={!can("threshold")} onChange={(e) => set("threshold", e.target.value)} />
                <span className={styles.unit}>%(90〜99.9)</span>
              </span>
              {cautionFor(["threshold_low"]).map((c) => (
                <div key={c.text} className={`${styles.callout} ${styles.warn}`}>
                  {c.text}
                </div>
              ))}
              {comparisons > 1 && Number.isFinite(thresholdNum) ? (
                <div className={`${styles.callout} ${styles.info}`}>
                  <span>
                    {activeCount} つのパターンのテストでは、パターンごとに基準と比べるしきい値を <b>{thresholdLabel(thresholdNum, comparisons)}%</b> に引き上げます。 <HelpTip helpKey="multiple-variants" />
                  </span>
                </div>
              ) : null}
              <FieldError text={errorOf("threshold")} />
            </div>

            <Label text="CV を数える期間" help={<HelpTip helpKey="observation-window" />} />
            <div className={styles.fixedVal}>テストの終了まで(初めて表示された後 〜 評価時点または終了)</div>

            <Label text="参加者の数え方" help={<HelpTip helpKey="participants" />} />
            <div className={styles.fixedVal}>テスト対象の要素が表示された人(変更の適用に失敗した人も含む)</div>

            <Label text="統計モデル" help={<HelpTip helpKey="model" />} />
            <div className={`${styles.fixedVal} mono`}>
              Beta-Binomial・事前分布 Beta({def.model.prior[0]},{def.model.prior[1]})・版 {def.model.version}
            </div>
          </div>
        </details>
      </section>

      {mode === "draft" || mode === "extend" ? (
        <section className="card" aria-label="評価計画の保存">
          <div className={styles.foot}>
            {mode === "extend" ? (
              <label className={styles.reason}>
                <span className="field-label">変更の理由(任意。結果の画面の「計画の変更」に出ます)</span>
                <textarea value={reason} maxLength={500} disabled={busy} placeholder="例: 季節の変動を含めるため、最大期間を延ばす" onChange={(e) => onReason(e.target.value)} />
                <span className={styles.hint}>結果を見て「勝つまで延ばす」と、誤って勝ちと出る率が上がります。延ばす理由を残してください</span>
              </label>
            ) : null}
            <button type="button" className="btn btn-primary" disabled={busy || !dirty || anyError} onClick={() => void save()}>
              {busy ? "保存中…" : "評価計画を保存"}
            </button>
            {saved && !dirty ? (
              <span className="muted" role="status">
                保存しました(評価計画の保存は公開の対象になりません)
              </span>
            ) : dirty ? (
              <span className="muted">未保存の変更があります</span>
            ) : null}
            {cautions.length > 0 && dirty ? <span className="muted">注意はありますが、このまま保存できます</span> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Label({ text, help, tag }: { text: string; help?: ReactNode; tag?: ReactNode }) {
  return (
    <div className={styles.lbl}>
      <span className={styles.lblLine}>
        {text} {help}
      </span>
      {tag}
    </div>
  );
}

function FieldError({ text }: { text: string | null }) {
  return text ? (
    <span role="alert" className={styles.err}>
      {text}
    </span>
  ) : null;
}

/**
 * 開始から評価時点までの時間の線。下書きは「今開始したら」の見込み(時刻はマウントの後に描く)。
 * 固定した計画は control が返した評価時点(目標参加者数に届く前は最大期間の終わり)
 */
function Timeline({
  view,
  status,
  now,
  minDays,
  maxWeeks,
  target,
  perDay,
  activeVariants,
  timeZone,
}: {
  view: PlanView;
  status: Status;
  now: number | null;
  timeZone: string;
  minDays: number;
  maxWeeks: number;
  target: number | null;
  perDay: number;
  activeVariants: number;
}) {
  if (status !== "draft") {
    const ev = view.evaluation;
    if (!ev) return null;
    const pending = view.plan.targetPerVariant !== null && ev.reachedAt === null;
    return (
      <div className={styles.timeline} data-testid="plan-timeline">
        <div className={styles.tl}>
          <span className="muted">最低期間の終わり</span>
          <b>
            <LocalTime at={ev.minEnd} kind="date" timeZone={timeZone} />
          </b>
        </div>
        <div className={styles.tl}>
          <span className="muted">{pending ? "評価時点(目標参加者数に届けばその日。届くまでは最大期間の終わり)" : "評価時点"}</span>
          <b>
            <LocalTime at={ev.evaluationAt} kind="date" timeZone={timeZone} />
          </b>
        </div>
        <div className={styles.tl}>
          <span className="muted">最大期間の終わり</span>
          <b>
            <LocalTime at={ev.maxEnd} kind="date" timeZone={timeZone} />
          </b>
        </div>
      </div>
    );
  }
  const est = draftEvaluationEstimate({ minDays, maxWeeks, target, perDay: Number.isFinite(perDay) && perDay > 0 ? perDay : null, activeVariants });
  return (
    <div className={styles.timeline} data-testid="plan-timeline">
      <div className={styles.tl}>
        <span className="muted">開始(今日に開始した場合)</span>
        <b>{now === null ? "" : <LocalTime at={now} kind="date" timeZone={timeZone} />}</b>
      </div>
      <div className={styles.tl}>
        <span className="muted">評価時点の見込み</span>
        <span>
          {est.days !== null && now !== null ? (
            <b>
              <LocalTime at={now + est.days * DAY_MS} kind="date" timeZone={timeZone} />
            </b>
          ) : null}{" "}
          {est.text}
        </span>
      </div>
      <div className={styles.tl}>
        <span className="muted">最大期間の終わり</span>
        <b>{now === null ? "" : <LocalTime at={now + maxWeeks * 7 * DAY_MS} kind="date" timeZone={timeZone} />}</b>
      </div>
    </div>
  );
}
