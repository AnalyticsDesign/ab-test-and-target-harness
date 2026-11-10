"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, api, describeError } from "@/lib/client";
import type { ResultsResponse } from "@/lib/results-view";
import { loadTransitionPreview, othersListItems, OTHER_PUBLISH_NOTE, PREVIEW_LOAD_FAILED, STALE_PREVIEW_RETRY, SITE_PUBLISH_NOTE } from "@/lib/start-confirm";
import { ADOPTION_NOTE_MAX, selectionNotes, stopDialogState, stopDuplicateName, stopDuplicateOption, stopView, submitStop, type StopMessage, type StopMode, type StopOutcome } from "@/lib/stop-dialog";
import { AppLink } from "../ui/AppLink";
import type { Experiment, PublishPreview } from "@/lib/types";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ErrorBox } from "../ErrorBox";
import { useNow } from "../LocalTime";
import { navigateDocument } from "@/lib/navigate";
import { BusyScope, useBusyAction } from "../ui/BusyScope";

/** 記録の応答が 30 秒で分からなかったとき */
const WRITE_UNKNOWN = "保存できたか分かりません。再読み込みして確かめてください";
/** 記録はできたが、読み直しが 10 秒で終わらなかったとき(知らせの最後に足す) */
const REFRESH_STALE: StopMessage = { tone: "warn", text: "保存しました。画面の表示が古い可能性があります。再読み込みしてください" };

/** 送った結果(採用の記録し直し = PUT だけ / 終了 = 状態の API と複製) */
type Sent = { mode: "adopt" } | { mode: "stop"; outcome: StopOutcome };

type Props = {
  wid: string;
  siteId: string;
  experiment: Experiment;
  /** 日付の表示のタイムゾーン(サイトのタイムゾーン) */
  timeZone: string;
  /** stop = 終了して採用を記録(見出しの「終了して結果を記録」・結果のタブの帯)/ adopt = 終了したテストの採用を記録し直す(結果のタブ) */
  mode: StopMode;
  /**
   * 結果の API の応答(結果のタブが読んだもの)。undefined なら開いたときに読む(見出しから開いたとき)。
   * null = 読めなかった(判定を出さずに選ばせる)
   */
  report?: ResultsResponse | null;
  /** 最初に選ぶ採用(結果のタブの帯の操作が決める。undefined = 判定から決める) */
  initialVariantId?: string | null;
  onClose: () => void;
  /**
   * 送り終えたとき。stop = 終了の知らせ(下書きへ移るときは呼ばずに移る)。adopt = 知らせは空。
   * 呼ぶ側はモーダルを閉じる。終了の後の画面の読み直しはモーダルの中で済ませてから呼ぶ(呼ぶ側で読み直さない。B173 第 2 段)
   */
  onDone: (messages: StopMessage[], created: string | null) => void;
};

/**
 * 終了のモーダル(D9 ③ Task 16、設計書 §8.2、モックの終了のモーダル)と、終了したテストの採用の記録し直し(PUT …/adoption)。
 * 採用の選択肢(判定と上回る確率を添える)・メモ・「<採用> だけを表示する新しいエクスペリエンスも作成する(下書き)」。
 * 終了 + 採用(状態の API)が成功した後に複製の API を呼び、複製が失敗しても終了は取り消さない。
 * 送ってから終わるまで、ダイアログの中を「記録中…」で覆う(B173 第 2 段)。下書きへそのまま移るときは移った先が開くまで、
 * それ以外の終了は画面の読み直しの反映まで開いたまま覆い、反映の後に閉じて知らせを呼ぶ側に渡す。
 * 範囲(BusyScope)はダイアログを包むが、モーダルの <dialog> は外側の inert から外れるので、見える覆いは ConfirmDialog の busyLabel
 */
type TransitionPreview = Awaited<ReturnType<typeof loadTransitionPreview>>;

