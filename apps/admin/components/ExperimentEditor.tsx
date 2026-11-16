"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, ApiClientError, fieldErrors } from "@/lib/client";
import { toChangeWire } from "@/lib/change-wire";
import { historyStaleAfterSave, saveErrorMessage, saveSuccessNotice } from "@/lib/experiment-save";
import { tabsFor, discardTarget, draftOf, savedAfter, draftValueErrors, experimentPatchBody, failedTab, hasSteps, isDirty, isTrafficSent, acceptSavedDraft, reconcileServerUpdate, saveSteps, type Draft, type EditorTab } from "@/lib/experiment-draft";
import { extensionErrors, planDirty, planFormErrors, planFormState, planMode, planPutBody, syncPlanState, type PlanForm, type PlanView } from "@/lib/evaluation-plan";
import { archivedTestBanner, lockedFieldChanges, needsRunningTestConfirm, preSaveLockProblem, RUNNING_TEST_CONFIRM } from "@/lib/test-locks";
import { emptyHtmlIndex, firstEmptyHtml } from "@/lib/change-issues";
import { analyticsCardOpenInitially } from "@/lib/analytics-badges";
import { URL_PARAM_EVENT, editorParamsFromSearch, replaceParam } from "@/lib/url-state";
import { previewPageUrl } from "@/lib/page-match";
import { shouldPreloadAssets, type ImageFieldMode } from "@/lib/images";
import type { Audience, Experiment, Goal, Site } from "@/lib/types";
import { useConfirm } from "./ConfirmProvider";
import { ErrorBox } from "./ErrorBox";
import { useNow } from "./LocalTime";
import { BusyScope, useBusyAction } from "./ui/BusyScope";
import { TabPanel, Tabs } from "./ui/Tabs";
import { AppLink } from "./ui/AppLink";
import { SaveBar } from "./ui/SaveBar";
import { OverviewTab } from "./experiment/OverviewTab";
import { VariantsTab } from "./experiment/VariantsTab";
import { EvaluationPlanTab } from "./experiment/EvaluationPlanTab";
import { ResultsTab } from "./experiment/ResultsTab";
import { HistoryTab } from "./experiment/HistoryTab";
import { StopDialog, StopNotices } from "./experiment/StopDialog";
import { SiteAssetsProvider } from "./images/SiteAssetsProvider";
import type { ResultsResponse } from "@/lib/results-view";
import type { StopMessage } from "@/lib/stop-dialog";
import { useStatusChangeGuard } from "@/lib/status-guard";

/** 保存の結果の文(帯の左・本文の先頭) */
const REFRESH_TIMEOUT = "保存しました。画面の表示が古い可能性があります。再読み込みしてください";
const WRITE_UNKNOWN = "保存できたか分かりません。再読み込みして確かめてください";
const SERVER_UPDATED = "この画面を開いた後に、内容が更新されました";
const PLAN_NOTE = "評価計画は保存した時点で反映されます(公開は不要)";

/**
 * initialPlan = テストの評価計画(D9 ③ Task 14。パーソナライズと読めなかったときは null)。
 * recording = このサイトが結果を記録するか(Site の設定が有効で、導入に計測用のデータベースがある)。resultsStore = 導入に計測用のデータベースがあるか
 */
type Props = {
  site: Site; experiment: Experiment; goals: Goal[]; audiences: Audience[]; role: string; imageMode: ImageFieldMode; initialTab: EditorTab; initialVariant: string | null;
  wid: string; initialPlan: PlanView | null; recording: boolean; resultsStore: boolean;
};
/** 本体が使うのは initialTab / initialVariant を除いた分(開いているタブと Variant は外枠が持つ) */
type BodyProps = Omit<Props, "initialTab" | "initialVariant">;
type PlanState = { view: PlanView | null; form: PlanForm | null };

/**
 * 外枠。フォームの値(基準 base・下書き draft)・評価計画の入力・開いているタブと Variant を持ち、本体と保存の帯を範囲の部品(BusyScope)で包む。
 * B173 第 1 段(spec §6.1): 本体を key で作り直すのをやめた。保存・状態の変更の後の読み直しで新しいサーバーの値が届いても、
 * 未保存の変更があれば下書きを残す(reconcileServerUpdate)。だから読み直しが入力の途中に届いても、入力・開いているタブ・エラーの表示は消えない。
 * **ページはこの外枠に key を付けない**。URL の ?tab= / ?variant= は再読み込みと共有のための写しで、保存後の表示はこれに頼らない
 */
