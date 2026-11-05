import { auditActorLabel, type AuditEventView } from "./audit-labels";
import { pickParam } from "./url-state";

/**
 * B129(spec §7.2): 設定の「操作の記録」(ワークスペース・導入全体)の絞り込み。React に依らない部分(test/audit-log.test.ts)。
 *
 * - 状態は URL(`?days=&from=&to=&kind=&elevated=&who=`)。既定(直近 30 日・すべて・補助の絞り込みなし・操作した人なし)は書かない
 * - 期間(days か from・to)・種類(kind)・elevated は API の引数(since・until・category・elevated)にして読み直す。1 ページ目から
 * - 操作した人(who)は読み込んだ記録の中で画面が絞る(spec D6。再取得しない)
 * - 期間の from・to は epoch ミリ秒。to は「その時刻まで(含む)」。入力は分の単位で、終わりはその分の最後の 1 ミリ秒まで(rangeFromInputs)
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const AUDIT_DAYS = ["7", "30", "90", "365"] as const;
export type AuditDays = 7 | 30 | 90 | 365;
export const AUDIT_KINDS = ["all", "access", "content"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export type AuditFilter = {
  /** 直近 N 日(from が null のとき使う) */
  days: AuditDays;
  /** 開始と終了の日時(epoch ミリ秒)。from が null なら days。to が null なら今まで */
  from: number | null;
  to: number | null;
  kind: AuditKind;
  /** パスワードのログイン・非常口だけ(補助の絞り込み) */
  elevated: boolean;
  /** 操作した人(名前かメールアドレスの一部。画面の中だけ) */
  who: string;
};