export function StopDialog(p: Props) {
  const [transition, setTransition] = useState<TransitionPreview | null>(null);
  const alive = useRef(true);
  const reloadTransition = useCallback(async () => {
    setTransition(null);
    const next = await loadTransitionPreview(p.siteId, p.experiment.id, "archived", (path) => api<PublishPreview>("GET", path));
    if (alive.current) setTransition(next);
  }, [p.siteId, p.experiment.id]);
  useEffect(() => {
    alive.current = true;
    if (p.mode === "stop") void reloadTransition();
    return () => { alive.current = false; };
  }, [p.mode, reloadTransition]);
  // 結果は見出しから開いたときだけ読む(結果のタブは読んだものを渡す)
  const [report, setReport] = useState<ResultsResponse | null | undefined>(p.report);
  const url = `/sites/${p.siteId}/experiments/${p.experiment.id}/results`;
  useEffect(() => {
    if (report !== undefined) return;
    let live = true;
    api<ResultsResponse>("GET", url).then(
      (r) => live && setReport(r),
      () => live && setReport(null),
    );
    return () => {
      live = false;
    };
  }, [report, url]);
  if (report === undefined) {
    return (
      <ConfirmDialog open title={titleOf(p.mode)} confirmLabel={confirmLabelOf(p.mode)} cancelLabel="戻る" tone={p.mode === "stop" ? "danger" : "primary"} dismissOnBackdrop={false} confirmDisabled onConfirm={() => {}} onCancel={p.onClose}>
        <p className="muted" data-testid="stop-loading">
          結果を読み込んでいます…
        </p>
      </ConfirmDialog>
    );
  }
  return (
    <BusyScope id="stop-dialog">
      <StopForm {...p} report={report} transition={transition} reloadTransition={reloadTransition} />
    </BusyScope>
  );
}

const titleOf = (mode: StopMode) => (mode === "stop" ? "終了して結果を記録します" : "採用を記録します");
const confirmLabelOf = (mode: StopMode) => (mode === "stop" ? "終了して記録" : "採用を記録");

