"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "@/lib/client";
import { adoptedDuplicateState, resultsView, type Callout, type ResultAction, type ResultsResponse, type ResultsView } from "@/lib/results-view";
import type { Experiment, Goal } from "@/lib/types";
import { HelpTip } from "../help/HelpTip";
import { LocalTime, useNow } from "../LocalTime";
import { DuplicateDialog } from "./DuplicateDialog";
import { StopDialog } from "./StopDialog";
import styles from "./ResultsTab.module.css";

type Props = {
  wid: string;
  siteId: string;
  experiment: Experiment;
  /** 日付の表示のタイムゾーン(サイトのタイムゾーン。設計書 §5.3) */
  timeZone: string;
  goals: Pick<Goal, "id" | "name">[];
  /** 複製できるか(編集者以上) */
  canDuplicate: boolean;
  /**
   * 帯の「終了して採用を記録」「採用なしで終了」を押したとき(variantId = 最初に選ぶ採用。null = 採用なし、report = 読んだ結果)。
   * 終了のモーダルを開く側が渡す。渡さなければ(管理者未満など)ボタンを出さない
   */
  onStop?: (variantId: string | null, report: ResultsResponse) => void;
  /** 終了したテストの採用を記録・変更できるか(管理者以上。PUT …/adoption) */
  canAdopt?: boolean;
};

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; data: ResultsResponse };

/**
 * 結果のタブ(D9 ③ Task 15、設計書 §7.3・§7.4・§10、モック (b))。判定の帯 → パターンのカード → 基準との差の図 → データ品質 →
 * 詳しい数値 → 端末別 → ほかの目標 → 採用の記録。
 * 結果はタブを開いたときにだけ読む(読み取りの予約を使うので、ほかのタブの表示のたびには読まない)。下書きでは読まずに「開始後に表示されます」
 */
export function ResultsTab(p: Props) {
  if (p.experiment.status === "draft") {
    return (
      <section className="card" data-testid="results-not-started">
        <p className="muted">結果はテストの開始後に表示されます。開始の前に、評価計画のタブで判定に使う目標と期間を決めてください</p>
      </section>
    );
  }
  return <ResultsBody {...p} />;
}

