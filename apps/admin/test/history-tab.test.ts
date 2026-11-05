import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AuditEventView, AuditPerson } from "@/lib/audit-labels";

// AppLink はルーターの文脈を要る(ここでは表の文と行の形だけを見る)
vi.mock("@/components/ui/AppLink", () => ({ AppLink: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }));
const { HistoryTab, HistoryTable, appendMore } = await import("@/components/experiment/HistoryTab");

/** B129(spec §7.1): エクスペリエンスの「変更履歴」のタブの表(読み込みの状態を持たない部分) */
const person = (name: string | null, email: string | null = null): AuditPerson => ({ userId: "u", name, email });
const row = (id: string, action: string, detail: Record<string, unknown> = {}, over: Partial<AuditEventView> = {}): AuditEventView => ({
  id,
  at: 1_730_000_000_000,
  category: "content",
  action,
  workspaceId: "w",
  siteId: "s",
  experimentId: "e",
  via: "google",
  actor: { userId: "u", name: "田中 花子", email: null },
  apiKey: null,
  target: { type: "experiment", id: "e", label: "Hero" },
  detail,
  ...over,
});
const render = (events: AuditEventView[], over: { nextCursor?: string | null; createdBy?: AuditPerson; onMore?: () => void } = {}) =>
  renderToStaticMarkup(
    createElement(HistoryTable, {
      page: { events, nextCursor: over.nextCursor ?? null, createdBy: over.createdBy ?? person("作った人"), updatedBy: person("変えた人") },
      publishHistoryHref: "/w/w/sites/s/history",
      createdAt: 1_700_000_000_000,
      variantNames: { v_b: "B" },
      onMore: over.onMore,
    }),
  );

describe("experiment history table", () => {
  // B129 final review: 読み込み中の文は読み上げに伝える。表は狭い幅で横に送る(切れない)
  it("announces loading and scrolls the table sideways on a narrow screen", () => {
    const loading = renderToStaticMarkup(
      createElement(HistoryTab, { siteId: "s", experimentId: "e", publishHistoryHref: "/h", createdAt: 0, variantNames: {}, reloadKey: "0" }),
    );
    expect(loading).toContain('role="status"');
    expect(loading).toContain("変更履歴を読み込んでいます");
    expect(render([])).toContain('class="card-flush scroll-x"');
  });

  it("keeps the table and shows one line when there is nothing yet (admin_ui_rules 3.3)", () => {
    const html = render([]);
    expect(html).toContain("<table");
    expect(html).toContain("まだ変更の記録はありません");
    // 記録を始める前に作られた(作成の行が無い)ときは、作った人と最後に変えた人を出す(D4)
    expect(html).toContain("作成: 作った人");
    expect(html).toContain("最後に変えた人: 変えた人");
  });

  it("states that change contents are not kept, with a link to the publish history", () => {
    const html = render([]);
    expect(html).toContain("変更の中身(HTML・CSS・JS)の違いは残りません");
    expect(html).toContain('href="/w/w/sites/s/history"');
  });

  it("shows the email only when the response carries it, and the password login in the warning tone", () => {
    const html = render([
      row("2", "experiment.status", { from: "running", to: "paused" }, { via: "password", actor: { userId: "u", name: "田中 花子", email: "hanako@example.com" } }),
      row("1", "experiment.create", { kind: "test" }),
    ]);
    expect(html).toContain("hanako@example.com");
    expect(html).toContain('<span class="badge badge-warn">パスワード</span>');
    expect(html).toContain("配信中 → 一時停止");
    // 作成の行があれば、その人と日付
    expect(html).toContain("作成: 田中 花子");
    expect(html).not.toContain("最後に変えた人");
    expect(render([row("1", "experiment.status", {}, { actor: { userId: "u", name: "閲覧者向け", email: null } })])).not.toContain("@");
  });

  it("offers the next 100 only while there is more, and does not claim the creation before the last page", () => {
    const more = render([row("3", "experiment.update", { fields: [] })], { nextCursor: "abc", onMore: () => {} });
    expect(more).toContain("さらに 100 件を読み込む");
    expect(more).toContain("1 件以上");
    expect(more).not.toContain("作成:");
    expect(render([row("3", "experiment.update", { fields: [] })])).not.toContain("さらに 100 件を読み込む");
  });

  it("names the adopted variant from the variants the screen knows", () => {
    expect(render([row("1", "experiment.adoption", { variant: "v_b" })])).toContain("採用 B");
  });
});

describe("appendMore", () => {
  const page = (ids: string[], nextCursor: string | null) => ({ events: ids.map((id) => row(id, "experiment.update", { fields: [] })), nextCursor, createdBy: person("a"), updatedBy: person("b") });

  it("appends the next page when it continues the table", () => {
    const next = appendMore({ kind: "ok", page: page(["3", "2"], "c1"), more: "loading" }, "c1", { events: [row("1", "experiment.create")], nextCursor: null });
    expect(next.kind === "ok" && next.page.events.map((e) => e.id)).toEqual(["3", "2", "1"]);
    expect(next.kind === "ok" && next.more).toBe("idle");
  });

  it("drops a continuation read with an old cursor after the reload replaced the first page (no missing row at the seam)", () => {
    // 保存の後の読み直しが先に返り、表は新しい 1 ページ目(続きは c2)。古いカーソル c1 の続きは足さない
    const reloaded = { kind: "ok" as const, page: page(["4", "3"], "c2"), more: "idle" as const };
    expect(appendMore(reloaded, "c1", { events: [row("1", "experiment.create")], nextCursor: null })).toBe(reloaded);
  });
});