function StopForm({ wid, siteId, experiment, timeZone, mode, report, initialVariantId, onClose, onDone, transition, reloadTransition }: Props & { report: ResultsResponse | null; transition: TransitionPreview | null; reloadTransition: () => Promise<void> }) {
  // 評価時点の前かは今の時刻で決める(評価時点の後でも前の速報が返ることがあるため)。マウント前は null
  const now = useNow();
  const state = stopDialogState(report, experiment, { timeZone, now, mode, ...(initialVariantId !== undefined ? { initialVariantId } : {}) });
  const [selected, setSelected] = useState<string | null>(state.initial);
  const [note, setNote] = useState(mode === "adopt" ? (report?.adoption?.note ?? "") : "");
  const [duplicate, setDuplicate] = useState(false);
  const { busy, run } = useBusyAction();
  const [error, setError] = useState<string | null>(null);
  const dup = stopDuplicateOption(experiment, selected);
  const notes = selectionNotes(state, experiment, selected);
  const otherItems = transition?.ok ? othersListItems(transition.others) : [];

  const viewOf = (o: StopOutcome) => stopView(o, `/w/${wid}/sites/${siteId}/experiments`);

  async function send() {
    if (mode === "stop" && !transition?.ok) return;
    setError(null);
    const outcome = await run<Sent>({
      label: "記録中…",
      write: async (signal) => {
        if (mode === "adopt") {
          await api("PUT", `/sites/${siteId}/experiments/${experiment.id}/adoption`, { variantId: selected, ...(note.trim() ? { note: note.trim() } : {}) }, { signal });
          return { mode: "adopt" };
        }
        if (!transition?.ok) throw new Error(PREVIEW_LOAD_FAILED);
        const stopped = await submitStop(
          (method, path, body) => api(method, path, body, { signal }),
          {
            siteId,
            expectDigest: transition.digest,
            experimentId: experiment.id,
            adoption: { variantId: selected, note },
            duplicate: duplicate && dup.enabled && selected !== null ? { variantId: selected, name: stopDuplicateName(experiment, selected) } : null,
          },
          describeError,
        );
        return { mode: "stop", outcome: stopped };
      },
      // 採用の記録し直しは画面を読み直さない(結果のタブが onDone で結果を読み直す。今までと同じ往復)。
      // 終了は、公開も記録も済んで下書きを作れたら、その下書きへ移る(上部バーの「未公開の編集あり」を描き直すため全画面の遷移。複製の画面と同じ)。
      // それ以外の終了は、画面の読み直しの反映まで開いたまま覆う
      after: (v) => (v.mode === "adopt" ? "none" : viewOf(v.outcome).navigate ? "navigate" : "refresh"),
      navigate: (v) => {
        const created = v.mode === "stop" ? viewOf(v.outcome).created : null;
        return created ? navigateDocument(created) : { kind: "none" };
      },
    });
    switch (outcome.kind) {
      case "saved": {
        if (outcome.value.mode === "adopt") {
          onDone([], null);
          return;
        }
        const view = viewOf(outcome.value.outcome);
        // 読み直しが 10 秒で終わらなくても、終了は済んでいる。閉じて、表示が古い可能性を知らせの最後に足す(送り直さない)
        onDone(outcome.refresh === "timeout" ? [...view.messages, REFRESH_STALE] : view.messages, view.created);
        return;
      }
      case "navigated":
        // 下書きへの移動が終わらなかった。終了は済んでいるので閉じて、知らせと下書きへのリンクを出す(もう一度の終了を押せる状態にしない)
        if (outcome.value.mode === "stop") {
          const view = viewOf(outcome.value.outcome);
          onDone(view.messages, view.created);
        }
        return;
      case "failed":
        // 状態の API(または採用の記録)の失敗。終了していないので、モーダルを開いたままエラーを出す
        if (mode === "stop" && outcome.error instanceof ApiClientError && outcome.error.code === "stale_preview") {
          setError(STALE_PREVIEW_RETRY);
          await reloadTransition();
        } else setError(describeError(outcome.error));
        return;
      case "unknown":
        setError(WRITE_UNKNOWN);
        return;
      default:
        return;
    }
  }

  return (
    <ConfirmDialog
      open
      title={titleOf(mode)}
      confirmLabel={confirmLabelOf(mode)}
      cancelLabel="戻る"
      tone={mode === "stop" ? "danger" : "primary"}
      dismissOnBackdrop={false}
      busyLabel={busy ? "記録中…" : null}
      confirmDisabled={busy || (mode === "stop" && !transition?.ok)}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onConfirm={() => void send()}
    >
      <p className="muted">{state.lead}</p>
      {report === null ? <p className="muted">結果を読めなかったため、判定は表示していません。</p> : null}
      {state.earlyNotice ? (
        <p className="banner-warn" style={{ display: "block" }} data-testid="stop-early-notice">
          {state.earlyNotice}
        </p>
      ) : null}
      <div role="radiogroup" aria-label="採用するパターン" data-testid="stop-options" style={{ display: "flex", flexDirection: "column", gap: 6, margin: "8px 0" }}>
        {state.options.map((o) => (
          <label key={o.variantId ?? "__none"} className="row" style={{ gap: 8, alignItems: "flex-start", flexWrap: "nowrap" }}>
            <input type="radio" name="stop-adopt" checked={selected === o.variantId} disabled={busy} onChange={() => setSelected(o.variantId)} />
            <span>
              {o.label}
              {o.note ? (
                <span className="muted" style={{ display: "block" }}>
                  {o.note}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {notes.map((n) => (
        <p key={n} className="banner-warn" style={{ display: "block" }}>
          {n}
        </p>
      ))}
      <label className="field">
        <span className="field-label">メモ(任意)</span>
        <textarea value={note} maxLength={ADOPTION_NOTE_MAX} disabled={busy} placeholder="何が分かったか、次に試すこと など" onChange={(e) => setNote(e.target.value)} />
      </label>
      {mode === "stop" ? (
        <div className="field" data-testid="stop-duplicate">
          <label className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <input type="checkbox" checked={duplicate && dup.enabled} disabled={!dup.enabled || busy} onChange={(e) => setDuplicate(e.target.checked)} />
            <span>{dup.label}</span>
          </label>
          <span className="field-hint">{dup.hint}</span>
        </div>
      ) : null}
      {/* B66 b: 終了も状態の変更なので、サイト全体を公開する(採用を記録し直すだけのときは公開しない) */}
      {mode === "stop" ? <>
        {transition === null ? <p className="muted">公開の確認を読み込んでいます…</p> : !transition.ok ? <p className="error-box" role="alert">{PREVIEW_LOAD_FAILED}</p> : null}
        <p className="muted">{otherItems.length ? OTHER_PUBLISH_NOTE : SITE_PUBLISH_NOTE}</p>
        {otherItems.length ? <ul>{otherItems.map((item) => <li key={item.key}>{item.message}</li>)}</ul> : null}
      </> : null}
      <ErrorBox message={error} />
    </ConfirmDialog>
  );
}

/** 終了の後の知らせ(終了のモーダルの結果)。作った下書きへそのまま移らなかったときは、下書きへのリンクを添える */
export function StopNotices({ messages, created }: { messages: StopMessage[]; created: string | null }) {
  return (
    <>
      {messages.map((m) => (
        <span key={m.text} className={m.tone === "error" ? "error-box" : m.tone === "warn" ? "banner-warn" : "muted"} role={m.tone === "info" ? "status" : "alert"} data-testid="stop-notice">
          {m.text}{m.publishHref ? <> <AppLink href={m.publishHref}>公開の確認へ</AppLink></> : null}
        </span>
      ))}
      {created ? (
        <a href={created} data-testid="stop-created-link">
          作成した下書きを開く
        </a>
      ) : null}
    </>
  );
}
