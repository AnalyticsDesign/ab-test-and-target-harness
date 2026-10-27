"use client";
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "@/lib/client";
import {
  parseStaticHealth,
  rebuildConfirmParagraphs,
  rebuildResultLines,
  recordIssueCount,
  runRebuild,
  staticHealthRows,
  STATIC_HEALTH_REFRESH_EVENT,
  type RebuildTotal,
  type StaticHealthRow,
} from "@/lib/static-health";
import type { RebuildResult, StaticHealthView } from "@/lib/types";
import { useConfirm } from "../ConfirmProvider";
import { ErrorBox } from "../ErrorBox";
import { LocalTime } from "../LocalTime";
import { StatusPill } from "../ui/StatusPill";
import styles from "./StaticDelivery.module.css";

/** 作り直しの後に、配置が進んだ状態をもう一度取り直すまでの時間 */
const RECHECK_MS = 10_000;

/** 表の「状態」の列。時刻は見ている人のタイムゾーンで描き(LocalTime)、最後のエラーは本文を <code> で添える */
function StateCell({ row, view }: { row: StaticHealthRow; view: StaticHealthView }) {
  const { kind, text } = row.state;
  if (kind === "text") {
    if (row.label === "最後に成功した時刻" && view.lastDeployedAt !== null) {
      return (
        <span className="mono">
          <LocalTime at={view.lastDeployedAt} />
        </span>
      );
    }
    return <span className="num">{text}</span>;
  }
  return (
    <>
      <StatusPill tone={kind}>{text}</StatusPill>
      {row.label === "最後のエラー" && view.lastError ? <code className={styles.error}>{view.lastError}</code> : null}
    </>
  );
}

/**
 * 7o K14: 設定 > システム > 配信ファイル の本文(先頭の段落 + 表「配置の状態」+ 公開中の全サイトの作り直し)。
 * 作り直しは確認(tone primary)の後、next が null になるまで POST /static/rebuild を繰り返す(runRebuild)。
 * 結果は押した場所のすぐ下の緑のカード(見出しにフォーカス)、失敗はボタンの上のエラーの箱(決まり 5.2・5.3)。
 * 終わったら表を取り直し、10 秒後にもう一度取り直す。router.refresh() にしないのは、取り直しが 503 だと画面がエラーの箱に替わり、
 * 結果のカード(受け付けられなかったサイトの ID)が消えるため。取り直せなければ表は前のまま。帯にも window のイベントで取り直させる
 */
export function StaticDeliveryPanel({ initial }: { initial: StaticHealthView }) {
  const ask = useConfirm();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RebuildTotal | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (result) heading.current?.focus();
  }, [result]);

  const reload = () => {
    api("GET", "/static/status")
      .then((data) => {
        const next = parseStaticHealth(data);
        if (next) setView(next);
      })
      .catch(() => {}); // 取り直せなければ表は前のまま(次に開いたときに直る)
    window.dispatchEvent(new Event(STATIC_HEALTH_REFRESH_EVENT));
  };

  async function rebuild() {
    setResult(null);
    const ok = await ask({
      title: "公開中の全サイトの配信ファイルを作り直しますか",
      body: (
        <>
          {rebuildConfirmParagraphs(view).map((p) => (
            <p key={p}>{p}</p>
          ))}
        </>
      ),
      confirmLabel: "作り直す",
      tone: "primary",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      // body は必ず JSON で送る(1 回目は {}、続きは { after })
      const total = await runRebuild(
        (after) => api<RebuildResult>("POST", "/static/rebuild", after === null ? {} : { after }),
        () => {},
      );
      setResult(total);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
      // 途中で失敗しても、それまでの頁は受け付けられているので取り直す
      reload();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, RECHECK_MS);
    }
  }

  const rows = staticHealthRows(view);
  // やることがあるときだけ主ボタン(決まり 2.4)
  const primary = recordIssueCount(view) > 0;
  return (
    <>
      <p className={`muted ${styles.lead}`}>
        設置タグの配信ファイルは、公開のたびにデプロイ専用の Worker が作り直し、配信専用の Worker に置きます。配置に失敗しても公開そのものは成功し、訪問者には前の配信ファイルが届き続けるので、止まっていないかをここで確かめます。
      </p>
      <div className={styles.tableHead}>
        <h2>配置の状態</h2>
        <span className="muted">{rows.length} 項目</span>
      </div>
      <div className={`card-flush ${styles.scroll}`}>
        <table data-testid="static-health-table">
          <thead>
            <tr>
              <th>項目</th>
              <th>状態</th>
              <th>説明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td className={styles.state}>
                  <StateCell row={row} view={view} />
                </td>
                <td className="muted">{row.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="card" data-testid="static-rebuild">
        <h2>公開中の全サイトの配信ファイルを作り直す</h2>
        <p>公開中の全サイトの配信ファイルを、今の公開内容で作り直します。削除の途中のサイトは対象外です。</p>
        <p className="field-hint">デプロイ専用の Worker を作り直した後や、データベースを過去の時点に戻した後に使います。</p>
        <ErrorBox message={error} />
        <div className={styles.foot}>
          <button type="button" className={primary ? "btn btn-primary" : "btn"} onClick={rebuild} disabled={busy}>
            {busy ? "作り直し中…" : "公開中の全サイトの配信ファイルを作り直す"}
          </button>
        </div>
      </section>
      {result ? (
        <section className={`card enter ${styles.done}`} aria-labelledby="static-rebuild-done" data-testid="static-rebuild-result">
          <h2 id="static-rebuild-done" ref={heading} tabIndex={-1}>
            作り直しを受け付けました
          </h2>
          {rebuildResultLines(result).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <div className={styles.doneFoot}>
            <button type="button" className="btn btn-primary" onClick={() => setResult(null)}>
              閉じる
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
