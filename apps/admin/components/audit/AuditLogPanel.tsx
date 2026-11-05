"use client";
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "@/lib/client";
import { auditActionLabel, auditActorLabel, auditDetailLine, auditTargetLabel, auditViaLabel, type AuditEventView } from "@/lib/audit-labels";
import {
  auditApiQuery,
  auditFilterSearch,
  breakGlassWindowInitial,
  filterByWho,
  rangeFromInputs,
  toLocalInput,
  withCursor,
  type AuditDays,
  type AuditFilter,
  type AuditKind,
  type AuditPageData,
} from "@/lib/audit-log";
import { replaceSearch } from "@/lib/url-state";
import { Field } from "../Field";
import { LocalTime } from "../LocalTime";
import { Picker, type PickerOption } from "../ui/Picker";
import styles from "./AuditLog.module.css";

/**
 * 設定の「操作の記録」の本文(B129 spec §7.2。モックの案 A。CSV の書き出しは置かない)。ワークスペースの記録と導入全体の記録が共有する。
 *
 * 読み込み(spec §10.2・§10.6): 最初のページはサーバーの描画で 1 本(page.tsx。layout の 3 本と合わせて 4 本)。ここからは BFF 経由で
 * (`api()` → `/api/control/*` → lib/control.ts の controlRequest)次の 2 つだけを読む:
 * - 期間・種類・「パスワードのログイン・非常口だけ」を変えたとき: 1 ページ目を 1 本(ページの読み直し = layout の 3 本は走らせない)
 * - 「さらに 100 件を読み込む」: 同じ引数に cursor を足して 1 本
 * 「操作した人」は読み込んだ記録の中で絞るだけで、読み直さない(spec D6)。
 *
 * URL: 絞り込みは `?days=&from=&to=&kind=&elevated=&who=` に history.replaceState で書く(lib/url-state.ts の replaceSearch。
 * admin_ui_rules 3.4 と同じく履歴を増やさず、ルーター = lib/navigate.ts を通さない)。再読み込み・URL を開いたときは page.tsx が同じ形で読む。
 * ページの印(PageMark)は最初の URL のまま。設定のメニューから同じ画面(search なし)へ移るときは navigate.ts の「最後の印と同じ URL」の扱いになる。
 *
 * 時刻の入力(datetime-local)は見ている人のタイムゾーンなので、値はマウントの後に入れる(サーバー = UTC の描画と食い違わないように)
 */
type Props = {
  scope: "workspace" | "instance";
  /** BFF の後ろの control のパス(`/workspaces/:wid/audit-events` か `/audit-events`) */
  apiPath: string;
  initialFilter: AuditFilter;
  initialQuery: string;
  initialPage: AuditPageData;
};

type More = "idle" | "loading" | { error: string };
/** 期間の入力のエラー(付ける欄と文) */
type InputError = { field: "from" | "to"; message: string };
type Load = { kind: "loading"; query: string } | { kind: "error"; query: string; message: string } | { kind: "ok"; query: string; page: AuditPageData; more: More };

/** 期間の選択肢(直近 N 日と「日時を指定」= range) */
const PERIOD_OPTIONS: PickerOption[] = [
  { value: "7", label: "直近 7 日" },
  { value: "30", label: "直近 30 日" },
  { value: "90", label: "直近 90 日" },
  { value: "365", label: "直近 365 日" },
  { value: "range", label: "日時を指定" },
];
const KIND_OPTIONS: Array<PickerOption & { value: AuditKind }> = [
  { value: "all", label: "すべて" },
  { value: "access", label: "人とアクセス権" },
  { value: "content", label: "サイト・エクスペリエンス" },
];

/** 続きのページを今の表に足す。足すのは、読んだ引数と cursor が今の表のものと同じときだけ(絞り込みを変えた後に返った古い続きは捨てる) */
export function appendAuditMore(l: Load, query: string, cursor: string, r: AuditPageData): Load {
  if (l.kind !== "ok" || l.query !== query || l.page.nextCursor !== cursor) return l;
  return { kind: "ok", query, page: { events: [...l.page.events, ...r.events], nextCursor: r.nextCursor }, more: "idle" };
}

