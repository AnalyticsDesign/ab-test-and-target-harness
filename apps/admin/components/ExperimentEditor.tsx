"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiClientError } from "@/lib/client";
import { toChangeWire } from "@/lib/change-wire";
import { saveErrorMessage } from "@/lib/experiment-save";
import { draftOf, failedTab, isDirty, targetingBody, type Draft, type EditorTab } from "@/lib/experiment-draft";
import { treeProblem } from "@/lib/conditions";
import { replaceParam } from "@/lib/url-state";
import { previewPageUrl } from "@/lib/page-match";
import type { Audience, Experiment, Goal, Site } from "@/lib/types";
import { ErrorBox } from "./ErrorBox";
import { TabPanel, Tabs } from "./ui/Tabs";
import { SaveBar } from "./ui/SaveBar";
import { OverviewTab } from "./experiment/OverviewTab";
import { AnalyticsTab } from "./experiment/AnalyticsTab";
import { VariantsTab } from "./experiment/VariantsTab";

type Props = { site: Site; experiment: Experiment; goals: Goal[]; audiences: Audience[]; role: string; imageUpload: boolean; initialTab: EditorTab; initialVariant: string | null };
/** 本体が使うのは initialTab / initialVariant を除いた分(開いているタブと Variant は外枠が持つ) */
type BodyProps = Omit<Props, "initialTab" | "initialVariant">;

/**
 * 外枠。「破棄」は本体を作り直すだけ(control は呼ばない。設計書 4.4)。
 * 開いているタブと Variant は外枠が持つ。**ページはこの外枠に key を付けない**: 外枠は保存後の router.refresh() をまたいで残り、
 * 作り直されるのは本体だけ(key = updatedAt と破棄の世代)。だから破棄しても保存しても、見ている場所は変わらない。
 * URL の ?tab= / ?variant= は再読み込みと共有のための写しで、保存後の表示はこれに頼らない
 */
export function ExperimentEditor({ initialTab, initialVariant, ...body }: Props) {
  const [generation, setGeneration] = useState(0);
  const [tab, setTab] = useState<EditorTab>(initialTab);
  const [variant, setVariant] = useState<string | null>(initialVariant);
  // updatedAt: 保存で server 側が更新されるたびに本体を作り直し、フォームを最新の値で初期化する(prop の変更だけでは useState は再初期化されない)
  const bodyKey = `${body.experiment.updatedAt}:${generation}`;
  // 内側の「入ってくる」動き(.enter)は、この本体の中でタブ・Variant を切り替えた後だけ付ける:
  // 初回表示は外側(PageEnter)が動くので重ねない / 保存・破棄で本体を作り直した直後も動かさない(見ている場所は変わらないため)。
  // そのため「どの本体で切り替えたか」を key で覚え、本体が変わったら切替前の状態に戻す
  const [switchedIn, setSwitchedIn] = useState<string | null>(null);
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
    />
  );
}