function ResultsBody({ wid, siteId, experiment, timeZone, goals, canDuplicate, onStop, canAdopt = false }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [dupFor, setDupFor] = useState<string | null>(null);
  // 採用の記録・変更(終了したテスト。D9 ③ Task 16)
  const [adopting, setAdopting] = useState(false);
  // 「あと n 日」と進み具合のための今の時刻(マウント前は null)
  const now = useNow(60_000);
  const url = `/sites/${siteId}/experiments/${experiment.id}/results`;

  // 要求の世代。古い応答(読み直しの前に出した要求・アンマウントの後に返った応答)は捨てる
  const generation = useRef(0);
  const fetchResults = useCallback(async () => {
    const mine = ++generation.current;
    setLoad({ kind: "loading" });
    let next: Load;
    try {
      next = { kind: "ok", data: await api<ResultsResponse>("GET", url) };
    } catch (e) {
      next = { kind: "error", message: describeError(e) };
    }
    if (mine === generation.current) setLoad(next);
  }, [url]);
  // 状態が変わったら(終了など)読み直す。アンマウントと読み直しで世代を進め、前の要求の応答を無視する
  useEffect(() => {
    void fetchResults();
    return () => {
      generation.current++;
    };
  }, [fetchResults, experiment.status]);

  if (load.kind === "loading") return <p className="muted" data-testid="results-loading">結果を読み込んでいます…</p>;
  if (load.kind === "error") {
    return (
      <div className={styles.report}>
        <p className="error-box" role="alert">
          結果を読めませんでした。{load.message}
        </p>
        <span>
          <button type="button" className="btn" onClick={() => void fetchResults()}>
            読み込み直す
          </button>
        </span>
      </div>
    );
  }

  const data = load.data;
  const v = resultsView(data, { timeZone, status: experiment.status, now, goals });
  const act = (a: ResultAction) => {
    if (a.kind === "stop") onStop?.(a.variantId, data);
    else setDupFor(a.variantId);
  };
  const adoptButton = canAdopt ? (
    <button type="button" className="btn" data-testid="results-adopt" onClick={() => setAdopting(true)}>
      {data.adoption ? "採用を変更" : "採用を記録"}
    </button>
  ) : null;
  const canAct = (a: ResultAction | undefined): a is ResultAction => (a?.kind === "stop" ? onStop !== undefined : a?.kind === "duplicate-adopted" ? canDuplicate : false);

  return (
    <div className={styles.report} data-testid="results-tab">
      {v.callouts.map((c) => (
        <CalloutLine key={c.text} c={c} />
      ))}
      {v.empty ? (
        <section className="card" data-testid="results-empty">
          <div className={styles.empty}>
            <strong>{v.empty.title}</strong>
            <span>{v.empty.body}</span>
            {v.empty.helpKey ? (
              <span>
                <HelpTip helpKey={v.empty.helpKey} label="詳しく読む" />
              </span>
            ) : null}
          </div>
        </section>
      ) : null}
      {v.banner ? (
        <section className={styles.hero} data-tone={v.banner.tone} data-testid="results-banner" aria-label="判定">
          <div>
            <span className={styles.heroState}>{v.banner.state}</span>
            <p className={styles.heroTitle}>{v.banner.title}</p>
            <p className={styles.heroSub}>{v.banner.body}</p>
          </div>
          {v.banner.key ? (
            <div className={styles.heroKey}>
              <span className={styles.kLabel}>{v.banner.key.label}</span>
              <span className={styles.kVal}>{v.banner.key.value}</span>
              <span className={styles.kSub}>{v.banner.key.sub}</span>
            </div>
          ) : null}
          <div className={styles.heroActions}>
            {v.banner.progress ? (
              <>
                <span className={styles.progress} role="progressbar" aria-label="評価時点までの日数" aria-valuemin={0} aria-valuemax={v.banner.progress.max} aria-valuenow={v.banner.progress.value}>
                  <span style={{ width: `${(v.banner.progress.value / v.banner.progress.max) * 100}%` }} />
                </span>
                <span className="muted">{v.banner.progress.label}</span>
              </>
            ) : null}
            {canAct(v.banner.primary) ? (
              <button type="button" className={actionClass(v.banner.primary)} data-testid="results-primary" onClick={() => act(v.banner!.primary!)}>
                {v.banner.primary.label}
              </button>
            ) : null}
            {canAct(v.banner.secondary) ? (
              <button type="button" className="btn" onClick={() => act(v.banner!.secondary!)}>
                {v.banner.secondary.label}
              </button>
            ) : null}
            {v.banner.status ? <span className="muted">{v.banner.status}</span> : null}
            <HelpTip helpKey={v.banner.help.key} label={v.banner.help.label} />
          </div>
        </section>
      ) : null}

      {v.cards.length > 0 ? (
        <>
          <PlanLine v={v} />
          <Cards v={v} />
          {v.diffChart.length > 0 ? <DiffChart v={v} /> : null}
          <Quality v={v} />
          <Details v={v} />
          {v.byDevice.rows.length > 0 ? (
            <section className="card">
              <details className={styles.more}>
                <summary>
                  端末別の内訳 <span className="muted">参考。判定はしません</span> <HelpTip helpKey="segments" />
                </summary>
                <SegmentTable columns={v.byDevice.columns} head="端末" rows={v.byDevice.rows.map((r) => ({ key: r.label, label: r.label, cells: r.cells }))} />
              </details>
            </section>
          ) : null}
          {v.otherGoals.length > 0 ? (
            <section className="card">
              <details className={styles.more}>
                <summary>
                  ほかの目標 <span className="muted">参考。判定には使いません</span>
                </summary>
                <SegmentTable columns={v.byDevice.columns} head="目標" rows={v.otherGoals.map((g) => ({ key: g.goalId, label: g.name, cells: g.cells }))} />
              </details>
            </section>
          ) : null}
        </>
      ) : null}

      {v.adoption ? (
        <section className="card" data-testid="results-adoption">
          <div className={styles.cardHead}>
            <h2>採用の記録</h2>
            <HelpTip helpKey="adopt" />
            <span className="muted">
              <LocalTime at={v.adoption.decidedAt} kind="deadline" timeZone={timeZone} />
              {v.adoption.decidedBy ? `・${v.adoption.decidedBy}` : ""}
            </span>
          </div>
          <div className={styles.adopt}>
            <p>
              <b>{v.adoption.title}</b>
              {v.adoption.summary ? ` — ${v.adoption.summary}` : ""}
            </p>
            {v.adoption.note ? <p className="muted">メモ: {v.adoption.note}</p> : null}
          </div>
          {adoptButton ? <span>{adoptButton}</span> : null}
        </section>
      ) : adoptButton ? (
        <section className="card" data-testid="results-adoption-missing">
          <div className={styles.cardHead}>
            <h2>採用の記録</h2>
            <HelpTip helpKey="adopt" />
          </div>
          <p className="muted">採用は未記録です。どのパターンを残すか(残さないか)とメモを記録しておくと、後から経緯を読めます</p>
          <span>{adoptButton}</span>
        </section>
      ) : null}

      {adopting ? (
        <StopDialog
          wid={wid}
          siteId={siteId}
          experiment={experiment}
          timeZone={timeZone}
          mode="adopt"
          report={data}
          onClose={() => setAdopting(false)}
          onDone={() => {
            setAdopting(false);
            void fetchResults();
          }}
        />
      ) : null}
      {dupFor !== null ? <DuplicateDialog wid={wid} siteId={siteId} experiment={experiment} open report={data} initial={adoptedDuplicateState(experiment, dupFor)} onClose={() => setDupFor(null)} /> : null}
    </div>
  );
}

