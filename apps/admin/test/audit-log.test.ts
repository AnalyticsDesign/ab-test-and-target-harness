import { describe, expect, it } from "vitest";
import type { AuditEventView } from "@/lib/audit-labels";
import {
  DEFAULT_AUDIT_FILTER,
  auditApiQuery,
  auditFilterSearch,
  breakGlassWindowGuess,
  breakGlassWindowInitial,
  filterByWho,
  fromLocalInput,
  parseAuditFilter,
  rangeFromInputs,
  toLocalInput,
  withCursor,
  type AuditFilter,
} from "@/lib/audit-log";

/**
 * B129 Task 11(spec §7.2): 設定の「操作の記録」の絞り込み(URL の状態・API の引数・操作した人の絞り込み・非常口の期間の推定)
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const ev = (id: string, at: number, action: string, over: Partial<AuditEventView> = {}): AuditEventView => ({
  id,
  at,
  category: "access",
  action,
  workspaceId: null,
  siteId: null,
  experimentId: null,
  via: "password",
  actor: { userId: "u", name: "田中 花子", email: "hanako@example.com" },
  apiKey: null,
  target: null,
  detail: {},
  ...over,
});
const f = (over: Partial<AuditFilter> = {}): AuditFilter => ({ ...DEFAULT_AUDIT_FILTER, ...over });
const params = (q: string) => Object.fromEntries(new URLSearchParams(q));

describe("audit log filter (URL)", () => {
  it("parses the URL state and falls back to the defaults", () => {
    expect(parseAuditFilter({})).toEqual(DEFAULT_AUDIT_FILTER);
    expect(DEFAULT_AUDIT_FILTER).toEqual({ days: 30, from: null, to: null, kind: "all", elevated: false, who: "" });
    expect(parseAuditFilter({ days: "7", kind: "access", elevated: "1", who: "jiro" })).toEqual(f({ days: 7, kind: "access", elevated: true, who: "jiro" }));
    expect(parseAuditFilter({ days: "8", kind: "people", elevated: "yes" })).toEqual(DEFAULT_AUDIT_FILTER);
    expect(parseAuditFilter({ from: "1000", to: "2000" })).toEqual(f({ from: 1000, to: 2000 }));
    // 終わりだけの期間は無い(開始の無い to は捨てる)。数でない値も捨てる
    expect(parseAuditFilter({ to: "2000" })).toEqual(DEFAULT_AUDIT_FILTER);
    expect(parseAuditFilter({ from: "abc" })).toEqual(DEFAULT_AUDIT_FILTER);
    expect(parseAuditFilter({ days: ["90", "7"] }).days).toBe(90);
  });

  it("writes only the values that differ from the defaults, and round-trips", () => {
    expect(auditFilterSearch(DEFAULT_AUDIT_FILTER)).toBe("");
    const all = f({ days: 90, kind: "content", elevated: true, who: "花子" });
    const search = auditFilterSearch(all);
    expect(search.startsWith("?")).toBe(true);
    expect(parseAuditFilter(params(search.slice(1)))).toEqual(all);
    const range = f({ from: 1000, to: 5000 });
    expect(params(auditFilterSearch(range).slice(1))).toEqual({ from: "1000", to: "5000" });
  });

  it("builds the API query: days to since, the range to since and until, the kind, elevated; who stays on the screen", () => {
    expect(params(auditApiQuery(f(), NOW))).toEqual({ since: String(NOW - 30 * DAY) });
    expect(params(auditApiQuery(f({ days: 365, kind: "access", elevated: true, who: "x" }), NOW))).toEqual({
      since: String(NOW - 365 * DAY),
      category: "access",
      elevated: "true",
    });
    expect(params(auditApiQuery(f({ days: 7, from: 1000, to: 2000, kind: "content" }), NOW))).toEqual({ since: "1000", until: "2000", category: "content" });
    // 終わりの無い期間は今まで(until を送らない)
    expect(params(auditApiQuery(f({ from: 1000 }), NOW))).toEqual({ since: "1000" });
    expect(params(withCursor(auditApiQuery(f(), NOW), "abc=="))).toEqual({ since: String(NOW - 30 * DAY), cursor: "abc==" });
  });

  it("who_filter_is_client_side", () => {
    const rows = [
      ev("3", 3, "member.role_change", { actor: { userId: "a", name: "田中 花子", email: "hanako@example.com" } }),
      ev("2", 2, "member.role_change", { actor: { userId: "b", name: "Jiro", email: null } }),
      ev("1", 1, "break_glass.reset_link", { actor: null, via: "break_glass" }),
    ];
    expect(filterByWho(rows, "")).toBe(rows);
    expect(filterByWho(rows, "  ")).toBe(rows);
    expect(filterByWho(rows, "HANAKO").map((e) => e.id)).toEqual(["3"]);
    expect(filterByWho(rows, "jiro").map((e) => e.id)).toEqual(["2"]);
    expect(filterByWho(rows, "花子").map((e) => e.id)).toEqual(["3"]);
    // 操作した人の無い行は、画面に出す名前(非常用トークン)で探せる
    expect(filterByWho(rows, "非常用").map((e) => e.id)).toEqual(["1"]);
  });
});

describe("date and time inputs", () => {
  it("converts between the local input value and epoch ms (minute precision, the end covers the whole minute)", () => {
    const at = new Date(2026, 9, 31, 8, 41, 30, 500).getTime();
    expect(toLocalInput(at)).toBe("2026-10-31T08:41");
    expect(fromLocalInput("2026-10-31T08:41")).toBe(new Date(2026, 9, 31, 8, 41).getTime());
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("nope")).toBeNull();
    const r = rangeFromInputs("2026-10-31T08:41", "2026-10-31T09:02");
    expect(r).toEqual({ ok: true, from: new Date(2026, 9, 31, 8, 41).getTime(), to: new Date(2026, 9, 31, 9, 2).getTime() + 59_999 });
    // 入れ直しても同じ値(終わりの分の最後の 1 ミリ秒まで)
    if (r.ok) expect(rangeFromInputs(toLocalInput(r.from), toLocalInput(r.to!))).toEqual(r);
    expect(rangeFromInputs("2026-10-31T08:41", "")).toEqual({ ok: true, from: new Date(2026, 9, 31, 8, 41).getTime(), to: null });
    expect(rangeFromInputs("", "2026-10-31T09:02")).toEqual({ ok: false, field: "from", error: "開始の日時を入れてください" });
    expect(rangeFromInputs("2026-10-31T09:02", "2026-10-31T08:41")).toEqual({ ok: false, field: "to", error: "終了は開始より後にしてください" });
  });
});

describe("break glass window (Q16)", () => {
  const reset = (id: string, at: number) => ev(id, at, "break_glass.reset_link", { actor: null, via: "break_glass" });
  const sweep = (id: string, at: number) => ev(id, at, "break_glass.sweep", { actor: null, via: "system" });

  it("guesses the first reset link to the next sweep of the latest opening", () => {
    // 新しい順で届く。前の開いた期間(10〜20)は見ない。今の開いた期間の最初の再設定リンク(30)〜次の掃除(50)
    const rows = [sweep("6", 50), reset("5", 40), reset("4", 30), sweep("3", 20), reset("2", 10)].concat([ev("1", 5, "member.role_change")]);
    expect(breakGlassWindowGuess(rows)).toEqual({ from: 30, to: 50 });
  });

  it("break_glass_window_start_empty_without_reset_link", () => {
    expect(breakGlassWindowGuess([sweep("2", 50), ev("1", 5, "invitation.accept")]).from).toBeNull();
    expect(breakGlassWindowGuess([])).toEqual({ from: null, to: null });
  });

  it("break_glass_window_end_empty_without_sweep", () => {
    // 掃除の記録が無い(まだ閉じていない・消す行が無かった)ときは終わりが空。前の掃除は終わりにしない
    expect(breakGlassWindowGuess([reset("3", 40), sweep("2", 20), reset("1", 10)])).toEqual({ from: 40, to: null });
  });

  it("break_glass_window_includes_accept_before_reset_link", () => {
    // 再設定リンクより前(非常口を開いた直後)に、Bearer 無しで招待を受けてアカウントを作った行。推定(40〜)には入らない
    const accept = ev("2", 25, "invitation.accept", { via: "password" });
    const rows = [sweep("4", 60), reset("3", 40), accept];
    expect(breakGlassWindowGuess(rows).from).toBe(40);
    // 操作する人が開いた時刻(secret を入れた時刻)を入れた期間は、推定に縛られずにそのまま API に渡る
    const human = f({ from: 20, to: 60 });
    expect(breakGlassWindowInitial(human, rows)).toEqual({ from: 20, to: 60 });
    const q = params(auditApiQuery(human, NOW));
    expect(Number(q.since)).toBeLessThanOrEqual(accept.at);
    expect(Number(q.until)).toBeGreaterThanOrEqual(accept.at);
    // 期間が URL に無ければ、初期値は推定
    expect(breakGlassWindowInitial(f(), rows)).toEqual({ from: 40, to: 60 });
  });
});

describe("range input names", () => {
  it("names the fields of the break glass window in the errors", () => {
    const names = { start: "開いた時刻", end: "閉じた時刻", unit: "" };
    expect(rangeFromInputs("", "", names)).toEqual({ ok: false, field: "from", error: "開いた時刻を入れてください" });
    expect(rangeFromInputs("2026-10-31T09:02", "2026-10-31T08:41", names)).toEqual({ ok: false, field: "to", error: "閉じた時刻は開いた時刻より後にしてください" });
  });
});

describe("load more", () => {
  it("appends the next page only to the table it was read for", async () => {
    const { appendAuditMore } = await import("@/components/audit/AuditLogPanel");
    const page = { events: [ev("2", 2, "member.remove")], nextCursor: "c1" };
    const ok = { kind: "ok" as const, query: "since=1", page, more: "loading" as const };
    const next = { events: [ev("1", 1, "member.remove")], nextCursor: null };
    expect(appendAuditMore(ok, "since=1", "c1", next)).toEqual({ kind: "ok", query: "since=1", page: { events: [...page.events, ...next.events], nextCursor: null }, more: "idle" });
    // 絞り込みを変えた後(引数が違う)・読み直した後(cursor が違う)に返った続きは捨てる
    expect(appendAuditMore(ok, "since=1&category=access", "c1", next)).toBe(ok);
    expect(appendAuditMore({ ...ok, page: { ...page, nextCursor: "c2" } }, "since=1", "c1", next).kind).toBe("ok");
    expect(appendAuditMore({ kind: "loading", query: "since=1" }, "since=1", "c1", next)).toEqual({ kind: "loading", query: "since=1" });
  });
});

// B129 final review: 表の上の案内と絞り込みの欄。非常口を閉じた後の確かめ方は、パスワードのログイン・非常口の行が入る導入全体の記録だけに出す
describe("audit log panel", () => {
  const renderPanel = async (scope: "workspace" | "instance") => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AuditLogPanel } = await import("@/components/audit/AuditLogPanel");
    return renderToStaticMarkup(
      createElement(AuditLogPanel, { scope, apiPath: "/x", initialFilter: DEFAULT_AUDIT_FILTER, initialQuery: "since=1", initialPage: { events: [ev("1", 1, "member.remove")], nextCursor: null } }),
    );
  };

  it("shows the after-break-glass check only on the instance log", async () => {
    const instance = await renderPanel("instance");
    expect(instance).toContain("非常口を閉じた後は");
    const workspace = await renderPanel("workspace");
    expect(workspace).not.toContain("非常口を閉じた後は");
    // ワークスペースの記録には入らない行(パスワードのログイン・非常口)の確かめ先を 1 行で案内する
    expect(workspace).toContain("導入全体の操作の記録");
    // 導入全体の記録の場所(設定のメニューの「システム」の見出しの下)も添える
    expect(workspace).toContain("「システム」の見出しの下");
  });

  it("uses the shared picker for the period and the kind, and scrolls the table sideways", async () => {
    const html = await renderPanel("workspace");
    expect(html).not.toContain("<select");
    expect(html).toContain('aria-label="期間"');
    expect(html).toContain('aria-label="種類"');
    expect(html).toContain('class="card-flush scroll-x"');
  });
});
