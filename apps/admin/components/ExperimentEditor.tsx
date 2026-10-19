"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiClientError } from "@/lib/client";
import { toChangeWire } from "@/lib/change-wire";
import { saveErrorMessage } from "@/lib/experiment-save";
import { draftOf, draftValueErrors, failedTab, isDirty, saveSteps, targetingBody, type Draft, type EditorTab } from "@/lib/experiment-draft";
import { planDirty, planFormState, syncPlanState, type PlanForm, type PlanView } from "@/lib/evaluation-plan";
import { archivedTestBanner, lockedFieldChanges, needsRunningTestConfirm, RUNNING_TEST_CONFIRM, trafficError } from "@/lib/test-locks";
import { treeProblem } from "@/lib/conditions";
import { emptyHtmlIndex, firstEmptyHtml } from "@/lib/change-issues";
import { analyticsCardOpenInitially } from "@/lib/analytics-badges";
import { replaceParam } from "@/lib/url-state";
import { previewPageUrl } from "@/lib/page-match";
import type { Audience, Experiment, Goal, Site } from "@/lib/types";
import { useConfirm } from "./ConfirmProvider";
import { useLeaveGuard, type LeaveAttempt } from "./api-keys/useLeaveGuard";
import { ErrorBox } from "./ErrorBox";
import { TabPanel, Tabs } from "./ui/Tabs";
import { SaveBar } from "./ui/SaveBar";
import { OverviewTab } from "./experiment/OverviewTab";
import { VariantsTab } from "./experiment/VariantsTab";
import { EvaluationPlanTab } from "./experiment/EvaluationPlanTab";
import { ResultsTab } from "./experiment/ResultsTab";
import { StopDialog, StopNotices } from "./experiment/StopDialog";
import type { ResultsResponse } from "@/lib/results-view";
import type { StopMessage } from "@/lib/stop-dialog";

/**
 * initialPlan = テストの評価計画(D9 ③ Task 14。パーソナライズと読めなかったときは null)。
 * recording = このサイトが結果を記録するか(Site の設定が有効で、導入に計測用のデータベースがある)。resultsStore = 導入に計測用のデータベースがあるか
 */
type Props = {
  site: Site; experiment: Experiment; goals: Goal[]; audiences: Audience[]; role: string; imageUpload: boolean; initialTab: EditorTab; initialVariant: string | null;
  wid: string; initialPlan: PlanView | null; recording: boolean; resultsStore: boolean;
};
/** 本体が使うのは initialTab / initialVariant を除いた分(開いているタブと Variant は外枠が持つ) */
type BodyProps = Omit<Props, "initialTab" | "initialVariant">;

/**
 * 外枠。「破棄」は本体を作り直すだけ(control は呼ばない。設計書 4.4)。
 * 開いているタブと Variant は外枠が持つ。**ページはこの外枠に key を付けない**: 外枠は保存後の router.refresh() をまたいで残り、
 * 作り直されるのは本体だけ(key = updatedAt・メモと破棄の世代)。だから破棄しても保存しても、見ている場所は変わらない。
 * URL の ?tab= / ?variant= は再読み込みと共有のための写しで、保存後の表示はこれに頼らない
 */