export function AuditLogPanel({ scope, apiPath, initialFilter, initialQuery, initialPage }: Props) {
  const [filter, setFilter] = useState<AuditFilter>(initialFilter);
  const [load, setLoad] = useState<Load>({ kind: "ok", query: initialQuery, page: initialPage, more: "idle" });
  // 期間の選択で「日時を指定」を選んだが、まだ読んでいない
  const [rangeOpen, setRangeOpen] = useState(initialFilter.from !== null);
  const [range, setRange] = useState({ from: "", to: "" });
  const [rangeError, setRangeError] = useState<InputError | null>(null);
  // 要求の世代。古い応答(絞り込みを変える前に出した要求)は捨てる
  const generation = useRef(0);

  // 期間の入力の値は、見ている人のタイムゾーンで作るのでマウントの後に入れる
  useEffect(() => {
    if (initialFilter.from !== null) setRange({ from: toLocalInput(initialFilter.from), to: initialFilter.to === null ? "" : toLocalInput(initialFilter.to) });
  }, [initialFilter.from, initialFilter.to]);

  async function readFirst(next: AuditFilter) {
    // 直近 N 日の起点は読み直しを始めた時刻(イベントの中で読む。描画の文字にはしない)
    const query = auditApiQuery(next, Date.now());
    const mine = ++generation.current;
    setLoad({ kind: "loading", query });
    let result: Load;
    try {
      const page = await api<AuditPageData>("GET", `${apiPath}?${query}`);
      result = { kind: "ok", query, page, more: "idle" };
    } catch (e) {
      result = { kind: "error", query, message: describeError(e) };
    }
    if (mine === generation.current) setLoad(result);
  }

  /**
   * 期間・種類・elevated の変更: URL に書いて 1 ページ目から読み直す。
   * 期間の選択欄は読んだ期間に揃える(「日時を指定」を選んで送らないまま種類などを変えたら、表は直近 N 日で読むので選択欄も直近 N 日に戻す)
   */
  function apply(next: AuditFilter) {
    setFilter(next);
    setRangeOpen(next.from !== null);
    if (next.from === null) setRangeError(null);
    replaceSearch(auditFilterSearch(next));
    void readFirst(next);
  }

  function applyRange(from: string, to: string): boolean {
    const r = rangeFromInputs(from, to);
    if (!r.ok) {
      setRangeError({ field: r.field, message: r.error });
      return false;
    }
    setRangeError(null);
    setRangeOpen(true);
    setRange({ from: toLocalInput(r.from), to: r.to === null ? "" : toLocalInput(r.to) });
    apply({ ...filter, from: r.from, to: r.to });
    return true;
  }

  function onWho(who: string) {
    const next = { ...filter, who };
    setFilter(next);
    replaceSearch(auditFilterSearch(next));
  }

  async function loadMore(query: string, cursor: string) {
    const mine = generation.current;
    setLoad((l) => (l.kind === "ok" ? { ...l, more: "loading" } : l));
    try {
      const r = await api<AuditPageData>("GET", `${apiPath}?${withCursor(query, cursor)}`);
      if (mine === generation.current) setLoad((l) => appendAuditMore(l, query, cursor, r));
    } catch (e) {
      if (mine !== generation.current) return;
      const error = describeError(e);
      setLoad((l) => (l.kind === "ok" && l.query === query && l.page.nextCursor === cursor ? { ...l, more: { error } } : l));
    }
  }

  const periodValue = rangeOpen ? "range" : String(filter.days);

  return (
    <div data-testid="audit-log">
      {/* モックの案 A の順: 説明(page.tsx)→ 非常口の後の確かめ方 → 絞り込み → 表。
          確かめ方は導入全体の記録だけ(パスワードでのログイン・非常口の操作の行はワークスペースの記録に入らない)。ワークスペースの記録では確かめ先を 1 行で案内する */}
      {scope === "instance" ? (
        <p className="banner-note" style={{ display: "block" }}>
          非常口を閉じた後は、開いた時刻から閉じた時刻までの範囲で、すべてのログイン方法の操作を確かめてください。「パスワードのログイン・非常口だけ」の絞り込みは補助です。
        </p>
      ) : (
        <p className="muted">パスワードでのログインそのものと非常口の操作(再設定リンクの発行・閉じた後の掃除)は、この記録に入りません。非常口を閉じた後の確かめは、システム管理者が導入全体の操作の記録(設定のメニューの「システム」の見出しの下の「操作の記録」)で行います。</p>
      )}
      {scope === "instance" ? <BreakGlassWindow filter={filter} initialEvents={initialPage.events} onApply={applyRange} /> : null}
      <div className={styles.filters} role="group" aria-label="絞り込み">
        {/* Picker は listbox を持つので label で包まない(Field の group) */}
        <Field label="期間" group>
          <Picker
            label="期間"
            value={periodValue}
            options={PERIOD_OPTIONS}
            onChange={(v) => {
              if (v === "range") {
                setRangeOpen(true);
                return;
              }
              apply({ ...filter, days: Number(v) as AuditDays, from: null, to: null });
            }}
          />
        </Field>
        <Field label="種類" group>
          <Picker label="種類" value={filter.kind} options={KIND_OPTIONS} onChange={(v) => apply({ ...filter, kind: v as AuditKind })} />
        </Field>
        <Field label="操作した人">
          <input type="search" value={filter.who} placeholder="名前かメールアドレス" onChange={(e) => onWho(e.target.value)} />
        </Field>
        <label className={styles.toggle}>
          <input type="checkbox" checked={filter.elevated} onChange={(e) => apply({ ...filter, elevated: e.target.checked })} />
          パスワードのログイン・非常口だけ
        </label>
      </div>
      {rangeOpen ? (
        <form
          className={styles.range}
          style={{ marginBottom: 16 }}
          aria-label="期間の日時"
          onSubmit={(e) => {
            e.preventDefault();
            applyRange(range.from, range.to);
          }}
        >
          <Field label="開始" error={rangeError?.field === "from" ? rangeError.message : null}>
            <input type="datetime-local" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </Field>
          <Field label="終了(空 = 今まで)" error={rangeError?.field === "to" ? rangeError.message : null}>
            <input type="datetime-local" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </Field>
          <button type="submit" className="btn">
            この期間で読む
          </button>
        </form>
      ) : null}
      {load.kind === "loading" ? (
        <p className="muted" role="status" data-testid="audit-loading">
          記録を読み込んでいます…
        </p>
      ) : null}
      {load.kind === "error" ? (
        <div data-testid="audit-error">
          <p className="error-box" role="alert">
            操作の記録を読めませんでした。{load.message}
          </p>
          <button type="button" className="btn" onClick={() => void readFirst(filter)}>
            読み込み直す
          </button>
        </div>
      ) : null}
      {load.kind === "ok" ? (
        <AuditTable
          scope={scope}
          page={load.page}
          shown={filterByWho(load.page.events, filter.who)}
          who={filter.who}
          more={load.more}
          onMore={load.page.nextCursor ? () => void loadMore(load.query, load.page.nextCursor!) : undefined}
        />
      ) : null}
    </div>
  );
}

