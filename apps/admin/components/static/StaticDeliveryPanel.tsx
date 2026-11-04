"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { NO_NOTICE, REFRESH_TIMEOUT, noticeOf, type BusyNotice } from "@/lib/busy-notice";
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
import { BusyScope, useBusyAction } from "../ui/BusyScope";
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
 * 結果のカード(受け付けられなかったサイトの ID)が消えるため。取り直せなければ表は前のまま。帯にも window のイベントで取り直させる。
 * B173 第 2 段: 作り直しの間は、確認を閉じてからボタンのあるカード(BusyScope)を覆う。取り直しは after: "custom"(上限 10 秒)
 */
export function StaticDeliveryPanel({ initial }: { initial: StaticHealthView }) {
  const [view, setView] = useState(initial);
  const [result, setResult] = useState<RebuildTotal | null>(null);
  /** 作り直しは受け付けたが、表の取り直しが 10 秒で終わらなかった(結果のカードの下に再読み込みの案内) */
  const [stale, setStale] = useState(false);
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

  /**
   * 表を取り直す(帯にも知らせる)。signal で打ち切る。GET の失敗・形の合わない応答(parseStaticHealth が null)は投げる:
   * 作り直しの後の取り直し(after: "custom")が、表の更新の失敗(refresh: "timeout" = 再読み込みの案内)として扱えるように(最終レビュー I2)。
   * 表は前のまま
   */
  const reloadOrThrow = async (signal?: AbortSignal): Promise<void> => {
    window.dispatchEvent(new Event(STATIC_HEALTH_REFRESH_EVENT));
    const next = parseStaticHealth(await api("GET", "/static/status", undefined, { signal }));
    if (!next) throw new Error("static status: unexpected response");
    setView(next);
  };
  /** 結果を待たない取り直し(失敗・30 秒の後と 10 秒後の取り直し)。取り直せなければ表は前のまま(次に開いたときに直る。拒否はここで握る) */
  const reload = (): void => {
    reloadOrThrow().catch(() => {});
  };
  /** 10 秒後にもう一度取り直す(配置が進んだ状態を見る) */
  const recheckLater = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reload, RECHECK_MS);
  };

  const rows = staticHealthRows(view);
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
      <BusyScope id="static-rebuild">
        <RebuildCard
          view={view}
          onStart={() => {
            setResult(null);
            setStale(false);
          }}
          onResult={setResult}
          onStale={() => setStale(true)}
          reload={reload}
          reloadOrThrow={reloadOrThrow}
          recheckLater={recheckLater}
        />
      </BusyScope>
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
      {result && stale ? <p role="status">{REFRESH_TIMEOUT}</p> : null}
    </>
  );
}

/**
 * 作り直しのボタンのあるカード(BusyScope の中。確認・実行権・覆いをこの範囲に結び付ける)。
 * 結果: saved(done)→ 結果のカード / saved(timeout)→ 結果のカードを保ち、その下に再読み込みの案内(送り直さない)/
 * failed → カードの中の ErrorBox と取り直し / unknown → 30 秒の文言と取り直し(残りの POST は signal で止まる)/ それ以外 → 何も出さない
 */
function RebuildCard({
  view,
  onStart,
  onResult,
  onStale,
  reload,
  reloadOrThrow,
  recheckLater,
}: {
  view: StaticHealthView;
  onStart: () => void;
  onResult: (total: RebuildTotal) => void;
  onStale: () => void;
  reload: () => void;
  reloadOrThrow: (signal?: AbortSignal) => Promise<void>;
  recheckLater: () => void;
}) {
  const ask = useConfirm();
  const { run, busy } = useBusyAction();
  const [notice, setNotice] = useState<BusyNotice>(NO_NOTICE);

  async function rebuild() {
    const outcome = await run<RebuildTotal>({
      label: "作り直し中…",
      confirm: async () => {
        onStart();
        setNotice(NO_NOTICE);
        return ask({
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
      },
      // body は必ず JSON で送る(1 回目は {}、続きは { after })
      write: (signal) =>
        runRebuild(
          (after, s) => api<RebuildResult>("POST", "/static/rebuild", after === null ? {} : { after }, { signal: s }),
          () => {},
          signal,
        ),
      onWritten: onResult,
      // router.refresh() にしない(コンポーネントの先頭のコメント)。表と帯を取り直し、10 秒後にもう一度取り直す。
      // 取り直しの失敗は投げる(runBusy が saved の refresh: "timeout" にし、結果のカードを保って再読み込みの案内を出す)
      after: "custom",
      custom: async (_total, signal) => {
        recheckLater();
        await reloadOrThrow(signal);
      },
    });
    if (outcome.kind === "failed" || outcome.kind === "unknown") {
      // 途中で失敗しても、それまでの頁は受け付けられているので取り直す
      reload();
      recheckLater();
    }
    if (outcome.kind === "saved") {
      // 成功の文は結果のカード(別の箱)に出る。取り直しが上限を超えたときは、その下に再読み込みの案内(書き込みの失敗としては出さない)
      if (outcome.refresh === "timeout") onStale();
      return;
    }
    const next = noticeOf(outcome, null);
    if (next) setNotice(next);
  }

  // やることがあるときだけ主ボタン(決まり 2.4)
  const primary = recordIssueCount(view) > 0;
  return (
    <section className="card" data-testid="static-rebuild">
      <h2>公開中の全サイトの配信ファイルを作り直す</h2>
      <p>公開中の全サイトの配信ファイルを、今の公開内容で作り直します。削除の途中のサイトは対象外です。</p>
      <p className="field-hint">デプロイ専用の Worker を作り直した後や、データベースを過去の時点に戻した後に使います。</p>
      <ErrorBox message={notice.error} />
      <div className={styles.foot}>
        <button type="button" className={primary ? "btn btn-primary" : "btn"} onClick={rebuild} disabled={busy}>
          公開中の全サイトの配信ファイルを作り直す
        </button>
      </div>
    </section>
  );
}