function ExperimentEditorBody({ site, experiment, goals, audiences, role, imageUpload, tab, onTab, variant, onVariant, onDiscard, animate }: BodyProps & { tab: EditorTab; onTab: (t: EditorTab) => void; variant: string | null; onVariant: (id: string | null) => void; onDiscard: () => void; animate: boolean }) {
  const router = useRouter();
  const canEdit = role !== "viewer";
  const initial = useMemo(() => draftOf(experiment), [experiment]);
  const [draft, setDraft] = useState<Draft>(initial);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorTab, setErrorTab] = useState<EditorTab | null>(null);
  const [attrHint, setAttrHint] = useState<{ variantIdx: number; changeIdx: number } | null>(null);
  const { urlMatch, variants } = draft;
  const pageUrl = previewPageUrl(site.domain, urlMatch);
  const weightSum = variants.reduce((a, v) => a + v.weight, 0);
  // control の `PUT …/variants` は draft の Experiment にしか使えない(409 experiment_active)。
  // 非 draft では保存時もこのエンドポイントを叩かない(叩けば Change の保存も含めて丸ごと 409 で失敗してしまうため)
  const variantsLocked = experiment.status !== "draft";
  const dirty = isDirty(initial, draft);

  async function save() {
    setBusy(true);
    setError(null);
    setErrorTab(null);
    setAttrHint(null);
    // 外枠は `key={updatedAt}` でこの本体を再マウントする(成功時の router.refresh() が
    // 本当に「最新の表示」にするため)。だが部分適用の失敗時にここで router.refresh() を呼ぶと、再マウントで
    // エラーバナーや「HTML タイプに切り替える」導線ごと消える(422 が返っているのに画面には何も出ない)。
    // そのため部分適用の失敗時は自動 refresh をせず、手動の再読み込みを促すに留める
    let savedSomething = false;
    let stage: "patch" | "variants" | "changes" = "patch";
    try {
      // 保存の前に入力漏れを知らせる(値の最終的な検査は control)。画面で表せない保存値(raw)は送らない
      const problem = draft.targeting.kind === "form" ? treeProblem(draft.targeting.form.rows, site.retentionDays) : null;
      if (problem) throw new Error(problem);
      const { expName, extra } = draft;
      await api("PATCH", `/sites/${site.id}/experiments/${experiment.id}`, {
        name: draft.name,
        urlMatch,
        ...targetingBody(draft.targeting),
        trafficPercentage: draft.traffic,
        persistAssignment: draft.persist,
        analytics: expName || Object.keys(extra).length ? { ...(expName ? { overrides: { experimentName: expName } } : {}), ...(Object.keys(extra).length ? { extra } : {}) } : null,
      });
      savedSomething = true;
      stage = "variants";
      if (!variantsLocked) {
        await api("PUT", `/sites/${site.id}/experiments/${experiment.id}/variants`, variants.map((v) => ({ id: v.id, name: v.name, weight: v.weight, analytics: v.analytics && (v.analytics.overrides || v.analytics.extra) ? v.analytics : null })));
      }
      stage = "changes";
      for (const [vi, v] of variants.entries()) {
        try {
          await api("PUT", `/sites/${site.id}/experiments/${experiment.id}/variants/${v.id}/changes`, v.changes.map(toChangeWire));
        } catch (e) {
          if (e instanceof ApiClientError && e.code === "attribute_not_allowed") {
            const ci = v.changes.findIndex((c) => c.type === "ATTRIBUTE" && (c.payload as { name?: string }).name === e.extra.attribute);
            // 一致する ATTRIBUTE Change がローカルに無いときはバナーを出さない(押しても何も変換しない操作になるため)
            if (ci >= 0) setAttrHint({ variantIdx: vi, changeIdx: ci });
          }
          onVariant(v.id); // 落ちた Variant を開く
          throw e;
        }
      }
      router.refresh();
    } catch (e) {
      const path = e instanceof ApiClientError ? (e.extra.issues?.[0]?.path ?? e.extra.path) : undefined;
      const first = Array.isArray(path) ? path[0] : typeof path === "string" ? path.split(".")[0] : undefined;
      // ApiClientError 以外で落ちるのは保存の前の確認(PATCH の前)だけ = 概要タブ
      const where: EditorTab | null = e instanceof ApiClientError ? failedTab(stage, first === undefined ? undefined : String(first)) : stage === "patch" ? "overview" : null;
      setErrorTab(where);
      setError(saveErrorMessage(e, savedSomething));
    } finally {
      setBusy(false);
    }
  }

  const ro = !canEdit || busy || experiment.status === "archived";
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
          { id: "overview", label: "概要", marked: errorTab === "overview" && tab !== "overview" },
          { id: "variants", label: "パターン", marked: (errorTab === "variants" || weightSum !== 100) && tab !== "variants" },
          { id: "analytics", label: "外部計測", marked: errorTab === "analytics" && tab !== "analytics" },
        ]}
      />
      {tab === "overview" ? (
        <TabPanel id="overview" animate={animate}>
          <OverviewTab {...tabProps} goals={goals} audiences={audiences} site={site} />
        </TabPanel>
      ) : null}
      {tab === "variants" ? (
        <TabPanel id="variants" animate={animate}>
          <VariantsTab {...tabProps} siteId={site.id} experimentId={experiment.id} variantsLocked={variantsLocked} pageUrl={pageUrl} imageUpload={imageUpload} selected={variant} onSelect={onVariant} animate={animate} />
        </TabPanel>
      ) : null}
      {tab === "analytics" ? (
        <TabPanel id="analytics" animate={animate}>
          <AnalyticsTab {...tabProps} />
        </TabPanel>
      ) : null}
      {canEdit && experiment.status !== "archived" ? (
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