const WINDOW_NAMES = { start: "開いた時刻", end: "閉じた時刻", unit: "" };

/**
 * 導入全体の記録の「非常口を開いていた期間で絞る」(Q16)。操作する人が開いた時刻と閉じた時刻を入れ、期間の絞り込み(since・until)で読む。
 * 初期値は URL の期間か、読み込んだ記録からの推定(最初の非常口からの再設定リンクの発行 〜 次の掃除)。推定は目安で、記録が無ければ空
 */
function BreakGlassWindow({ filter, initialEvents, onApply }: { filter: AuditFilter; initialEvents: AuditEventView[]; onApply: (from: string, to: string) => boolean }) {
  const [value, setValue] = useState({ from: "", to: "" });
  const [error, setError] = useState<InputError | null>(null);
  // 初期値はマウントの後に 1 回だけ入れる(見ている人のタイムゾーン。入れた後は人の入力を上書きしない)
  const initial = useRef({ filter, initialEvents });
  useEffect(() => {
    const w = breakGlassWindowInitial(initial.current.filter, initial.current.initialEvents);
    setValue({ from: w.from === null ? "" : toLocalInput(w.from), to: w.to === null ? "" : toLocalInput(w.to) });
  }, []);
  return (
    <section className="card" aria-labelledby="break-glass-window" data-testid="break-glass-window">
      <h2 id="break-glass-window" style={{ marginTop: 0 }}>
        非常口を開いていた期間で絞る
      </h2>
      <p className="muted">
        非常用トークン(secret)を入れた時刻と消した時刻を入れてください。初期値は記録からの推定(最初の非常口からの再設定リンクの発行 〜 次の掃除)で、実際より狭くなることがあります(再設定リンクを出す前の招待の受諾は入らず、掃除は消すものが無いと記録されません)。
      </p>
      <form
        className={styles.range}
        onSubmit={(e) => {
          e.preventDefault();
          const r = rangeFromInputs(value.from, value.to, WINDOW_NAMES);
          if (!r.ok) {
            setError({ field: r.field, message: r.error });
            return;
          }
          setError(null);
          onApply(value.from, value.to);
        }}
      >
        <Field label="開いた時刻" error={error?.field === "from" ? error.message : null}>
          <input type="datetime-local" value={value.from} onChange={(e) => setValue({ ...value, from: e.target.value })} />
        </Field>
        <Field label="閉じた時刻(空 = 今まで)" error={error?.field === "to" ? error.message : null}>
          <input type="datetime-local" value={value.to} onChange={(e) => setValue({ ...value, to: e.target.value })} />
        </Field>
        <button type="submit" className="btn">
          この期間で絞る
        </button>
      </form>
    </section>
  );
}

