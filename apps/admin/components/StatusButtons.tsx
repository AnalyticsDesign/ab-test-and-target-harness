"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useConfirmHold, type ConfirmHold, type ConfirmOptions } from "@/components/ConfirmProvider";
import { useStatusChangeGuard } from "@/lib/status-guard";
import { api, describeError } from "@/lib/client";
import { REFRESH_TIMEOUT, WRITE_UNKNOWN } from "@/lib/busy-notice";
import type { BusyOutcome } from "@/lib/run-busy";
import { STATUS_JA } from "@/lib/experiment-filter";
import { comparisonsOf, type PlanView } from "@/lib/evaluation-plan";
import { loadStartPreview, pauseConfirm, SITE_PUBLISH_NOTE, startBlocker, startConfirmFor, startWarnings, type StartConfirm, type StartPlan } from "@/lib/start-confirm";
import type { StopMessage } from "@/lib/stop-dialog";
import type { Experiment, Goal, PublishPreview, Status, StatusResult } from "@/lib/types";
import { StopDialog, StopNotices } from "./experiment/StopDialog";
import { BusyScope, useBusyAction } from "./ui/BusyScope";

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

/** 開始・再開の最後の確認の本文(startConfirmFor の結果) */
function startConfirmBody(confirm: StartConfirm): ReactNode {
  return (
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
  );
}

/** 覆いの文言(状態と行き先ごと。B173 第 2 段の対応表) */
function busyLabelOf(from: Status, to: Status): string {
  if (to === "paused") return "一時停止中…";
  if (to === "archived") return "変更中…";
  return from === "draft" ? "開始中…" : "再開中…";
}

type StatusProps = {
  wid: string;
  siteId: string;
  experiment: Experiment;
  canPublish: boolean;
  recording?: boolean;
  goals?: Pick<Goal, "id" | "name">[];
  /** サイトのタイムゾーン(終了のモーダルの評価時点の日付) */
  timeZone: string;
};

/**
 * spec §13.8。失敗時のアラート = 決定 17。
 * recording = このサイトが結果を記録するか(開始の確認で、固定する評価計画の一覧か、記録しない文を出す。D9 ③)。
 * テストの終了は確認の代わりに終了のモーダル(StopDialog。採用・メモ・採用したパターンだけの下書き)を開く。パーソナライズは今の確認のまま(D9 ③ Task 16)。
 * B173 第 2 段: ボタンの並びを BusyScope で包み、押したら 1 回の run にする。最後に出る確認は askHold(確定の後も開いたまま中を覆い、
 * 読み直しの反映まで閉じない。失敗はその中に出してもう一度押せる)。最後の確認の無い開始・再開は、ボタンの並びを覆う
 */
export function StatusButtons(props: StatusProps) {
  if (!props.canPublish) return <p className="muted">開始・一時停止・終了(本番化)は管理者以上が行います</p>;
  return (
    <BusyScope id="status-buttons">
      <StatusButtonsRow {...props} />
    </BusyScope>
  );
}