export function ExperimentEditor({ initialTab, initialVariant, ...body }: Props) {
  const [generation, setGeneration] = useState(0);
  const [tab, setTab] = useState<EditorTab>(initialTab);
  const [variant, setVariant] = useState<string | null>(initialVariant);
  // updatedAt: 保存で server 側が更新されるたびに本体を作り直し、フォームを最新の値で初期化する(prop の変更だけでは useState は再初期化されない)。
  // メモだけの保存は updated_at を進めない(「未公開の編集あり」を付けないため。B77 K9)ので、メモの値も key に入れる
  // (入れないと、メモを保存しても本体が作り直されず、保存した値が「未保存の変更あり」のまま残る)
  const memoKey = JSON.stringify([body.experiment.description, (body.experiment.variants ?? []).map((v) => v.description)]);
  const bodyKey = `${body.experiment.updatedAt}:${memoKey}:${generation}`;
  // 内側の「入ってくる」動き(.enter)は、この本体の中でタブ・Variant を切り替えた後だけ付ける:
  // 初回表示は外側(PageEnter)が動くので重ねない / 保存・破棄で本体を作り直した直後も動かさない(見ている場所は変わらないため)。
  // そのため「どの本体で切り替えたか」を key で覚え、本体が変わったら切替前の状態に戻す
  const [switchedIn, setSwitchedIn] = useState<string | null>(null);
  // 外部計測のカードの開閉(キー = "experiment" と `v:{パターン ID}`。パターン ID が "experiment" でもぶつからないよう前置きを付ける)。
  // 外枠に置き、保存の後の作り直し・タブとパターンの往復をまたいで残す。
  // まだ無いキーは、表示する側が最初の表示の規則(analyticsCardOpenInitially)で決めて書き込む
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({});
  const onCardOpen = useCallback((key: string, open: boolean) => setCardOpen((c) => (c[key] === open ? c : { ...c, [key]: open })), []);
  // 評価計画(テストだけ。D9 ③)の入力も外枠に置く: 計画の保存はエクスペリエンスの updated_at を進めないので、本体の作り直し
  // (エクスペリエンスの保存・破棄・状態の変更)で未保存の入力を失わないため。ページが読み直した計画(initialPlan)が変わったら
  // syncPlanState で置き換える(未保存の入力があれば入力は残し、比べる計画だけ新しくする)。描画中の state の調整(前の値を覚えて比べる)
  const planKey = JSON.stringify(body.initialPlan);
  const [plan, setPlan] = useState<{ view: PlanView | null; form: PlanForm | null }>(() => ({ view: body.initialPlan, form: body.initialPlan ? planFormState(body.initialPlan) : null }));
  const [planSeen, setPlanSeen] = useState(planKey);
  if (planSeen !== planKey) {
    setPlanSeen(planKey);
    setPlan((p) => syncPlanState(p, body.initialPlan));
  }
  const [planReason, setPlanReason] = useState("");
  // 評価計画に未保存の入力があれば、画面の中の移動と再読み込み・タブを閉じるを確認する
  const router = useRouter();
  const ask = useConfirm();
  // useLeaveGuard は渡した関数を ref に入れて最新のものを呼ぶので、毎回作ってよい
  async function onLeave(a: LeaveAttempt) {
    if (!(await ask({ title: "評価計画の変更を保存していません", body: "移動すると、評価計画のタブで入力した値は失われます", confirmLabel: "保存せずに移動", tone: "danger" }))) {
      if (a.kind === "logout") a.form.closest("details")?.removeAttribute("open");
      return;
    }
    bypass();
    if (a.kind === "href") router.push(a.href);
    else a.form.requestSubmit();
  }
  const { bypass } = useLeaveGuard(planDirty(plan.view, plan.form), (a) => void onLeave(a));
  // 終了のモーダル(D9 ③ Task 16): 結果のタブの帯の「終了して採用を記録」「採用なしで終了」から開く。開始・終了は管理者以上(設計書 §10)。
  // 外枠に置く: 終了は updated_at を進めて本体を作り直すので、知らせを本体に置くと読む前に消えるため
  const canAdmin = body.role === "owner" || body.role === "admin";
  const stoppable = body.experiment.kind === "test" && (body.experiment.status === "running" || body.experiment.status === "paused");
  const [stop, setStop] = useState<{ variantId: string | null; report: ResultsResponse } | null>(null);
  const [stopNotices, setStopNotices] = useState<{ messages: StopMessage[]; created: string | null } | null>(null);
  return (
    <>
    {stopNotices ? (
      <div className="row" style={{ gap: 8, marginBottom: 8 }} data-testid="editor-stop-notices">
        <StopNotices messages={stopNotices.messages} created={stopNotices.created} />
      </div>
    ) : null}
    {stop ? (
      <StopDialog
        wid={body.wid}
        siteId={body.site.id}
        experiment={body.experiment}
        timeZone={body.site.timezone}
        mode="stop"
        report={stop.report}
        initialVariantId={stop.variantId}
        onClose={() => setStop(null)}
        onDone={(messages, created) => {
          setStop(null);
          setStopNotices({ messages, created });
          router.refresh();
        }}
      />
    ) : null}
    <ExperimentEditorBody
      key={bodyKey}
      {...body}
      tab={tab}
      onTab={(t) => {
        setSwitchedIn(bodyKey);
        setTab(t);
        replaceParam("tab", t === "overview" ? null : t);
      }}
      variant={variant}
      onVariant={(id) => {
        setSwitchedIn(bodyKey);
        setVariant(id);
        replaceParam("variant", id);
      }}
      animate={switchedIn === bodyKey}
      onDiscard={() => setGeneration((g) => g + 1)}
      cardOpen={cardOpen}
      onCardOpen={onCardOpen}
      plan={plan}
      onPlan={setPlan}
      planReason={planReason}
      onPlanReason={setPlanReason}
      onStop={canAdmin && stoppable ? (variantId, report) => {
        setStopNotices(null);
        setStop({ variantId, report });
      } : undefined}
    />
    </>
  );
}

