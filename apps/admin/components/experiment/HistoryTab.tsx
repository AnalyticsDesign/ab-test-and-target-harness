"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "@/lib/client";
import { auditActionLabel, auditActorLabel, auditDetailLine, auditViaLabel, type AuditEventView, type AuditPerson, type ExperimentHistoryResponse } from "@/lib/audit-labels";
import { LocalTime } from "../LocalTime";
import { AppLink } from "../ui/AppLink";

/**
 * エクスペリエンスの「変更履歴」のタブ(B129 spec §7.1。モックの案 A)。全員(閲覧者を含む)に出す。
 *
 * 読み込み(spec §10.6): このタブを開いたときに、ブラウザから BFF 経由で `GET …/history` を 1 回読む(BFF が lib/control.ts の controlRequest で control へ)。
 * 部品はタブを開いている間だけ描かれる(ExperimentEditor)ので、ほかのタブを見ている間は読まない = エクスペリエンスの画面の要求数は変わらない。
 * 「さらに 100 件を読み込む」で続き(cursor)。
 *
 * 読み直し: このタブを開いたまま保存したときは、`router.refresh` には頼らず、このタブの中で読み直す(reloadKey が進む。
 * 保存の書き込みが成功した直後に外枠が進めるので、ページの読み直しと並んで 1 本だけ走る。途中の段まで書けて失敗したとき・書けたか分からないときも進む)。状態の変更(見出しのボタン・終了のモーダル)は
 * 読み直しで届く status の変化で読み直す。どちらも lib/refresh-wait.ts の読み直しの守り(遷移を後に回す)の外で、遷移を待たせない。
 * 読み直しの間は前の表を出したままにし(ちらつかせない)、届いたら最初のページに置き換える
 */
type Props = {
  siteId: string;
  experimentId: string;
  /** 公開履歴の画面(表の上の 1 行のリンク) */
  publishHistoryHref: string;
  /** エクスペリエンスの作成時刻(作成の記録が無いとき = 記録を始める前に作られたときの「作成」の日付) */
  createdAt: number;
  /** 今のパターンの ID → 名前(採用の記録は ID だけを持つ) */
  variantNames: Readonly<Record<string, string>>;
  /** 進むと最初のページから読み直す(保存の書き込みの成功・途中の段までの書き込み・書けたか分からない保存・状態の変化) */
  reloadKey: string;
};

type Page = { events: AuditEventView[]; nextCursor: string | null; createdBy: AuditPerson; updatedBy: AuditPerson };
export type HistoryLoad =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; page: Page; more: "idle" | "loading" | { error: string } };
type Load = HistoryLoad;

/**
 * 続きのページを今の表に足す。足すのは、続きを読んだカーソルが今の表の続き(nextCursor)と同じときだけ。
 * 保存の後の読み直しの間に「さらに 100 件」を押し、読み直しが先に返ったときは、表はもう新しい 1 ページ目なので、
 * 古いカーソルの続きを後ろに足すと境目の行が抜ける(読み直しが more を idle に戻すので二重押しもできる)。その応答は捨てる
 */
export function appendMore(l: HistoryLoad, cursor: string, r: Pick<Page, "events" | "nextCursor">): HistoryLoad {
  if (l.kind !== "ok" || l.page.nextCursor !== cursor) return l;
  return { kind: "ok", page: { ...l.page, events: [...l.page.events, ...r.events], nextCursor: r.nextCursor }, more: "idle" };
}

export function HistoryTab({ siteId, experimentId, publishHistoryHref, createdAt, variantNames, reloadKey }: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const url = `/sites/${siteId}/experiments/${experimentId}/history`;
  // 要求の世代。古い応答(読み直しの前に出した要求・アンマウントの後に返った応答)は捨てる。続きの読み込みも同じ世代で見る
  const generation = useRef(0);

  const loadFirst = useCallback(async () => {
    const mine = ++generation.current;
    let next: Load;
    try {
      const r = await api<ExperimentHistoryResponse>("GET", url);
      next = { kind: "ok", page: r, more: "idle" };
    } catch (e) {
      next = { kind: "error", message: describeError(e) };
    }
    if (mine === generation.current) setLoad(next);
  }, [url]);

  useEffect(() => {
    void loadFirst();
    return () => {
      generation.current++;
    };
  }, [loadFirst, reloadKey]);

  async function loadMore(cursor: string) {
    const mine = generation.current;
    setLoad((l) => (l.kind === "ok" ? { ...l, more: "loading" } : l));
    try {
      const r = await api<ExperimentHistoryResponse>("GET", `${url}?cursor=${encodeURIComponent(cursor)}`);
      if (mine !== generation.current) return;
      setLoad((l) => appendMore(l, cursor, r));
    } catch (e) {
      if (mine !== generation.current) return;
      const error = describeError(e);
      setLoad((l) => (l.kind === "ok" && l.page.nextCursor === cursor ? { ...l, more: { error } } : l));
    }
  }

  if (load.kind === "loading") {
    return (
      <p className="muted" role="status" data-testid="history-loading">
        変更履歴を読み込んでいます…
      </p>
    );
  }
  if (load.kind === "error") {
    return (
      <div data-testid="history-error">
        <p className="error-box" role="alert">
          変更履歴を読めませんでした。{load.message}
        </p>
        <button type="button" className="btn" onClick={() => void loadFirst()}>
          読み込み直す
        </button>
      </div>
    );
  }
  const { page, more } = load;
  return (
    <HistoryTable
      page={page}
      publishHistoryHref={publishHistoryHref}
      createdAt={createdAt}
      variantNames={variantNames}
      more={more}
      onMore={page.nextCursor ? () => void loadMore(page.nextCursor!) : undefined}
    />
  );
}