function StatusButtonsRow({ wid, siteId, experiment, recording = false, goals = [], timeZone }: StatusProps) {
  const askHold = useConfirmHold();
  const { run, busy } = useBusyAction();
  // 未保存の変更があれば、状態の変更の確認・終了のモーダルの前に止める(B173 第 1 段)
  const statusGuard = useStatusChangeGuard();
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  /** 状態は変わったが読み直しが上限を超えた(結果の行の下に再読み込みの案内) */
  const [stale, setStale] = useState(false);
  // 開始の応答の warnings(結果を記録しない開始・容量の見込み)。次の操作で消す
  const [warnings, setWarnings] = useState<string[]>([]);
  // 終了のモーダルとその知らせ(終了・公開・記録・下書きの作成)。次の操作で消す
  const [stopping, setStopping] = useState(false);
  const [stopNotices, setStopNotices] = useState<{ messages: StopMessage[]; created: string | null } | null>(null);
  // 確認の段の待ち(事前の GET など)の間に範囲が消えた(戻る・進むで離れた)ら、次の段の確認を開かない(BusyScope の alive と同じ考え)
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const clear = () => {
    setMsg(null);
    setStale(false);
    setWarnings([]);
  };

  /**
   * 最後に出す確認の中身。null = 確認を出さない(開始・再開で startConfirmFor が null)。false = 前の段で止めた・取り消した・範囲が消えた。
   * 前の段の確認(今は無い)・事前の GET はここ。各段の待ちの後に範囲が生きているかを見る
   */
  async function finalConfirm(n: { to: Status }): Promise<ConfirmOptions | null | false> {
    // 実行中・一時停止中の終了(パーソナライズ。テストは StopDialog)
    if (n.to === "archived") {
      return {
        title: "エクスペリエンスを終了しますか?",
        body: (
          <>
            <p>終了したエクスペリエンスは再開できません。もう一度行うときは複製して作ります</p>
            <p className="muted">{SITE_PUBLISH_NOTE}</p>
          </>
        ),
        confirmLabel: "終了する",
        tone: "danger",
      };
    }
    // B107: 一時停止は押し間違えると配信がすぐ止まるので確認する(再開できるので主ボタンの色)
    if (n.to === "paused") {
      const c = pauseConfirm();
      return {
        title: c.title,
        body: (
          <>
            <p>{c.lead}</p>
            <p className="muted">{c.sitePublish}</p>
          </>
        ),
        confirmLabel: c.confirmLabel,
        tone: "primary",
      };
    }
    // 決定 51(設計書 §3.3): 下書きの開始・一時停止中の再開で、同じ要素を変える配信中のエクスペリエンスがあれば、どちらが優先されるかを確認に出す。
    // 取得に失敗したら確認なしで進める(警告は開始・再開を止めない)。
    // B77 K20: 下書きの開始では、保存済みのパターンのうち重み 0 のものも同じ確認に入れる(開始後は重みを直せない。再開では出さない)
    // D9 ③(設計書 §5.2・§10): 下書きのテストの開始では、固定する評価計画の一覧(結果を記録しないサイトでは記録しない文)も同じ確認に入れ、
    // 判定に使う目標が無ければ確認の前に止める(control の 422 と同じ案内)
    const starting = experiment.status === "draft";
    // B66 b: 下見で、ほかに未公開の変更があるか(状態の変更で一緒に本番に出る)も見る。あれば確認を出してそのことを言う
    const [{ overlaps, othersUnpublished }, start] = await Promise.all([
      loadStartPreview(experiment.id, () => api<PublishPreview>("GET", `/sites/${siteId}/publish-preview?starting=${encodeURIComponent(experiment.id)}`)),
      starting && experiment.kind === "test" ? loadStartPlan(siteId, experiment, recording, goals) : Promise.resolve(undefined),
    ]);
    if (!mounted.current) return false;
    const blocked = start ? startBlocker(start) : null;
    if (blocked) {
      setMsg({ text: blocked, error: true });
      return false;
    }
    const confirm = startConfirmFor(
      overlaps,
      starting ? "開始" : "再開",
      starting ? (experiment.variants ?? []).filter((v) => v.weight === 0).map((v) => v.name) : [],
      start,
      othersUnpublished,
    );
    if (!confirm) return null;
    return { title: confirm.title, body: startConfirmBody(confirm), confirmLabel: confirm.confirmLabel, tone: "primary" };
  }

  async function change(n: { to: Status }) {
    const label = busyLabelOf(experiment.status, n.to);
    /** 最後の確認の口。確認の無い経路・最後の確認の前に止めたときは null(close・fail を呼ばず、結果はボタンの並びに出す) */
    let hold: ConfirmHold | null = null;
    const attempt = () =>
      run<StatusResult>({
        label,
        // 実行権は最初に取れている。前の段の確かめ・事前の取得・最後の確認(askHold)はすべてここ。
        // 30 秒の上限の時計は write からなので、確認を読んでいる時間は数えない。もう一度の確定(hold を持っている)はすぐ true
        confirm: async () => {
          if (hold) return true;
          if (!(await statusGuard())) return false;
          if (!mounted.current) return false;
          setStopNotices(null);
          clear();
          const final = await finalConfirm(n);
          if (final === false || !mounted.current) return false;
          if (final === null) return true; // 確認を足さない。覆いはボタンの並び(S2-7)
          const r = await askHold({ ...final, busyLabel: label });
          if (!r.confirmed) return false;
          hold = r.hold;
          return true;
        },
        write: (signal) => api<StatusResult>("POST", `/sites/${siteId}/experiments/${experiment.id}/status`, { status: n.to }, { signal }),
        after: "refresh",
      });

    let outcome: BusyOutcome<StatusResult> = await attempt();
    // 失敗・30 秒は確認の中に出し、もう一度の確定で同じ形の run を送り直す(取り消しで閉じたら何もしない。状態は変わっていない)
    while ((outcome.kind === "failed" || outcome.kind === "unknown") && hold) {
      const again = await (hold as ConfirmHold).fail(outcome.kind === "failed" ? describeError(outcome.error) : WRITE_UNKNOWN);
      if (!again) return;
      outcome = await attempt();
    }
    // 覆いは run の終わりで外れている。確認を閉じてから結果を出す
    (hold as ConfirmHold | null)?.close();
    if (outcome.kind === "saved") {
      const r = outcome.value;
      setMsg(
        r.publish.ok
          ? { text: `公開 v${r.publish.version} を反映しました(訪問者のブラウザには 1 分ほどで届きます)`, error: false }
          : { text: `状態は ${STATUS_JA[n.to]} に変わりましたが、公開に失敗しました(${r.publish.error}: ${r.publish.message})。上部の「公開」から再試行してください`, error: true },
      );
      setWarnings(startWarnings(r.warnings));
      setStale(outcome.refresh === "timeout");
    } else if (outcome.kind === "failed") {
      // 確認の無い経路の失敗。409 invalid_transition(評価計画・パターンの設定が変わった競合など)は control の hint をそのまま出す
      setMsg({ text: describeError(outcome.error), error: true });
    } else if (outcome.kind === "unknown") {
      setMsg({ text: WRITE_UNKNOWN, error: true });
    }
    // discarded・cancelled・ignored は何も出さない
  }

  return (
    <div className="row" style={{ justifyContent: "flex-end", maxWidth: 560 }} data-testid="status-buttons">
      {NEXT[experiment.status].map((n) => (
        <button
          key={n.to}
          type="button"
          className={n.danger ? "btn btn-danger" : "btn btn-primary"}
          disabled={busy}
          onClick={async () => {
            if (experiment.kind === "test" && n.to === "archived") {
              if (!(await statusGuard())) return;
              setStopNotices(null);
              clear();
              setStopping(true);
              return;
            }
            await change(n);
          }}
        >
          {labelOf(experiment, n)}
        </button>
      ))}
      {msg ? (
        msg.error ? (
          <span className="error-box" role="alert" data-testid="status-result">
            {msg.text}
          </span>
        ) : (
          <span className="muted" role="status" data-testid="status-result">
            {msg.text}
          </span>
        )
      ) : null}
      {stale ? (
        <span className="muted" role="status">
          {REFRESH_TIMEOUT}
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
            // 画面の読み直しは終了のモーダルの中で済んでいる(ここで読み直すと 2 回になる。B173 第 2 段)
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