function ExperimentEditorBody({
  site, experiment, goals, audiences, role, imageUpload, tab, onTab, variant, onVariant, onDiscard, animate, cardOpen, onCardOpen, wid, recording, resultsStore,
  plan, onPlan, planReason, onPlanReason, onStop,
}: BodyProps & {
  tab: EditorTab; onTab: (t: EditorTab) => void; variant: string | null; onVariant: (id: string | null) => void; onDiscard: () => void; animate: boolean; cardOpen: Record<string, boolean>; onCardOpen: (key: string, open: boolean) => void;
  /** 評価計画の状態(外枠が持つ) */
  plan: { view: PlanView | null; form: PlanForm | null }; onPlan: (p: { view: PlanView | null; form: PlanForm | null }) => void; planReason: string; onPlanReason: (r: string) => void;
  /** 結果のタブの帯から終了のモーダルを開く(管理者以上・実行中か一時停止中のテストだけ。外枠が渡す) */
  onStop?: (variantId: string | null, report: ResultsResponse) => void;
}) {
  const router = useRouter();
  const ask = useConfirm();
  const canEdit = role !== "viewer";
  const isTest = experiment.kind === "test";
  const initial = useMemo(() => draftOf(experiment), [experiment]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorTab, setErrorTab] = useState<EditorTab | null>(null);
  const [attrHint, setAttrHint] = useState<{ variantIdx: number; changeIdx: number } | null>(null);
  // 保存を試したか(ruling R12: それまではキーが空の行に「値を入力してください」を出さない)。保存に成功すると本体ごと作り直されて戻る
  const [saveTried, setSaveTried] = useState(false);
  // B8: 保存の前に見つけた空の HTML の変更。利用者がその欄を直したら消す(位置がずれても追えるよう変更の id で持つ)
  const [emptyHtml, setEmptyHtml] = useState<{ variantId: string; changeId: string } | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (key === "variants" && emptyHtml && emptyHtmlIndex(value as Draft["variants"], emptyHtml) === null) setEmptyHtml(null);
  };
  const { urlMatch, variants } = draft;
  const pageUrl = previewPageUrl(site.domain, urlMatch);
  const weightSum = variants.reduce((a, v) => a + v.weight, 0);
  // control の `PUT …/variants` は draft の Experiment にしか使えない(409 experiment_active)。
  // 非 draft ではパターンの集合を編集できなくし、保存でもこのエンドポイントを叩かない(saveSteps が決める)
  const variantsLocked = experiment.status !== "draft";
  const dirty = isDirty(initial, draft);
  const steps = saveSteps(initial, draft, experiment.status);
  const memoChanged = steps.experimentMemo || steps.variantMemos.length > 0;
  const emptyHtmlAt = emptyHtml ? emptyHtmlIndex(variants, emptyHtml) : null;

  // エクスペリエンスの外部計測のカード: まだ開閉を覚えていなければ、基本設定を最初に表示したときの規則で決めてすぐ覚える
  // (設定があれば開き、なければ畳む。編集中に設定を全部消しても勝手に閉じない。B77 Q30b。パターンのカードは VariantsTab が同じことをする)
  const experimentCardInitially = analyticsCardOpenInitially(draft.expName, draft.extra);
  const experimentCardOpen = cardOpen.experiment ?? experimentCardInitially;
  useEffect(() => {
    if (tab === "overview" && !("experiment" in cardOpen)) onCardOpen("experiment", experimentCardInitially);
  }, [tab, cardOpen, experimentCardInitially, onCardOpen]);

  /**
   * (1) 保存の前の確かめ(B77 K17)。止めるときは理由を出して true を返す(API は呼ばない)。
   * 配信条件の入力漏れ → 外部計測の値(変えた値と新しい値だけ)→ 空の HTML の変更(B8)の順に見る。値の最終的な検査は control。
   * 配信条件はエクスペリエンスの欄を送るときだけ見る(メモだけの保存を、保存済みの配信条件で止めない)
   */
  function blockedBeforeSave(): boolean {
    // D9 ③(設計書 §5.5): 実行中・一時停止中のテストは配信率を下げられない(control の 409 test_setting_locked を先に示す)
    const traffic = steps.patchExperiment ? trafficError(experiment, draft.traffic) : null;
    if (traffic) {
      setErrorTab("overview");
      setError(traffic);
      return true;
    }
    const problem = steps.patchExperiment && draft.targeting.kind === "form" ? treeProblem(draft.targeting.form.rows, site.retentionDays) : null;
    if (problem) {
      setErrorTab("overview");
      setError(problem);
      return true;
    }
    const valueErrors = draftValueErrors(initial, draft);
    if (valueErrors.length > 0) {
      // 問題のある欄が見えるように、そのカードを開き、パターンなら最初のものを選ぶ
      const onExperiment = valueErrors.some((e) => e.path[0] === "analytics");
      const variantIds = [...new Set(valueErrors.filter((e) => e.path[0] === "variants").map((e) => e.path[1]!))];
      if (onExperiment) onCardOpen("experiment", true);
      for (const id of variantIds) onCardOpen(`v:${id}`, true);
      if (variantIds[0]) onVariant(variantIds[0]);
      setErrorTab(onExperiment ? "overview" : "variants");
      setError("外部計測(dataLayer 出力)に保存できない値があります。欄の下の案内に沿って直してください");
      return true;
    }
    // オリジナルと終了したエクスペリエンスの変更は送らないので、送るパターンだけを見る
    const empty = firstEmptyHtml(variants.filter((v) => steps.putChanges.includes(v.id)));
    if (empty) {
      const changeId = variants.find((v) => v.id === empty.variantId)!.changes[empty.changeIndex]!.id;
      setEmptyHtml({ variantId: empty.variantId, changeId });
      onVariant(empty.variantId);
      setErrorTab("variants");
      setError("HTML の変更に、HTML が入っていないものがあります");
      return true;
    }
    return false;
  }

  async function save() {
    setError(null);
    setErrorTab(null);
    setAttrHint(null);
    setSaveTried(true);
    if (blockedBeforeSave()) return;
    // 送るものが無い(isDirty の偽陽性)なら、保存済みの値に戻すだけ(control は呼ばない)
    if (!steps.patchExperiment && !steps.experimentMemo && !steps.putVariants && steps.variantMemos.length === 0 && steps.putChanges.length === 0) {
      onDiscard();
      return;
    }
    // D9 ③(設計書 §5.5): 実行中・一時停止中のテストの Change・対象 URL・配信条件を保存するときは 1 回確認する。
    // 確認を待つ間も保存を押せないよう、先に busy を立てる(キャンセルなら戻す)
    setBusy(true);
    if (
      needsRunningTestConfirm(experiment, lockedFieldChanges(initial, draft)) &&
      !(await ask({ title: "実行中のテストを変更しますか?", body: RUNNING_TEST_CONFIRM, confirmLabel: "保存する", tone: "primary" }))
    ) {
      setBusy(false);
      return;
    }
    // 外枠は `key={updatedAt…}` でこの本体を再マウントする(成功時の router.refresh() が
    // 本当に「最新の表示」にするため)。だが部分適用の失敗時にここで router.refresh() を呼ぶと、再マウントで
    // エラーバナーや「HTML タイプに切り替える」導線ごと消える(422 が返っているのに画面には何も出ない)。
    // そのため部分適用の失敗時は自動 refresh をせず、手動の再読み込みを促すに留める
    const base = `/sites/${site.id}/experiments/${experiment.id}`;
    let savedSomething = false;
    let stage: "patch" | "variants" | "changes" = "patch";
    try {
      // (2) エクスペリエンスの欄(メモは載せない)。画面で表せない保存値(raw)の配信条件は送らない
      if (steps.patchExperiment) {
        const { expName, extra } = draft;
        await api("PATCH", base, {
          name: draft.name,
          urlMatch,
          ...targetingBody(draft.targeting),
          trafficPercentage: draft.traffic,
          persistAssignment: draft.persist,
          analytics: expName || Object.keys(extra).length ? { ...(expName ? { overrides: { experimentName: expName } } : {}), ...(Object.keys(extra).length ? { extra } : {}) } : null,
        });
        savedSomething = true;
      }
      // (3) エクスペリエンスのメモ。description だけの PATCH は状態を問わず受けられ、未公開の印を付けない
      if (steps.experimentMemo) {
        await api("PATCH", base, { description: draft.description });
        savedSomething = true;
      }
      stage = "variants";
      // (4) パターンの集合(下書きだけ)。メモはこの body に載せない((5) で送る)
      if (steps.putVariants) {
        await api(
          "PUT",
          `${base}/variants`,
          variants.map((v) => ({ id: v.id, name: v.name, weight: v.weight, original: v.original, analytics: v.analytics && (v.analytics.overrides || v.analytics.extra) ? v.analytics : null })),
        );
        savedSomething = true;
      }
      // (5) メモが変わったパターンごと(状態を問わない。新しいパターンは (4) で作られた後に送る)
      for (const id of steps.variantMemos) {
        try {
          await api("PATCH", `${base}/variants/${id}`, { description: variants.find((v) => v.id === id)!.description });
        } catch (e) {
          onVariant(id); // 落ちたパターンを開く
          throw e;
        }
        savedSomething = true;
      }
      stage = "changes";
      // (6) 変更が変わった、オリジナルでないパターンごと
      for (const id of steps.putChanges) {
        const vi = variants.findIndex((v) => v.id === id);
        const v = variants[vi]!;
        try {
          await api("PUT", `${base}/variants/${v.id}/changes`, v.changes.map(toChangeWire));
        } catch (e) {
          if (e instanceof ApiClientError && e.code === "attribute_not_allowed") {
            const ci = v.changes.findIndex((c) => c.type === "ATTRIBUTE" && (c.payload as { name?: string }).name === e.extra.attribute);
            // 一致する ATTRIBUTE Change がローカルに無いときはバナーを出さない(押しても何も変換しない操作になるため)
            if (ci >= 0) setAttrHint({ variantIdx: vi, changeIdx: ci });
          }
          onVariant(v.id); // 落ちた Variant を開く
          throw e;
        }
        savedSomething = true;
      }
      router.refresh();
    } catch (e) {
      const path = e instanceof ApiClientError ? (e.extra.issues?.[0]?.path ?? e.extra.path) : undefined;
      const first = Array.isArray(path) ? path[0] : typeof path === "string" ? path.split(".")[0] : undefined;
      // ApiClientError 以外(通信の失敗など)は、エクスペリエンスの段なら基本設定、それより後なら印を付けない
      const where: EditorTab | null = e instanceof ApiClientError ? failedTab(stage, first === undefined ? undefined : String(first)) : stage === "patch" ? "overview" : null;
      setErrorTab(where);
      setError(saveErrorMessage(e, savedSomething));
    } finally {
      setBusy(false);
    }
  }

  // ro = メモ以外の欄(終了したエクスペリエンスは読み取り専用)。memoRo = メモの欄(状態にかかわらず編集できる。閉じるのは閲覧者と保存中だけ)
  const ro = !canEdit || busy || experiment.status === "archived";
  const memoRo = !canEdit || busy;
  const tabProps = { draft, set, ro };
  const archivedBanner = archivedTestBanner(experiment);
  return (
    <div>
      {archivedBanner ? (
        <p className="banner-warn" role="note" data-testid="archived-test-banner">
          {archivedBanner}
        </p>
      ) : null}
      <ErrorBox message={error} />
      {attrHint ? (
        <p className="banner-warn">
          この属性は ATTRIBUTE では設定できません。
          <button
            type="button"
            className="btn"
            onClick={() => {
              set("variants", variants.map((v, vi) => (vi !== attrHint.variantIdx ? v : { ...v, changes: v.changes.map((c, ci) => (ci !== attrHint.changeIdx ? c : { id: c.id, type: "HTML", selector: c.selector, payload: { html: "", position: "replace", runScripts: false } })) })));
              setAttrHint(null);
            }}
          >
            HTML タイプに切り替える
          </button>
        </p>
      ) : null}
      <Tabs
        value={tab}
        onChange={(id) => onTab(id as EditorTab)}
        tabs={[
          { id: "overview", label: "基本設定", marked: errorTab === "overview" && tab !== "overview" },
          { id: "variants", label: "パターン", marked: (errorTab === "variants" || weightSum !== 100) && tab !== "variants" },
          // 評価計画と結果はテストだけ。結果は下書きでは押せない(「開始後に表示されます」。設計書 §10)
          ...(isTest
            ? [
                { id: "plan", label: "評価計画" },
                { id: "results", label: "結果", disabled: experiment.status === "draft", hint: experiment.status === "draft" ? "開始後に表示されます" : undefined },
              ]
            : []),
        ]}
      />
      {tab === "overview" ? (
        <TabPanel id="overview" animate={animate}>
          <OverviewTab
            {...tabProps}
            memoRo={memoRo}
            goals={goals}
            audiences={audiences}
            site={site}
            experimentId={experiment.id}
            saved={initial}
            saveTried={saveTried}
            analyticsOpen={experimentCardOpen}
            onAnalyticsOpen={(open) => onCardOpen("experiment", open)}
            lock={experiment}
          />
        </TabPanel>
      ) : null}
      {tab === "plan" && isTest ? (
        <TabPanel id="plan" animate={animate}>
          <EvaluationPlanTab
            wid={wid}
            siteId={site.id}
            experimentId={experiment.id}
            status={experiment.status}
            canEdit={canEdit}
            view={plan.view}
            form={plan.form}
            onForm={(f) => onPlan({ view: plan.view, form: f })}
            reason={planReason}
            onReason={onPlanReason}
            onSaved={(v) => {
              onPlan({ view: v, form: planFormState(v) });
              onPlanReason("");
            }}
            goals={goals}
            variants={experiment.variants ?? []}
            recording={recording}
            resultsStore={resultsStore}
            timeZone={site.timezone}
          />
        </TabPanel>
      ) : null}
      {tab === "results" && isTest ? (
        <TabPanel id="results" animate={animate}>
          {/* 終了のモーダル(採用の選択)は見出しの終了と同じもの(外枠が開く)。採用の記録し直しは管理者以上・終了したテストだけ */}
          <ResultsTab
            wid={wid}
            siteId={site.id}
            experiment={experiment}
            timeZone={site.timezone}
            goals={goals}
            canDuplicate={canEdit}
            onStop={onStop}
            canAdopt={(role === "owner" || role === "admin") && experiment.status === "archived"}
          />
        </TabPanel>
      ) : null}
      {tab === "variants" ? (
        <TabPanel id="variants" animate={animate}>
          <VariantsTab
            {...tabProps}
            memoRo={memoRo}
            siteId={site.id}
            experimentId={experiment.id}
            variantsLocked={variantsLocked}
            pageUrl={pageUrl}
            imageUpload={imageUpload}
            single={experiment.kind === "single"}
            selected={variant}
            onSelect={onVariant}
            animate={animate}
            names={site.analytics}
            savedVariants={initial.variants}
            cardOpen={cardOpen}
            onCardOpen={onCardOpen}
            emptyHtml={emptyHtml && emptyHtmlAt !== null ? { variantId: emptyHtml.variantId, changeIndex: emptyHtmlAt } : null}
            saveTried={saveTried}
          />
        </TabPanel>
      ) : null}
      {/* 終了したエクスペリエンスはメモだけを編集できるので、メモを変えたときだけ保存バーを出す */}
      {canEdit && (experiment.status !== "archived" || memoChanged) ? (
        <SaveBar dirty={dirty}>
          {weightSum !== 100 ? <span className="field-error">重みの合計が 100 ではありません({weightSum})</span> : null}
          {planDirty(plan.view, plan.form) ? <span className="muted" data-testid="plan-unsaved">評価計画に未保存の変更があります(評価計画のタブの「評価計画を保存」で保存します)</span> : null}
          <button type="button" className="btn" disabled={busy || !dirty} onClick={onDiscard}>
            破棄
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || weightSum !== 100} onClick={() => void save()}>
            {busy ? "保存中…" : "保存(下書き)"}
          </button>
        </SaveBar>
      ) : null}
    </div>
  );
}
