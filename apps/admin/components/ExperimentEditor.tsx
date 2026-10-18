"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiClientError } from "@/lib/client";
import { toChangeWire } from "@/lib/change-wire";
import { saveErrorMessage } from "@/lib/experiment-save";
import { draftOf, draftValueErrors, failedTab, isDirty, saveSteps, targetingBody, type Draft, type EditorTab } from "@/lib/experiment-draft";
import { treeProblem } from "@/lib/conditions";
import { emptyHtmlIndex, firstEmptyHtml } from "@/lib/change-issues";
import { analyticsCardOpenInitially } from "@/lib/analytics-badges";
import { replaceParam } from "@/lib/url-state";
import { previewPageUrl } from "@/lib/page-match";
import type { Audience, Experiment, Goal, Site } from "@/lib/types";
import { ErrorBox } from "./ErrorBox";
import { TabPanel, Tabs } from "./ui/Tabs";
import { SaveBar } from "./ui/SaveBar";
import { OverviewTab } from "./experiment/OverviewTab";
import { VariantsTab } from "./experiment/VariantsTab";

type Props = { site: Site; experiment: Experiment; goals: Goal[]; audiences: Audience[]; role: string; imageUpload: boolean; initialTab: EditorTab; initialVariant: string | null };
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
  return (
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
    />
  );
}

function ExperimentEditorBody({
  site, experiment, goals, audiences, role, imageUpload, tab, onTab, variant, onVariant, onDiscard, animate, cardOpen, onCardOpen,
}: BodyProps & { tab: EditorTab; onTab: (t: EditorTab) => void; variant: string | null; onVariant: (id: string | null) => void; onDiscard: () => void; animate: boolean; cardOpen: Record<string, boolean>; onCardOpen: (key: string, open: boolean) => void }) {
  const router = useRouter();
  const canEdit = role !== "viewer";
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
    setBusy(true);
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
  return (
    <div>
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
