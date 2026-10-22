"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/ConfirmProvider";
import { api, describeError } from "@/lib/client";
import { STATUS_JA } from "@/lib/experiment-filter";
import { comparisonsOf, type PlanView } from "@/lib/evaluation-plan";
import { loadStartPreview, pauseConfirm, SITE_PUBLISH_NOTE, startBlocker, startConfirmFor, startWarnings, type StartPlan } from "@/lib/start-confirm";
import type { StopMessage } from "@/lib/stop-dialog";
import type { Experiment, Goal, PublishPreview, Status, StatusResult } from "@/lib/types";
import { StopDialog, StopNotices } from "./experiment/StopDialog";

const NEXT: Record<Status, Array<{ to: Status; label: string; danger?: boolean }>> = {
  draft: [{ to: "running", label: "開始(公開して配信を始める)" }],
  running: [
    { to: "paused", label: "一時停止" },
    { to: "archived", label: "終了(元に戻せません)", danger: true },
  ],
  paused: [
    { to: "running", label: "再開" },
    { to: "archived", label: "終了(元に戻せません)", danger: true },
  ],
  archived: [],
};

/**
 * 下書きのテストの開始で使う評価計画の内容(D9 ③ Task 14)。計画は押した時点で読み直す(タブで保存した直後の値を使う)。
 * 読めなければ plan = null(一覧を出さず、開始の検査は control に任せる)
 */
async function loadStartPlan(siteId: string, experiment: Experiment, recording: boolean, goals: Pick<Goal, "id" | "name">[]): Promise<StartPlan> {
  let plan: StartPlan["plan"] = null;
  try {
    plan = (await api<PlanView>("GET", `/sites/${siteId}/experiments/${experiment.id}/evaluation-plan`)).plan;
  } catch {
    plan = null;
  }
  const variants = experiment.variants ?? [];
  return {
    recording,
    plan,
    goalName: goals.find((g) => g.id === plan?.primaryGoalId)?.name ?? null,
    baselineName: variants.find((v) => v.id === plan?.baselineVariantId)?.name ?? null,
    baselineWeight: variants.find((v) => v.id === plan?.baselineVariantId)?.weight ?? null,
    comparisons: comparisonsOf(variants.filter((v) => v.weight > 0).length),
  };
}

/** テストの終了は終了のモーダル(採用の記録)を開く。見出しの文言は「終了して結果を記録」(設計書 §10) */
const labelOf = (experiment: Experiment, n: { to: Status; label: string }) => (experiment.kind === "test" && n.to === "archived" ? "終了して結果を記録" : n.label);

/**
 * spec §13.8。失敗時のアラート = 決定 17。
 * recording = このサイトが結果を記録するか(開始の確認で、固定する評価計画の一覧か、記録しない文を出す。D9 ③)。
 * テストの終了は確認の代わりに終了のモーダル(StopDialog。採用・メモ・採用したパターンだけの下書き)を開く。パーソナライズは今の確認のまま(D9 ③ Task 16)
 */