/**
 * 表(読み込みの状態を持たない部分。test/history-tab.test.ts が描いて確かめる)。
 * 列は 日時(LocalTime)・操作した人(メールアドレスは応答にあるときだけ = 管理者以上)・ログイン方法(パスワード・非常口は黄)・操作・内容
 */
export function HistoryTable({
  page,
  publishHistoryHref,
  createdAt,
  variantNames,
  more = "idle",
  onMore,
}: {
  page: Page;
  publishHistoryHref: string;
  createdAt: number;
  variantNames: Readonly<Record<string, string>>;
  more?: "idle" | "loading" | { error: string };
  onMore?: () => void;
}) {
  const { events, nextCursor } = page;
  // 作成の行(このエクスペリエンスを作った・複製して作った記録)。新しい順なので最後のページにある
  const created = events.find((e) => e.action === "experiment.create" || e.action === "experiment.duplicate");
  return (
    <div data-testid="history-tab">
      {/* モックの案 A の順: 見出し → 説明の 1 行 → 表 */}
      <div className="row" style={{ alignItems: "baseline" }}>
        <h2>変更履歴</h2>
        <span className="muted" data-testid="history-count">
          {events.length} 件{nextCursor ? "以上" : ""}
        </span>
      </div>
      <p className="muted">
        変更の中身(HTML・CSS・JS)の違いは残りません。公開した版の中身は<AppLink href={publishHistoryHref}>公開履歴</AppLink>で見られます
      </p>
      {/* 狭い幅では表を横に送る(列を切らない) */}
      <div className="card-flush scroll-x">
        <table data-testid="history-table">
          <thead>
            <tr>
              <th className="nowrap">日時</th>
              <th>操作した人</th>
              <th className="nowrap">ログイン方法</th>
              <th>操作</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  まだ変更の記録はありません
                </td>
              </tr>
            ) : null}
            {events.map((e) => {
              const who = auditActorLabel(e);
              const via = auditViaLabel(e);
              return (
                <tr key={e.id} data-testid="history-row" data-op={e.action}>
                  <td className="nowrap num">
                    <LocalTime at={e.at} />
                  </td>
                  <td>
                    {who.name}
                    {who.email ? <div className="muted">{who.email}</div> : null}
                  </td>
                  <td className="nowrap">
                    <span className={via.warn ? "badge badge-warn" : "badge"}>{via.text}</span>
                  </td>
                  <td>{auditActionLabel(e)}</td>
                  <td>{auditDetailLine(e, { variantNames })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {onMore ? (
        <div className="row">
          {typeof more === "object" ? (
            <span className="field-error" role="alert">
              続きを読めませんでした。{more.error}
            </span>
          ) : null}
          <button type="button" className="btn" disabled={more === "loading"} onClick={onMore}>
            {more === "loading" ? "読み込んでいます…" : "さらに 100 件を読み込む"}
          </button>
        </div>
      ) : null}
      {created ? (
        <p className="muted" data-testid="history-created">
          作成: {auditActorLabel(created).name}(<LocalTime at={created.at} kind="date" />)
        </p>
      ) : !nextCursor ? (
        // 作成の記録が無い = 記録を始める前に作られた(D4)。作った人と最後に変えた人は、エクスペリエンスの行から出す
        <p className="muted" data-testid="history-created">
          作成: {personName(page.createdBy)}(<LocalTime at={createdAt} kind="date" />)・最後に変えた人: {personName(page.updatedBy)}。記録を始める前の変更は、作った人と最後に変えた人だけが分かります
        </p>
      ) : null}
    </div>
  );
}

/** 作った人・最後に変えた人の名前。消えた人は「削除された人」 */
const personName = (p: AuditPerson) => p.name ?? "削除された人";