export function ExperimentEditor({ initialTab, initialVariant, ...body }: Props) {
  const [tab, setTab] = useState<EditorTab>(initialTab);
  const [variant, setVariant] = useState<string | null>(initialVariant);
  // 内側の「入ってくる」動き(.enter)は、この画面の中でタブ・Variant を切り替えた後だけ付ける(初回表示は外側の PageEnter が動くので重ねない)。
  // 作り直しが無くなったので、保存の後に動きが重なることも無い。一度切り替えたかだけを持つ
  const [switched, setSwitched] = useState(false);
  // 外部計測のカードの開閉(キー = "experiment" と `v:{パターン ID}`。パターン ID が "experiment" でもぶつからないよう前置きを付ける)。
  // まだ無いキーは、表示する側が最初の表示の規則(analyticsCardOpenInitially)で決めて書き込む
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({});
  const onCardOpen = useCallback((key: string, open: boolean) => setCardOpen((c) => (c[key] === open ? c : { ...c, [key]: open })), []);

  // ---- エクスペリエンスの値(spec §6.1)----
  // server = 最後に届いたサーバーの値。base = 未保存の判定と、PATCH に載せる欄を決める基準。draft = 画面の入力
  const server = useMemo(() => draftOf(body.experiment), [body.experiment]);
  // サーバーの値の鍵。メモだけの保存は updated_at を進めない(「未公開の編集あり」を付けないため。B77 K9)ので、メモの値も入れる
  const serverKey = `${body.experiment.updatedAt}:${JSON.stringify([body.experiment.description, (body.experiment.variants ?? []).map((v) => v.description)])}`;
  const [base, setBase] = useState<Draft>(server);
  const [draft, setDraft] = useState<Draft>(server);
  // 未保存の変更があるまま、新しいサーバーの値が届いた印(帯の左に注記を出す)
  const [notice, setNotice] = useState(false);
  // 自分の保存で送った値(B189)。書き込みの成功の後、画面が新しいサーバーの値になるまでの破棄の戻り先(持つ間は savedAfter が決める)。
  // 保存の後の読み直しが時間切れになると props は保存の前の値のままなので、それに戻さないために持つ
  const [saved, setSaved] = useState<Draft | null>(null);
  const [serverSeen, setServerSeen] = useState(serverKey);
  if (serverSeen !== serverKey) {
    // 描画中の state の調整(前の値を覚えて比べる。評価計画の planSeen と同じ形)。自分の保存では、書き込みの成功の直後(読み直しの前)に
    // base と draft を送った値にしてあるので、ここで未保存の変更が無いと判断され、届いた値(ほかの人が変えた欄も含む)がそのまま入る
    setServerSeen(serverKey);
    // 新しいサーバーの値が届いたので、破棄の戻り先はこちらにする(B189)。書き込みの成功(written)より前に届いた読み直しとは取り違えない
    // (後の written が送った値を持ち直す)。前の保存の時間切れの読み直しが written の後に遅れて届く場面は、直す前と同じ挙動(savedAfter のコメント)
    setSaved((s) => savedAfter(s, { kind: "serverArrived" }));
    const next = reconcileServerUpdate({ base, draft, server });
    setBase(next.base);
    setDraft(next.draft);
    // 注記を消すのは、未保存の変更が無いときの入れ替え・自分の保存の成功・破棄だけ(未保存のまま 2 回目が届いて基準と同じでも消さない)
    setNotice((n) => (next.notice ? true : isDirty(base, draft) ? n : false));
  }

  // 評価計画(テストだけ。D9 ③)の入力。ページが読み直した計画(initialPlan)が変わったら syncPlanState で置き換える
  // (未保存の入力があれば入力は残し、比べる計画だけ新しくする)。描画中の state の調整(前の値を覚えて比べる)
  const planKey = JSON.stringify(body.initialPlan);
  const [plan, setPlan] = useState<PlanState>(() => ({ view: body.initialPlan, form: body.initialPlan ? planFormState(body.initialPlan) : null }));
  const [planSeen, setPlanSeen] = useState(planKey);
  if (planSeen !== planKey) {
    setPlanSeen(planKey);
    setPlan((p) => syncPlanState(p, body.initialPlan));
  }
  const [planReason, setPlanReason] = useState("");
  // 変更履歴のタブの読み直しの印(B129 spec §7.1)。自分の保存の書き込みが成功するたびに進める(タブを開いていれば、タブの中で読み直す)。
  // 途中の段まで書けて失敗したとき・書けたか分からないときも進める(onHistoryStale。B129 final review)
  const [savedCount, setSavedCount] = useState(0);
  const bodyDirty = isDirty(base, draft);
  const planIsDirty = planDirty(plan.view, plan.form);

  /**
   * 破棄(Q20): 本体と評価計画の入力・延ばすときの理由を、最後に確かめた保存済みの値に戻す。本体は、自分の保存の後に新しいサーバーの値が
   * 届いていなければ送った値、届いていればその値(B189)。評価計画は PUT の応答を基準にしてあるので、その値
   */
  const resetToServer = () => {
    const back = discardTarget({ server, saved });
    setBase(back);
    setDraft(back);
    setNotice(false);
    setPlan((p) => ({ view: p.view, form: p.view ? planFormState(p.view) : null }));
    setPlanReason("");
  };
  /**
   * 自分の保存が成功した直後(読み直しの前): 基準を送った値にし、評価計画は PUT の応答で置き換える。
   * 下書きは上書きしない(保存を始めた後の変更 = 例えば IMAGE の欄のアップロードの完了は、未保存として残す。acceptSavedDraft)
   */
  const acceptSaved = (sent: Draft, fresh: PlanView | null) => {
    setBase(sent);
    setDraft((current) => acceptSavedDraft(sent, current).draft);
    setSaved((s) => savedAfter(s, { kind: "written", sent }));
    setNotice(false);
    setPlanReason("");
    if (fresh) setPlan({ view: fresh, form: planFormState(fresh) });
    setSavedCount((n) => n + 1);
  };

  // B68: 同じ画面の中のリンク(状態を変えるボタンの「公開できない画像」の一覧の、このエクスペリエンスの行)は遷移せず、
  // replaceParam で ?tab= / ?variant= を書く。その知らせ(URL_PARAM_EVENT)で URL を読み、開いているタブとパターンをそろえる(往復 0。key で作り直さない)。
  // 自分の onTab・onVariant の replaceParam でも届くが、読んだ値は今の値と同じなので何も変わらない
  const current = useRef({ tab, variant });
  current.current = { tab, variant };
  const kind = body.experiment.kind;
  useEffect(() => {
    const align = () => {
      const next = editorParamsFromSearch(window.location.search, tabsFor(kind));
      const now = current.current;
      if (next.tab === now.tab && next.variant === now.variant) return;
      setSwitched(true);
      setTab(next.tab);
      setVariant(next.variant);
    };
    window.addEventListener(URL_PARAM_EVENT, align);
    return () => window.removeEventListener(URL_PARAM_EVENT, align);
  }, [kind]);

  // 離れる前の確認(本体と評価計画の未保存・保存の途中)は、下の BusyScope の dirty を見る PageLeaveGuard(app/w/layout.tsx)が出す
  // 状態の変更の前の確かめ: 未保存の変更があれば終了のモーダルを開かない(B173 第 1 段)
  const statusGuard = useStatusChangeGuard();
  // 終了のモーダル(D9 ③ Task 16): 結果のタブの帯の「終了して採用を記録」「採用なしで終了」から開く。開始・終了は管理者以上(設計書 §10)
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
          // 画面の読み直しは終了のモーダルの中で済んでいる(ここで読み直すと 2 回になる。B173 第 2 段)
        }}
      />
    ) : null}
    {/* 範囲は本体全体(下の保存の帯も含む)。保存中は覆って入力と帯のボタンを止める */}
    <BusyScope id="experiment-editor" dirty={bodyDirty || planIsDirty}>
      {/* B68: サイトの画像の一覧(IMAGE の変更がある下書きだけマウントの後に 1 回読む)と「画像を選ぶ」の窓。パターンを切り替えても消えないよう本体の外に置く */}
      <SiteAssetsProvider siteId={body.site.id} mode={body.imageMode} preload={shouldPreloadAssets(body.imageMode, body.experiment.variants ?? [])}>
      <ExperimentEditorBody
        {...body}
        tab={tab}
        onTab={(t) => {
          setSwitched(true);
          setTab(t);
          replaceParam("tab", t === "overview" ? null : t);
        }}
        variant={variant}
        onVariant={(id) => {
          setSwitched(true);
          setVariant(id);
          replaceParam("variant", id);
        }}
        animate={switched}
        historyKey={`${savedCount}:${body.experiment.status}`}
        cardOpen={cardOpen}
        onCardOpen={onCardOpen}
        base={base}
        draft={draft}
        setDraft={setDraft}
        notice={notice}
        onResetToServer={resetToServer}
        onSaved={acceptSaved}
        onHistoryStale={() => setSavedCount((n) => n + 1)}
        onRefreshed={(timedOut) => setSaved((s) => savedAfter(s, { kind: "refreshed", timedOut }))}
        plan={plan}
        onPlan={setPlan}
        planReason={planReason}
        onPlanReason={setPlanReason}
        onStop={canAdmin && stoppable ? async (variantId, report) => {
          if (!(await statusGuard())) return;
          setStopNotices(null);
          setStop({ variantId, report });
        } : undefined}
      />
      </SiteAssetsProvider>
    </BusyScope>
    </>
  );
}

