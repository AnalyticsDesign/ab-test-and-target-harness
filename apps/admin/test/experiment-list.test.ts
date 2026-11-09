import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExperimentList } from "@/components/ExperimentList";
import { DEFAULT_STATUS_FILTER, FILTER_JA, STATUS_FILTERS, type StatusFilter } from "@/lib/experiment-filter";
import type { Experiment, Status } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));

const exp = (status: Status): Experiment => ({
  id: status, name: `一覧の ${status}`, kind: "test", status, publishedStatus: status,
  urlMatch: { include: [{ page: { part: "path", op: "startsWith", value: "/" } }] }, trafficPercentage: 100,
  siteId: "s", targeting: null, persistAssignment: false, analytics: null,
  createdBy: "u", updatedBy: "u", createdAt: 0, updatedAt: 0, unpublished: false, description: "", runId: null,
});
const LIST = (["draft", "running", "paused", "archived"] as const).map(exp);
const render = (experiments = LIST, initialFilter: StatusFilter = DEFAULT_STATUS_FILTER) => renderToStaticMarkup(createElement(ExperimentList, {
  wid: "w", sid: "s", experiments, canPublish: true, initialFilter,
}));

describe("エクスペリエンス一覧の状態の絞り込み", () => {
  it("終了以外を選び、6 項目の文言・件数を単一選択で出す", () => {
    const html = render();
    expect(html).toContain('aria-label="状態で絞り込む"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    const buttons = [...html.matchAll(/<button\b[^>]*data-testid="filter-([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
    expect(buttons.map((m) => m[1])).toEqual(STATUS_FILTERS);
    for (const button of buttons) {
      expect(button[2]).toContain(FILTER_JA[button[1] as StatusFilter]);
      expect(button[0]).not.toContain("style=");
    }
    expect(buttons[0]![0]).toContain('aria-pressed="true"');
    expect(buttons[0]![2]).toMatch(/>3<\/span>/);
    expect(buttons[1]![2]).toMatch(/>4<\/span>/);
    for (const status of ["draft", "running", "paused"]) expect(html).toContain(`data-testid="experiment-row-${status}"`);
    expect(html).not.toContain('data-testid="experiment-row-archived"');
  });
  it("明示した「すべて」では終了も出す", () => {
    const html = render(LIST, "all");
    expect(html).toContain('data-testid="experiment-row-archived"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="filter-all"/);
  });
  it("終了だけなら絞り込みと空の結果を出し、全件 0 の導入案内とは区別する", () => {
    const ended = render([exp("archived")]);
    expect(ended).toContain('data-testid="filter-all"');
    expect(ended).toContain("この状態のエクスペリエンスはありません");
    expect(ended).not.toContain("エクスペリエンスはまだありません");
    const empty = render([]);
    expect(empty).toContain("エクスペリエンスはまだありません");
    expect(empty).toContain('data-testid="empty-install-tag"');
    expect(empty).not.toContain('data-testid="filter-all"');
  });
});