export function StatusButtons({
  wid,
  siteId,
  experiment,
  canPublish,
  recording = false,
  goals = [],
  timeZone,
}: {
  wid: string;
  siteId: string;
  experiment: Experiment;
  canPublish: boolean;
  recording?: boolean;
  goals?: Pick<Goal, "id" | "name">[];
  /** サイトのタイムゾーン(終了のモーダルの評価時点の日付) */
  timeZone: string;
}) {
  const router = useRouter();
  const ask = useConfirm();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  // 開始の応答の warnings(結果を記録しない開始・容量の見込み)。次の操作で消す
  const [warnings, setWarnings] = useState<string[]>([]);
  // 終了のモーダルとその知らせ(終了・公開・記録・下書きの作成)。次の操作で消す
  const [stopping, setStopping] = useState(false);
  const [stopNotices, setStopNotices] = useState<{ messages: StopMessage[]; created: string | null } | null>(null);
  if (!canPublish) return <p className="muted">開始・一時停止・終了(本番化)は管理者以上が行います</p>;
  return (
    <div className="row" style={{ justifyContent: "flex-end", maxWidth: 560 }}>
      {NEXT[experiment.status].map((n) => (
        <button
          key={n.to}
          type="button"
          className={n.danger ? "btn btn-danger" : "btn btn-primary"}
          disabled={busy}
          onClick={async () => {
            setStopNotices(null);
            if (experiment.kind === "test" && n.to === "archived") {
              setMsg(null);
              setWarnings([]);
              setStopping(true);
              return;
            }
            // 最初に busy を立てる(確認や重なりの取得を待つ間も押せないように。2 回目の状態変更が 409 になり、成功の知らせをエラーで上書きしないため)。
            // 途中で戻るとき(確認のキャンセル)も finally で戻す
            setBusy(true);
            try {
              if (
                n.danger &&
                !(await ask({
                  title: "エクスペリエンスを終了しますか?",
                  body: (
                    <>
                      <p>終了したエクスペリエンスは再開できません。もう一度行うときは複製して作ります</p>
                      <p className="muted">{SITE_PUBLISH_NOTE}</p>
                    </>
                  ),
                  confirmLabel: "終了する",
                  tone: "danger",
                }))
              )
                return;
              // B107: 一時停止は押し間違えると配信がすぐ止まるので確認する(再開できるので主ボタンの色)
              if (n.to === "paused") {
                const c = pauseConfirm();
                const ok = await ask({
                  title: c.title,
                  body: (
                    <>
                      <p>{c.lead}</p>
                      <p className="muted">{c.sitePublish}</p>
                    </>
                  ),
                  confirmLabel: c.confirmLabel,
                  tone: "primary",
                });
                if (!ok) return;
              }
              // 決定 51(設計書 §3.3): 下書きの開始・一時停止中の再開で、同じ要素を変える配信中のエクスペリエンスがあれば、どちらが優先されるかを確認に出す。
              // 取得に失敗したら確認なしで進める(警告は開始・再開を止めない)。
              // B77 K20: 下書きの開始では、保存済みのパターンのうち重み 0 のものも同じ確認に入れる(開始後は重みを直せない。再開では出さない)
              // D9 ③(設計書 §5.2・§10): 下書きのテストの開始では、固定する評価計画の一覧(結果を記録しないサイトでは記録しない文)も同じ確認に入れ、
              // 判定に使う目標が無ければ確認の前に止める(control の 422 と同じ案内)
              if ((experiment.status === "draft" || experiment.status === "paused") && n.to === "running") {
                const starting = experiment.status === "draft";
                setMsg(null);
                setWarnings([]);
                // B66 b: 下見で、ほかに未公開の変更があるか(状態の変更で一緒に本番に出る)も見る。あれば確認を出してそのことを言う
                const [{ overlaps, othersUnpublished }, start] = await Promise.all([
                  loadStartPreview(experiment.id, () => api<PublishPreview>("GET", `/sites/${siteId}/publish-preview?starting=${encodeURIComponent(experiment.id)}`)),
                  starting && experiment.kind === "test" ? loadStartPlan(siteId, experiment, recording, goals) : Promise.resolve(undefined),
                ]);
                const blocked = start ? startBlocker(start) : null;
                if (blocked) {
                  setMsg({ text: blocked, error: true });
                  return;
                }
                const confirm = startConfirmFor(
                  overlaps,
                  starting ? "開始" : "再開",
                  starting ? (experiment.variants ?? []).filter((v) => v.weight === 0).map((v) => v.name) : [],
                  start,
                  othersUnpublished,
                );
                if (
                  confirm &&
                  !(await ask({
                    title: confirm.title,
                    body: (
                      <>
                        {confirm.lead ? <p>{confirm.lead}</p> : null}
                        {confirm.items.length > 0 ? (
                          <ul>
                            {confirm.items.map((it) => (
                              <li key={it.key}>{it.message}</li>
                            ))}
                          </ul>
                        ) : null}
                        {confirm.notice ? <p className="banner-warn">{confirm.notice}</p> : null}
                        {confirm.fixed ? (
                          <dl data-testid="start-fixed" style={{ margin: "8px 0", display: "flex", flexDirection: "column", gap: 4 }}>
                            {confirm.fixed.map((f) => (
                              <div key={f.label} className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "nowrap" }}>
                                <dt className="muted" style={{ minWidth: 110 }}>{f.label}</dt>
                                <dd style={{ margin: 0 }}>{f.value}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                        {confirm.note ? <p className="muted">{confirm.note}</p> : null}
                        <p className="muted">{confirm.sitePublish}</p>
                      </>
                    ),
                    confirmLabel: confirm.confirmLabel,
                    tone: "primary",
                  }))
                )
                  return;
              }
              setMsg(null);
              setWarnings([]);
              try {
                const r = await api<StatusResult>("POST", `/sites/${siteId}/experiments/${experiment.id}/status`, { status: n.to });
                setMsg(
                  r.publish.ok
                    ? { text: `公開 v${r.publish.version} を反映しました(訪問者のブラウザには 1 分ほどで届きます)`, error: false }
                    : { text: `状態は ${STATUS_JA[n.to]} に変わりましたが、公開に失敗しました(${r.publish.error}: ${r.publish.message})。上部の「公開」から再試行してください`, error: true },
                );
                setWarnings(startWarnings(r.warnings));
                router.refresh();
              } catch (e) {
                // 409 invalid_transition(評価計画・パターンの設定が変わった競合など)は control の hint をそのまま出す
                setMsg({ text: describeError(e), error: true });
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {labelOf(experiment, n)}
        </button>
      ))}
      {msg ? (
        <span className={msg.error ? "error-box" : "muted"} role="alert">
          {msg.text}
        </span>
      ) : null}
      {stopNotices ? <StopNotices messages={stopNotices.messages} created={stopNotices.created} /> : null}
      {stopping ? (
        <StopDialog
          wid={wid}
          siteId={siteId}
          experiment={experiment}
          timeZone={timeZone}
          mode="stop"
          onClose={() => setStopping(false)}
          onDone={(messages, created) => {
            setStopping(false);
            setStopNotices({ messages, created });
            router.refresh();
          }}
        />
      ) : null}
      {warnings.map((w) => (
        <span key={w} className="banner-warn" role="status" data-testid="start-warning">
          {w}
        </span>
      ))}
    </div>
  );
}