function ExperimentEditorBody({
  site, experiment, goals, audiences, role, imageMode, tab, onTab, variant, onVariant, animate, historyKey, cardOpen, onCardOpen, wid, recording, resultsStore,
  base, draft, setDraft, notice, onResetToServer, onSaved, onHistoryStale, onRefreshed, plan, onPlan, planReason, onPlanReason, onStop,
}: BodyProps & {
  tab: EditorTab; onTab: (t: EditorTab) => void; variant: string | null; onVariant: (id: string | null) => void; animate: boolean; cardOpen: Record<string, boolean>; onCardOpen: (key: string, open: boolean) => void;
  /** 変更履歴のタブの読み直しの鍵(自分の保存で記録が増えた(かもしれない)回数と状態。外枠が作る) */
  historyKey: string;
  /** 基準(未保存の判定と PATCH に載せる欄の基準)・下書き・注記の印(外枠が持つ) */
  base: Draft; draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; notice: boolean;
  /** 破棄: 本体と評価計画を最後に確かめた保存済みの値に戻す(外枠の resetToServer) */
  onResetToServer: () => void;
  /** 保存の書き込みが成功した直後(読み直しの前)。sent = 送った下書き、fresh = 評価計画の PUT の応答(送らなければ null) */
  onSaved: (sent: Draft, fresh: PlanView | null) => void;
  /** 全段の成功のほかで、記録が増えた(かもしれない)保存の後: 途中の段まで書けて失敗した・書けたか分からない(変更履歴のタブを読み直す) */
  onHistoryStale: () => void;
  /** 保存の後の読み直しが終わった(timedOut = 10 秒で反映されなかった)。破棄の戻り先の持ち方を決める(B189) */
  onRefreshed: (timedOut: boolean) => void;
  /** 評価計画の状態(外枠が持つ) */
  plan: PlanState; onPlan: (p: PlanState) => void; planReason: string; onPlanReason: (r: string) => void;
  /** 結果のタブの帯から終了のモーダルを開く(管理者以上・実行中か一時停止中のテストだけ。外枠が渡す) */
  onStop?: (variantId: string | null, report: ResultsResponse) => void;
}) {
  const ask = useConfirm();
  const { busy, run } = useBusyAction();
  const now = useNow();
  const canEdit = role !== "viewer";
  const isTest = experiment.kind === "test";
  const [error, setError] = useState<string | null>(null);
  const [errorTabs, setErrorTabs] = useState<EditorTab[]>([]);
  const [attrHint, setAttrHint] = useState<{ variantIdx: number; changeIdx: number } | null>(null);
  // 保存を試したか(ruling R12: それまではキーが空の行に「値を入力してください」を出さない)。保存の成功・破棄で戻す
  const [saveTried, setSaveTried] = useState(false);
  // B8: 保存の前に見つけた空の HTML の変更。利用者がその欄を直したら消す(位置がずれても追えるよう変更の id で持つ)
  const [emptyHtml, setEmptyHtml] = useState<{ variantId: string; changeId: string } | null>(null);
  // 保存の成功の文(帯の左。変更が無い間だけ出る)。次に欄を変えたら消す
  const [savedNotice, setSavedNotice] = useState<ReturnType<typeof saveSuccessNotice> | null>(null);
  const savedMessage = savedNotice?.message ?? null;
  // 評価計画の段で control が返した欄のエラー(評価計画のタブの欄の下に出す)
  const [planServerFields, setPlanServerFields] = useState<Record<string, string>>({});
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSavedNotice(null);
    if (key === "variants" && emptyHtml && emptyHtmlIndex(value as Draft["variants"], emptyHtml) === null) setEmptyHtml(null);
  };
  const { urlMatch, variants } = draft;
  // プレビューの URL は and を持つ行で正規表現のコンパイルと照合をするので、対象 URL とドメインが変わったときだけ計算する(B69 追補 §4)
  const pageUrl = useMemo(() => previewPageUrl(site.domain, urlMatch), [site.domain, urlMatch]);
  const weightSum = variants.reduce((a, v) => a + v.weight, 0);
  // control の `PUT …/variants` は draft の Experiment にしか使えない(409 experiment_active)。
  // 非 draft ではパターンの集合を編集できなくし、保存でもこのエンドポイントを叩かない(saveSteps が決める)
  const variantsLocked = experiment.status !== "draft";
  const bodyDirty = isDirty(base, draft);
  const planIsDirty = planDirty(plan.view, plan.form);
  // 評価計画の場面(延ばすときは確認・理由・延ばす向きの検査が要る)。時刻はマウントの後に分かる(useNow)
  const planModeNow = plan.view ? planMode({ status: experiment.status, canEdit, view: plan.view, now }) : null;
  const steps = saveSteps(base, draft, experiment.status, { dirty: planIsDirty });
  const memoChanged = steps.experimentMemo || steps.variantMemos.length > 0;
  const emptyHtmlAt = emptyHtml ? emptyHtmlIndex(variants, emptyHtml) : null;
  // 変更履歴の採用の記録はパターンの ID だけを持つので、保存済みのパターンの名前を渡す
  const variantNames = useMemo(() => Object.fromEntries((experiment.variants ?? []).map((v) => [v.id, v.name])), [experiment.variants]);

  // エクスペリエンスの外部計測のカード: まだ開閉を覚えていなければ、基本設定を最初に表示したときの規則で決めてすぐ覚える
  // (設定があれば開き、なければ畳む。編集中に設定を全部消しても勝手に閉じない。B77 Q30b。パターンのカードは VariantsTab が同じことをする)
  const experimentCardInitially = analyticsCardOpenInitially(draft.expName, draft.extra);
  const experimentCardOpen = cardOpen.experiment ?? experimentCardInitially;
  useEffect(() => {
    if (tab === "overview" && !("experiment" in cardOpen)) onCardOpen("experiment", experimentCardInitially);
  }, [tab, cardOpen, experimentCardInitially, onCardOpen]);

  /** 保存の成功・破棄で、保存の前の確かめとエラーの表示を初期に戻す */
  function resetLocal() {
    setSaveTried(false);
    setEmptyHtml(null);
    setAttrHint(null);
    setError(null);
    setErrorTabs([]);
    setPlanServerFields({});
  }
  function discard() {
    onResetToServer();
    resetLocal();
    setSavedNotice(null);
  }

  /**
   * (1) 保存の前の確かめ(B77 K17)。止めるときは理由を出して true を返す(API は呼ばない)。
   * 配信条件の入力漏れ → 外部計測の値(変えた値と新しい値だけ)→ 空の HTML の変更(B8)→ 評価計画の入力(B173 第 1 段)の順に見る。値の最終的な検査は control。
   * 配信率・配信条件は、送る PATCH にその欄が載るときだけ見る(メモだけ・名前だけの保存を、送らない欄で止めない)
   */
  function blockedBeforeSave(): boolean {
    // D9 ③(設計書 §5.5): 実行中・一時停止中のテストは配信率を下げられない(control の 409 test_setting_locked を先に示す)。
    // 配信率・配信条件は、実際に送る PATCH に載るときだけ見る(最終レビュー FR-Medium-1: 開いた後にほかの人が上げた配信率で、名前だけの保存を止めない)
    const problem = steps.patchExperiment ? preSaveLockProblem(experiment, experimentPatchBody(base, draft), draft, site.retentionDays) : null;
    if (problem) {
      setErrorTabs(["overview"]);
      setError(problem);
      return true;
    }
    const valueErrors = draftValueErrors(base, draft);
    if (valueErrors.length > 0) {
      // 問題のある欄が見えるように、そのカードを開き、パターンなら最初のものを選ぶ
      const onExperiment = valueErrors.some((e) => e.path[0] === "analytics");
      const variantIds = [...new Set(valueErrors.filter((e) => e.path[0] === "variants").map((e) => e.path[1]!))];
      if (onExperiment) onCardOpen("experiment", true);
      for (const id of variantIds) onCardOpen(`v:${id}`, true);
      if (variantIds[0]) onVariant(variantIds[0]);
      setErrorTabs([...(onExperiment ? ["overview" as const] : []), ...(variantIds.length ? ["variants" as const] : [])]);
      setError("外部計測(dataLayer 出力)に保存できない値があります。欄の下の案内に沿って直してください");
      return true;
    }
    // オリジナルと終了したエクスペリエンスの変更は送らないので、送るパターンだけを見る
    const empty = firstEmptyHtml(variants.filter((v) => steps.putChanges.includes(v.id)));
    if (empty) {
      const changeId = variants.find((v) => v.id === empty.variantId)!.changes[empty.changeIndex]!.id;
      setEmptyHtml({ variantId: empty.variantId, changeId });
      onVariant(empty.variantId);
      setErrorTabs(["variants"]);
      setError("HTML の変更に、HTML が入っていないものがあります");
      return true;
    }
    // 評価計画の型のエラー(延ばすときは延ばす向きでない入力も)。欄の下の文は評価計画のタブが出す
    if (plan.view && plan.form && (planModeNow === "draft" || planModeNow === "extend")) {
      const planErrors = { ...planFormErrors(plan.form), ...(planModeNow === "extend" ? extensionErrors(plan.view.plan, plan.form) : {}) };
      if (Object.keys(planErrors).length > 0) {
        setErrorTabs(["plan"]);
        setError("評価計画に直す欄があります");
        return true;
      }
    }
    return false;
  }

  async function save() {
    setError(null);
    setErrorTabs([]);
    setAttrHint(null);
    setSavedNotice(null);
    setPlanServerFields({});
    setSaveTried(true);
    if (blockedBeforeSave()) return;
    // 送るものが無い(isDirty の偽陽性)なら、破棄と同じにする(control は呼ばない。覆わない)
    if (!hasSteps(steps)) {
      discard();
      return;
    }
    // 送る値は押した時点のもの(覆いの間は入力できないが、確認の間の値の変化も拾わないよう閉じ込める)
    const sent = draft;
    const sentBase = base;
    const planBody = steps.putPlan && plan.view && plan.form ? planPutBody(plan.form, plan.view.plan, planModeNow === "extend" ? planReason : undefined) : null;
    const extending = planBody !== null && planModeNow === "extend";
    const runningTestConfirm = needsRunningTestConfirm(experiment, lockedFieldChanges(sentBase, sent));
    const path = `/sites/${site.id}/experiments/${experiment.id}`;
    // 途中の段が落ちたとき、どこまで送れたか(文言と印を付けるタブを決める)。write の中で書き換えるので、let の絞り込みに掛からない入れ物にする
    const progress: { savedSomething: boolean; stage: "patch" | "variants" | "changes" | "plan" } = { savedSomething: false, stage: "patch" };
    const outcome = await run<{ fresh: PlanView | null }>({
      // 確認は覆う前に済ませる。D9 ③(設計書 §5.5): 実行中・一時停止中のテストの Change・対象 URL・配信条件を保存するときは 1 回確認する。
      // 開始後に評価計画を延ばすときも確認する(延ばした後は元に戻せないため)
      confirm: async () => {
        if (runningTestConfirm && !(await ask({ title: "実行中のテストを変更しますか?", body: RUNNING_TEST_CONFIRM, confirmLabel: "保存する", tone: "primary" }))) return false;
        if (
          extending &&
          !(await ask({
            title: "評価計画を延ばしますか?",
            body: "変更は日時・変更した人・前後の値とともに記録され、結果の画面に表示されます。延ばした後は元に戻せません(短くする変更はできません)",
            confirmLabel: "延ばして保存",
            tone: "primary",
          }))
        )
          return false;
        return true;
      },
      // 段の順は (2) 本体 → (3) メモ → (4) パターンの集合 → (5) パターンのメモ → (6) Change → (7) 評価計画。評価計画を最後にするのは、
      // ほかの段が落ちたときに評価計画だけが反映されないように(評価計画は公開を待たずに効く)。
      // 各段の前に打ち切りの合図を見る(30 秒の上限の後に残りの段を送らない)
      write: async (signal) => {
        const init = { signal };
        // (2) エクスペリエンスの欄。自分が変えた欄だけを載せる(開いた後にほかの人が変えた欄を上書きしない。spec §6.1)
        if (steps.patchExperiment) {
          signal.throwIfAborted();
          await api("PATCH", path, experimentPatchBody(sentBase, sent), init);
          progress.savedSomething = true;
        }
        // (3) エクスペリエンスのメモ。description だけの PATCH は状態を問わず受けられ、未公開の印を付けない
        if (steps.experimentMemo) {
          signal.throwIfAborted();
          await api("PATCH", path, { description: sent.description }, init);
          progress.savedSomething = true;
        }
        progress.stage = "variants";
        // (4) パターンの集合(下書きだけ)。メモはこの body に載せない((5) で送る)
        if (steps.putVariants) {
          signal.throwIfAborted();
          await api(
            "PUT",
            `${path}/variants`,
            sent.variants.map((v) => ({ id: v.id, name: v.name, weight: v.weight, original: v.original, analytics: v.analytics && (v.analytics.overrides || v.analytics.extra) ? v.analytics : null })),
            init,
          );
          progress.savedSomething = true;
        }
        // (5) メモが変わったパターンごと(状態を問わない。新しいパターンは (4) で作られた後に送る)
        for (const id of steps.variantMemos) {
          signal.throwIfAborted();
          try {
            await api("PATCH", `${path}/variants/${id}`, { description: sent.variants.find((v) => v.id === id)!.description }, init);
          } catch (e) {
            onVariant(id); // 落ちたパターンを開く
            throw e;
          }
          progress.savedSomething = true;
        }
        progress.stage = "changes";
        // (6) 変更が変わった、オリジナルでないパターンごと
        for (const id of steps.putChanges) {
          signal.throwIfAborted();
          const vi = sent.variants.findIndex((v) => v.id === id);
          const v = sent.variants[vi]!;
          try {
            await api("PUT", `${path}/variants/${v.id}/changes`, v.changes.map(toChangeWire), init);
          } catch (e) {
            if (e instanceof ApiClientError && e.code === "attribute_not_allowed") {
              const ci = v.changes.findIndex((c) => c.type === "ATTRIBUTE" && (c.payload as { name?: string }).name === e.extra.attribute);
              // 一致する ATTRIBUTE Change がローカルに無いときはバナーを出さない(押しても何も変換しない操作になるため)
              if (ci >= 0) setAttrHint({ variantIdx: vi, changeIdx: ci });
            }
            onVariant(v.id); // 落ちた Variant を開く
            throw e;
          }
          progress.savedSomething = true;
        }
        // (7) 評価計画(変わっていれば。応答は保存した計画で、読み直しを待たずに入力の基準にする)
        let fresh: PlanView | null = null;
        if (planBody) {
          progress.stage = "plan";
          signal.throwIfAborted();
          fresh = await api<PlanView>("PUT", `${path}/evaluation-plan`, planBody, init);
          progress.savedSomething = true;
        }
        return { fresh };
      },
      // 書き込みの成功の直後・読み直しの前に、基準を送った値にする(読み直しで届く値が、未保存にも注記にもならないように)
      onWritten: ({ fresh }) => {
        onSaved(sent, fresh);
        resetLocal();
      },
      after: "refresh",
    });
    if (historyStaleAfterSave(outcome, progress.savedSomething)) onHistoryStale();
    switch (outcome.kind) {
      case "saved":
        onRefreshed(outcome.refresh !== "done"); // 反映を確かめられたときだけ戻り先を捨てる(この保存は after: "refresh" なので skipped にはならない)
        // 書き込みは済んでいるので、読み直しが時間切れでも保存結果と公開の案内を残す。再読み込みの案内は本文の先頭に出す
        if (outcome.refresh === "timeout") setError(REFRESH_TIMEOUT);
        setSavedNotice(saveSuccessNotice(steps));
        return;
      case "failed": {
        // 途中の段の失敗ではページの読み直し(router.refresh)はしない(変更履歴のタブは onHistoryStale で読み直す):
        // 読み直すと、エラーの表示と「HTML タイプに切り替える」の導線を、届いた値で消すおそれがあるため。
        // 手動の再読み込みを促すに留める(saveErrorMessage)
        const e = outcome.error;
        const errPath = e instanceof ApiClientError ? (e.extra.issues?.[0]?.path ?? e.extra.path) : undefined;
        const first = Array.isArray(errPath) ? errPath[0] : typeof errPath === "string" ? errPath.split(".")[0] : undefined;
        // ApiClientError 以外(通信の失敗など)は、エクスペリエンスの段なら基本設定、評価計画の段なら評価計画、それ以外は印を付けない
        const { stage, savedSomething } = progress;
        const where: EditorTab | null =
          e instanceof ApiClientError ? failedTab(stage, first === undefined ? undefined : String(first)) : stage === "patch" ? "overview" : stage === "plan" ? "plan" : null;
        setErrorTabs(where ? [where] : []);
        setError(saveErrorMessage(e, savedSomething));
        if (stage === "plan") setPlanServerFields(fieldErrors(e));
        return;
      }
      case "unknown":
        setError(WRITE_UNKNOWN);
        return;
      default:
        // discarded(別の画面へ移り始めた)・cancelled(確認で取りやめた)・ignored(実行中)は何も出さない
        return;
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
          { id: "overview", label: "基本設定", marked: errorTabs.includes("overview") && tab !== "overview" },
          { id: "variants", label: "パターン", marked: (errorTabs.includes("variants") || weightSum !== 100) && tab !== "variants" },
          // 評価計画と結果はテストだけ。結果は下書きでは押せない(「開始後に表示されます」。設計書 §10)
          ...(isTest
            ? [
                { id: "plan", label: "評価計画", marked: errorTabs.includes("plan") && tab !== "plan" },
                { id: "results", label: "結果", disabled: experiment.status === "draft", hint: experiment.status === "draft" ? "開始後に表示されます" : undefined },
              ]
            : []),
          // B129 spec §7.1: 変更履歴は全員・両方の種別に出し、最後に置く(パーソナライズではパターンの次)
          { id: "history", label: "変更履歴" },
        ]}
      />
      {tab === "overview" ? (
        <TabPanel id="overview" animate={animate}>
          <OverviewTab
            {...tabProps}
            memoRo={memoRo}
            goals={goals}
            goalsHref={`/w/${wid}/sites/${site.id}/goals`}
            audiences={audiences}
            site={site}
            experimentId={experiment.id}
            saved={base}
            saveTried={saveTried}
            analyticsOpen={experimentCardOpen}
            onAnalyticsOpen={(open) => onCardOpen("experiment", open)}
            lock={experiment}
            trafficSent={isTrafficSent(base, draft)}
          />
        </TabPanel>
      ) : null}
      {tab === "plan" && isTest ? (
        <TabPanel id="plan" animate={animate}>
          <EvaluationPlanTab
            wid={wid}
            siteId={site.id}
            status={experiment.status}
            canEdit={canEdit}
            view={plan.view}
            form={plan.form}
            onForm={(f) => {
              onPlan({ view: plan.view, form: f });
              setSavedNotice(null);
            }}
            reason={planReason}
            onReason={onPlanReason}
            serverFields={planServerFields}
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
      {tab === "history" ? (
        <TabPanel id="history" animate={animate}>
          {/* タブを開いている間だけ描く = 開くまで変更履歴を読まない(エクスペリエンスの画面の要求数を変えない。spec §10.6) */}
          <HistoryTab
            siteId={site.id}
            experimentId={experiment.id}
            publishHistoryHref={`/w/${wid}/sites/${site.id}/history`}
            createdAt={experiment.createdAt}
            variantNames={variantNames}
            reloadKey={historyKey}
          />
        </TabPanel>
      ) : null}
      {tab === "variants" ? (
        <TabPanel id="variants" animate={animate}>
          <VariantsTab
            {...tabProps}
            memoRo={memoRo}
            experimentId={experiment.id}
            variantsLocked={variantsLocked}
            pageUrl={pageUrl}
            imageMode={imageMode}
            single={experiment.kind === "single"}
            selected={variant}
            onSelect={onVariant}
            animate={animate}
            names={site.analytics}
            savedVariants={base.variants}
            cardOpen={cardOpen}
            onCardOpen={onCardOpen}
            emptyHtml={emptyHtml && emptyHtmlAt !== null ? { variantId: emptyHtml.variantId, changeIndex: emptyHtmlAt } : null}
            saveTried={saveTried}
          />
        </TabPanel>
      ) : null}
      {/* 終了したエクスペリエンスはメモだけを編集できるので、メモを変えたときだけ保存バーを出す(評価計画の変更も帯で保存する)。
          保存の成功の文を持っている間も出す(保存で変更が無くなっても、帯の左の「保存しました」で成功を知らせるため。文は次に欄を変えたとき・破棄で消え、帯もそこで消える) */}
      {canEdit && (experiment.status !== "archived" || memoChanged || planIsDirty || savedMessage !== null) ? (
        <SaveBar dirty={bodyDirty || planIsDirty} message={savedMessage}>
          {savedNotice?.needsPublish && (role === "owner" || role === "admin") ? (
            <AppLink href={`/w/${wid}/sites/${site.id}/publish`} className="btn">公開画面へ</AppLink>
          ) : null}
          {notice ? (
            <span className="muted" data-testid="server-updated">
              {SERVER_UPDATED}
            </span>
          ) : null}
          {weightSum !== 100 ? <span className="field-error">重みの合計が 100 ではありません({weightSum})</span> : null}
          {planIsDirty ? (
            <span className="muted" data-testid="plan-unsaved">
              {PLAN_NOTE}
            </span>
          ) : null}
          <button type="button" className="btn" disabled={busy || !(bodyDirty || planIsDirty)} onClick={discard}>
            破棄
          </button>
          {/* 保存中の表示は範囲の覆い(「保存中…」)が出すので、ボタンの文言は変えない */}
          <button type="button" className="btn btn-primary" disabled={busy || weightSum !== 100} onClick={() => void save()}>
            {experiment.status === "archived" ? "保存(メモ)" : "保存(下書き)"}
          </button>
          {savedNotice?.needsPublish && (role === "editor" || (isTest && (experiment.status === "running" || experiment.status === "paused"))) ? (
            <p data-testid="saved-publish-guidance" className="muted" style={{ flexBasis: "100%", margin: 0 }}>
              {role === "editor" ? "公開は管理者以上が行います。管理者にサイトの公開を依頼してください。" : null}
              {isTest && (experiment.status === "running" || experiment.status === "paused") ? "開始後に編集して公開しても、変更の前と後の結果は合算されます。大きく変える場合は、複製して新しいテストを開始してください。" : null}
            </p>
          ) : null}
        </SaveBar>
      ) : null}
    </div>
  );
}