/** 「採用なしで終了」は控えめなボタン(モック)。採用する操作と下書きの作成は主ボタン */
const actionClass = (a: ResultAction) => (a.kind === "stop" && a.variantId === null ? "btn" : "btn btn-primary");

function CalloutLine({ c }: { c: Callout }) {
  return (
    <div className={`${styles.callout} ${c.tone === "warn" ? styles.cWarn : styles.cInfo}`} role="note">
      <span>{c.text}</span>
      {c.helpKey ? <HelpTip helpKey={c.helpKey} /> : null}
    </div>
  );
}

function PlanLine({ v }: { v: ResultsView }) {
  return (
    <div className={styles.planLine}>
      {v.goalName ? (
        <span>
          判定に使う目標: <b>{v.goalName}</b>
        </span>
      ) : null}
      {v.planLine ? <span>評価計画: {v.planLine}</span> : null}
      <span>
        計画の変更 {v.planChanges} 件{v.planChanges > 0 ? <HelpTip helpKey="plan-changes" /> : null}
      </span>
    </div>
  );
}

function Cards({ v }: { v: ResultsView }) {
  return (
    <div className={styles.vcards}>
      {v.cards.map((c) => (
        <div key={c.variantId} className={styles.vcard} data-win={c.win} data-dim={c.dim} data-testid={`results-card-${c.variantId}`}>
          <div className={styles.vcardName}>
            {c.title}
            {c.isBaseline ? <span className="badge">基準</span> : null}
          </div>
          <div className={styles.vcardCvr}>
            {c.cvrText}
            <small>CVR</small>
          </div>
          {c.diffText ? (
            <div className={styles.vcardDiff} data-sign={c.diffSign ?? undefined}>
              {c.diffText}
            </div>
          ) : (
            <div className={`${styles.vcardDiff} muted`}>—</div>
          )}
          <div className={styles.vcardMeta}>{c.countText}</div>
          {c.meter ? (
            <div className={styles.meter}>
              <div className={styles.meterLine}>
                <span>
                  {c.probLabel} <HelpTip helpKey="probability" />
                </span>
                <b>{c.probText}</b>
              </div>
              <div className={styles.meterBar} aria-hidden="true">
                <span style={{ width: `${c.meter.value}%` }} />
                <i style={{ left: `${c.meter.threshold}%` }} />
              </div>
            </div>
          ) : null}
          {c.stateLabel ? (
            <div className={styles.vstate} data-tone={c.stateTone ?? undefined}>
              {c.stateLabel}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function DiffChart({ v }: { v: ResultsView }) {
  const { min, max, ticks, delta } = v.diffAxis;
  const pos = (x: number) => `${((x - min) / (max - min)) * 100}%`;
  const tick = (t: number) => (t === 0 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t)}`);
  return (
    <section className="card" aria-label="基準との差">
      <div className={styles.cardHead}>
        <h2>基準との差</h2>
        <HelpTip helpKey="difference" />
        <span className="muted">横棒 = 本当の差が 95% の確率で入る範囲</span>
      </div>
      <div className={styles.diffchart}>
        {v.diffChart.map((d) => (
          <div key={d.variantId} className={styles.dcRow}>
            <span className={styles.dcLabel}>{d.name}</span>
            <div className={styles.dcTrack} aria-label={`${d.range} ポイント`}>
              <span className={styles.dcAxis} />
              <span className={styles.dcZero} style={{ left: pos(0) }} />
              {delta !== null ? <span className={styles.dcDelta} style={{ left: pos(delta) }} /> : null}
              <span className={styles.dcBar} style={{ left: pos(d.ci95[0]), width: `calc(${pos(d.ci95[1])} - ${pos(d.ci95[0])})` }} />
              <span className={styles.dcPt} style={{ left: pos(d.mean) }} />
            </div>
            <span className={styles.dcVal}>
              <b>{d.text}</b>
              <span>{d.range}</span>
            </span>
          </div>
        ))}
        <div className={styles.dcRow}>
          <span />
          <div className={styles.dcTicks}>
            {ticks.map((t) => (
              <span key={t} style={{ left: pos(t) }}>
                {tick(t)}
              </span>
            ))}
          </div>
          <span className="muted">ポイント{delta !== null ? "(破線 = 最小改善幅)" : ""}</span>
        </div>
      </div>
    </section>
  );
}

function Quality({ v }: { v: ResultsView }) {
  const q = v.quality;
  const mark = q.level === "ok" ? "✓" : q.level === "warn" ? "▲" : "■";
  const rows = (
    <div className={styles.quality}>
      {q.rows.map((r) => (
        <div key={r.title} className={styles.q} data-level={r.level}>
          <span className={styles.qHead}>
            {r.title} <HelpTip helpKey={r.helpKey} />
          </span>
          <span className={styles.qValue}>{r.value}</span>
          {r.note ? <span className={styles.qNote}>{r.note}</span> : null}
        </div>
      ))}
    </div>
  );
  if (q.folded) {
    return (
      <section className="card" data-testid="results-quality" data-folded="true">
        <details className={styles.more}>
          <summary>
            <span className={styles.qline}>
              <span data-level="ok">
                {mark} {q.headline}
              </span>
              <span className="muted">割り振り・混在・適用の失敗・収集を確認済み</span>
            </span>
          </summary>
          {rows}
        </details>
      </section>
    );
  }
  return (
    <section className="card" data-testid="results-quality" data-folded="false">
      <div className={styles.qline}>
        <span data-level={q.level}>
          {mark} {q.headline}
        </span>
        <HelpTip helpKey="quality" />
      </div>
      {rows}
    </section>
  );
}

function Details({ v }: { v: ResultsView }) {
  const d = v.details;
  return (
    <section className="card">
      <details className={styles.more}>
        <summary>
          詳しい数値 <span className="muted">区間・期待損失など</span>
        </summary>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>パターン</th>
                <th>
                  参加者 <HelpTip helpKey="participants" />
                </th>
                <th>CV</th>
                <th>
                  CVR(95% 区間) <HelpTip helpKey="cvr" />
                </th>
                <th>
                  基準との差(相対) <HelpTip helpKey="difference" />
                </th>
                <th>
                  {d.probLabel} <HelpTip helpKey="probability" />
                </th>
                {d.showBest ? (
                  <th>
                    最良である確率 <HelpTip helpKey="best" />
                  </th>
                ) : null}
                <th>
                  期待損失 / 1 万人 <HelpTip helpKey="expected-loss" />
                </th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.variantId}>
                  <td>
                    {r.name}
                    {r.isBaseline ? (
                      <>
                        {" "}
                        <span className="badge">基準</span>
                      </>
                    ) : null}
                  </td>
                  <td className={styles.num}>{r.n}</td>
                  <td className={styles.num}>{r.y}</td>
                  <td className={styles.num}>
                    {r.cvr}
                    <span className={styles.sub}>{r.cvrRange}</span>
                  </td>
                  <td className={styles.num}>
                    {r.diff ?? "—"}
                    {r.diffRange ? <span className={styles.sub}>{r.diffRange}</span> : null}
                  </td>
                  <td className={styles.num}>{r.prob ?? "—"}</td>
                  {d.showBest ? <td className={styles.num}>{r.best ?? "—"}</td> : null}
                  <td className={styles.num}>{r.loss ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.foot}>
          <span>{d.footnote}</span>
          <HelpTip helpKey="observation-window" />
          <HelpTip helpKey="ga4-differences" />
          <HelpTip helpKey="data-integrity" label="集計の範囲" />
        </p>
      </details>
    </section>
  );
}

function SegmentTable({ columns, head, rows }: { columns: string[]; head: string; rows: Array<{ key: string; label: string; cells: ResultsView["byDevice"]["rows"][number]["cells"] }> }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{head}</th>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              {r.cells.map((c) => (
                <td key={c.variantId} className={styles.num}>
                  {c.cvr}
                  <span className={styles.sub}>{c.n}</span>
                  {c.diff ? <span className={styles.sub}>差 {c.diff}</span> : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