export const DEFAULT_AUDIT_FILTER: AuditFilter = { days: 30, from: null, to: null, kind: "all", elevated: false, who: "" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const epoch = (v: string | string[] | undefined): number | null => {
  const s = first(v);
  if (s === undefined || !/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

/** ページの searchParams から絞り込みを読む。許していない値は既定に戻す(開始の無い to は捨てる) */
export function parseAuditFilter(sp: SearchParams): AuditFilter {
  const from = epoch(sp.from);
  return {
    days: Number(pickParam(sp.days, AUDIT_DAYS, "30")) as AuditDays,
    from,
    to: from === null ? null : epoch(sp.to),
    kind: pickParam(sp.kind, AUDIT_KINDS, "all"),
    elevated: first(sp.elevated) === "1",
    who: first(sp.who) ?? "",
  };
}

/** URL の search(`?…`。既定と同じ値は書かない。すべて既定なら空) */
export function auditFilterSearch(f: AuditFilter): string {
  const p = new URLSearchParams();
  if (f.from !== null) {
    p.set("from", String(f.from));
    if (f.to !== null) p.set("to", String(f.to));
  } else if (f.days !== DEFAULT_AUDIT_FILTER.days) p.set("days", String(f.days));
  if (f.kind !== "all") p.set("kind", f.kind);
  if (f.elevated) p.set("elevated", "1");
  if (f.who !== "") p.set("who", f.who);
  const q = p.toString();
  return q ? `?${q}` : "";
}

/**
 * control の `GET /workspaces/:wid/audit-events`・`GET /audit-events` の引数(`?` を付けない)。who は入れない(画面の中だけ)。
 * now は直近 N 日の起点(呼ぶ側が渡す。サーバーの描画と画面の操作で同じ組み方にする)
 */
export function auditApiQuery(f: AuditFilter, now: number): string {
  const p = new URLSearchParams();
  if (f.from !== null) {
    p.set("since", String(f.from));
    if (f.to !== null) p.set("until", String(f.to));
  } else p.set("since", String(now - f.days * DAY_MS));
  if (f.kind !== "all") p.set("category", f.kind);
  if (f.elevated) p.set("elevated", "true");
  return p.toString();
}

/** 続きの読み込み(前の応答の nextCursor) */
export function withCursor(query: string, cursor: string): string {
  const p = new URLSearchParams(query);
  p.set("cursor", cursor);
  return p.toString();
}

/** 操作した人の絞り込み(画面の中だけ)。名前・メールアドレス・操作した人の無い行の言い方(非常用トークンなど)の一部。大文字と小文字は区別しない */
export function filterByWho(events: AuditEventView[], who: string): AuditEventView[] {
  const q = who.trim().toLowerCase();
  if (q === "") return events;
  return events.filter((e) => {
    const p = auditActorLabel(e);
    return p.name.toLowerCase().includes(q) || (p.email ?? "").toLowerCase().includes(q);
  });
}

/** `GET /workspaces/:wid/audit-events`・`GET /audit-events` の応答(導入全体は各行に workspaceName) */
export type AuditPageData = { events: AuditEventView[]; nextCursor: string | null };

// ---- 日時の入力(<input type="datetime-local">。見ている人のタイムゾーン = 表の LocalTime と同じ) ----

const pad = (n: number) => String(n).padStart(2, "0");

/** epoch ミリ秒 → 入力の値(分まで)。ブラウザのタイムゾーンで作るので、マウントの後にだけ呼ぶ */
export function toLocalInput(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 入力の値 → epoch ミリ秒(その分の始まり)。読めなければ null */
export function fromLocalInput(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(at) ? at : null;
}

/** 開始と終了の入力 → 期間。終了はその分の最後の 1 ミリ秒まで含める(入れ直しても同じ値)。終了が空なら今まで。names = エラーの文の欄の名前、field = エラーを付ける欄 */
export function rangeFromInputs(
  fromInput: string,
  toInput: string,
  names: { start: string; end: string; unit: string } = { start: "開始", end: "終了", unit: "の日時" },
): { ok: true; from: number; to: number | null } | { ok: false; field: "from" | "to"; error: string } {
  const from = fromLocalInput(fromInput);
  if (from === null) return { ok: false, field: "from", error: `${names.start}${names.unit}を入れてください` };
  if (toInput.trim() === "") return { ok: true, from, to: null };
  const toStart = fromLocalInput(toInput);
  if (toStart === null) return { ok: false, field: "to", error: `${names.end}${names.unit}を読めません` };
  const to = toStart + 59_999;
  if (to < from) return { ok: false, field: "to", error: `${names.end}は${names.start}より後にしてください` };
  return { ok: true, from, to };
}

// ---- 非常口を開いていた期間(Q16) ----

/**
 * 記録からの推定: 最後に開いていた期間の、最初の非常口からの再設定リンクの発行 〜 次の掃除(break_glass.sweep)。
 * 入力の初期値の目安だけに使う(実際より狭くなりうる: 再設定リンクを出す前の招待の受諾は入らず、掃除は消す行が無いと記録されない)。
 * 再設定リンクの記録が無ければ開始は空、その後の掃除が無ければ終わりは空。読むのは画面が読み込んだ記録だけ(要求を足さない)
 */
export function breakGlassWindowGuess(events: AuditEventView[]): { from: number | null; to: number | null } {
  const resets = events.filter((e) => e.action === "break_glass.reset_link").map((e) => e.at);
  const sweeps = events.filter((e) => e.action === "break_glass.sweep").map((e) => e.at);
  if (resets.length === 0) return { from: null, to: sweeps.length ? Math.max(...sweeps) : null };
  const last = Math.max(...resets);
  const before = sweeps.filter((s) => s < last);
  const opened = before.length ? Math.max(...before) : -Infinity;
  const after = sweeps.filter((s) => s > last);
  return { from: Math.min(...resets.filter((r) => r > opened)), to: after.length ? Math.min(...after) : null };
}

/** 非常口の期間の入力の初期値。URL に期間があれば(操作する人が入れた値)それを、無ければ記録からの推定 */
export function breakGlassWindowInitial(f: AuditFilter, events: AuditEventView[]): { from: number | null; to: number | null } {
  return f.from !== null ? { from: f.from, to: f.to } : breakGlassWindowGuess(events);
}