/**
 * 表(spec §7.2)。列は 日時・(ワークスペース)・操作した人(名前 + メールアドレス)・ログイン方法(パスワード・非常口は黄)・操作と対象・内容。
 * shown = 操作した人で絞った後の行。続きの読み込みと「これより前の記録はありません」は、読み込んだ記録(page)で決める
 */
export function AuditTable({
  scope,
  page,
  shown,
  who,
  more,
  onMore,
}: {
  scope: "workspace" | "instance";
  page: AuditPageData;
  shown: AuditEventView[];
  who: string;
  more: More;
  onMore?: () => void;
}) {
  const wsCol = scope === "instance";
  const loaded = page.events.length;
  const count = who.trim() !== "" ? `${shown.length} 件(読み込んだ ${loaded} 件のうち)` : `${loaded} 件${page.nextCursor ? "以上" : ""}`;
  return (
    <>
      <div className="row" style={{ alignItems: "baseline" }}>
        <h2>記録</h2>
        <span className="muted" data-testid="audit-count">
          {count}
        </span>
      </div>
      {/* 狭い幅では表を横に送る(列を切らない) */}
      <div className="card-flush scroll-x">
        <table data-testid="audit-table">
          <thead>
            <tr>
              <th className="nowrap">日時</th>
              {wsCol ? <th>ワークスペース</th> : null}
              <th>操作した人</th>
              <th className="nowrap">ログイン方法</th>
              <th>操作・対象</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={wsCol ? 6 : 5} className="muted">
                  この条件に一致する記録はありません
                </td>
              </tr>
            ) : null}
            {shown.map((e) => {
              const person = auditActorLabel(e);
              const via = auditViaLabel(e);
              const target = auditTargetLabel(e);
              return (
                <tr key={e.id} data-testid="audit-row" data-id={e.id} data-op={e.action} data-via={e.via}>
                  <td className="nowrap num">
                    <LocalTime at={e.at} />
                  </td>
                  {wsCol ? <td>{e.workspaceId === null ? "—" : (e.workspaceName ?? "(削除されたワークスペース)")}</td> : null}
                  <td>
                    {person.name}
                    {person.email ? <div className="muted">{person.email}</div> : null}
                  </td>
                  <td className="nowrap">
                    <span className={via.warn ? "badge badge-warn" : "badge"}>{via.text}</span>
                  </td>
                  <td>
                    {auditActionLabel(e)}
                    {target ? <div className="muted break-anywhere">{target}</div> : null}
                  </td>
                  <td>{auditDetailLine(e)}</td>
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
          <button type="button" className="btn" data-testid="audit-more" disabled={more === "loading"} onClick={onMore}>
            {more === "loading" ? "読み込んでいます…" : "さらに 100 件を読み込む"}
          </button>
        </div>
      ) : loaded > 0 ? (
        <p className="muted" data-testid="audit-end">
          これより前の記録はありません
        </p>
      ) : null}
    </>
  );
}
