import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYTICS } from "@wtt/core";

// AppLink は app router を要るので、静的な描画ではただの a に替える(history-tab.test.ts と同じ)
vi.mock("@/components/ui/AppLink", () => ({ AppLink: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children) }));
const { OverviewTab } = await import("@/components/experiment/OverviewTab");
const { PersistFold } = await import("@/components/experiment/PersistFold");
const { DeliverySummary } = await import("@/components/experiment/DeliverySummary");
const { ExperimentTargeting } = await import("@/components/targeting/ExperimentTargeting");
import type { Draft } from "@/lib/experiment-draft";
import { PERSIST_HINT } from "@/lib/test-locks";
import { experimentFormFromDsl } from "@/lib/targeting-tree";
import type { UrlMatchValue } from "@/lib/url-match";
import type { Experiment } from "@/lib/types";

/** B69 Task 7(spec §7.1・§7.5): 基本設定のタブのカード(基本・配信条件・外部計測)、配信条件の 3 段、割当の固定の畳んだ行、要約の 1 文、使えなくなった条件の行 */
const URL_MATCH: UrlMatchValue = { include: [{ page: { part: "path", op: "startsWith", value: "/lp/" } }] };
const draft = (over: Partial<Draft> = {}): Draft => ({
  name: "春の LP",
  description: "メモの本文",
  urlMatch: URL_MATCH,
  targeting: { kind: "form", form: { logic: "and", rows: [] } },
  traffic: 100,
  persist: false,
  expName: "",
  extra: {},
  variants: [],
  ...over,
});
const renderTab = (d: Draft, lock: Pick<Experiment, "kind" | "status" | "trafficPercentage"> = { kind: "test", status: "draft", trafficPercentage: 100 }) =>
  renderToStaticMarkup(
    createElement(OverviewTab, {
      draft: d,
      set: () => {},
      ro: false,
      memoRo: false,
      goals: [],
      audiences: [],
      site: { retentionDays: 30, timezone: "Asia/Tokyo", analytics: DEFAULT_ANALYTICS },
      experimentId: "exp_x",
      saved: d,
      saveTried: false,
      analyticsOpen: false,
      onAnalyticsOpen: () => {},
      lock,
      goalsHref: "/goals",
      trafficSent: false,
    }),
  );
/** `<section aria-label="X">` の中身(入れ子の section は無い前提) */
const section = (html: string, label: string): string => {
  const start = html.indexOf(`<section class="card" aria-label="${label}">`);
  expect(start, `section ${label}`).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</section>", start));
};
const at = (html: string, s: string) => {
  const i = html.indexOf(s);
  expect(i, s).toBeGreaterThanOrEqual(0);
  return i;
};

describe("OverviewTab(B69 spec §7.1)", () => {
  it("overview_two_cards: 基本・配信条件の 2 枚のカードに h2、配信条件は ① ② ③ の段と最後の要約、3 枚目が外部計測", () => {
    const html = renderTab(draft());
    const basic = section(html, "基本");
    expect(basic).toContain("<h2>基本</h2>");
    expect(basic).toContain("名前(100 字以内)");
    expect(basic).toContain("メモの本文");
    expect(basic).not.toContain("対象 URL");
    const delivery = section(html, "配信条件");
    expect(delivery).toContain("<h2>配信条件</h2>");
    const s1 = at(delivery, "どのページで");
    const s2 = at(delivery, "どの訪問者に");
    const s3 = at(delivery, "そのうち何 % に");
    const sum = at(delivery, "配信する相手: ");
    expect(s1).toBeLessThan(s2);
    expect(s2).toBeLessThan(s3);
    expect(s3).toBeLessThan(sum);
    // 要約は最後の 1 文だけ。②の段に「配信する訪問者」の行は出さない(Q358)
    expect(delivery).toContain('data-testid="delivery-summary"');
    expect(delivery).not.toContain("targeting-summary");
    expect(delivery).not.toContain("配信する訪問者");
    // 小見出しは h3、補足はモックの案 C の文言
    expect(delivery.match(/<h3\b/g)?.length).toBe(3);
    expect(delivery).toContain("対象 URL");
    expect(delivery).toContain("このエクスペリエンスを動かすページ。ページの URL・ホスト・パス・パラメータの条件はここだけで指定します");
    expect(delivery).toContain("訪問者の条件。無ければ全員");
    expect(delivery).toContain("配信率");
    // 段の中身の順: 対象 URL の入力 → 配信条件 → 配信率 → 割当の固定
    expect(at(delivery, "+ 含めるページ")).toBeGreaterThan(s1);
    expect(at(delivery, "+ 含めるページ")).toBeLessThan(s2);
    expect(at(delivery, "次の条件を")).toBeGreaterThan(s2);
    expect(at(delivery, "配信率(1〜100%")).toBeGreaterThan(s3);
    expect(at(delivery, "割当の固定: ")).toBeGreaterThan(s3);
    // 外部計測は 3 枚目(配信条件のカードの後)
    expect(at(html, "外部計測")).toBeGreaterThan(at(html, 'aria-label="配信条件"'));
    // 補足の文は選べる条件の説明(対象 URL の中を絞る、という古い説明は出さない)
    expect(delivery).not.toContain("ページの条件は、対象 URL に一致したページの中をさらに絞るときに使います");
    expect(delivery).toContain("「+ 条件」で選べるもの: 端末・画面の幅・ブラウザ・OS・リファラー・曜日と時間帯・閲覧したページ・目標の達成・初回の訪問からの経過");
  });
  it("overview_only_summary_sentence: 訪問者の条件があっても、②の段に要約の行は無く、最後の 1 文に条件が入る(Q358)", () => {
    const form = experimentFormFromDsl({ ctx: "device", op: "in", value: ["mobile"] });
    const delivery = section(renderTab(draft({ targeting: { kind: "form", form: form! } })), "配信条件");
    expect(delivery).not.toContain("targeting-summary");
    expect(delivery).not.toContain("配信する訪問者");
    expect(delivery).toContain('data-testid="targeting-json"');
    expect(delivery.match(/data-testid="delivery-summary"/g)?.length).toBe(1);
    expect(delivery.replace(/<[^>]+>/g, "")).toContain("端末が モバイル の訪問者のうち 100%");
  });
  it("実行中のテスト: 配信率の欄のロックの補足はそのまま、割当の固定の行は開いてロックの文言を出す", () => {
    const html = renderTab(draft({ traffic: 50 }), { kind: "test", status: "running", trafficPercentage: 50 });
    expect(html).toContain("テストの開始後は、今の値(50%)より上げることだけができます");
    expect(html).toMatch(/<details[^>]*open=""[^>]*>\s*<summary>割当の固定: /);
  });
});

describe("PersistFold", () => {
  const render = (p: { checked: boolean; disabled?: boolean; lockMessage?: string | null }) =>
    renderToStaticMarkup(createElement(PersistFold, { checked: p.checked, disabled: p.disabled ?? false, lockMessage: p.lockMessage ?? null, onChange: () => {} }));
  it("persist_fold: 畳んだ行に今の値と「配信率を後から下げるときの設定」、開くとチェックボックスと PERSIST_HINT", () => {
    const off = render({ checked: false });
    expect(off.replace(/<[^>]+>/g, "")).toContain("割当の固定: オフ — 配信率を後から下げるときの設定");
    expect(off).not.toMatch(/<details[^>]*open=""/);
    expect(off).toContain(PERSIST_HINT);
    expect(off).toMatch(/<input type="checkbox"/);
    const on = render({ checked: true });
    expect(on.replace(/<[^>]+>/g, "")).toContain("割当の固定: オン — 配信率を後から下げるときの設定");
    expect(on).toMatch(/<input type="checkbox"[^>]*checked=""/);
  });
  it("lockMessage があるときは開いた状態で、ロックの文言を出し、チェックボックスは押せない", () => {
    const html = render({ checked: false, disabled: true, lockMessage: "テストの開始後は変えられません" });
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).toContain("テストの開始後は変えられません");
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""/);
  });
});

describe("DeliverySummary", () => {
  const text = (p: { urlMatch?: UrlMatchValue; targetingText?: string; traffic?: number; persist?: boolean }) =>
    renderToStaticMarkup(
      createElement(DeliverySummary, { urlMatch: p.urlMatch ?? URL_MATCH, targetingText: p.targetingText ?? "", traffic: p.traffic ?? 100, persist: p.persist ?? false }),
    ).replace(/<[^>]+>/g, "");
  it("delivery_summary_text: 含めるの行 → ページを開いた → 訪問者の条件 → 配信率", () => {
    expect(text({ targetingText: "端末 が モバイル のいずれか" })).toBe("配信する相手: パス が「/lp/」で始まる のページを開いた、端末 が モバイル のいずれか の訪問者のうち 100%");
    // 条件が無ければすべての訪問者
    expect(text({ traffic: 30 })).toBe("配信する相手: パス が「/lp/」で始まる のページを開いた、すべての訪問者のうち 30%");
    // 含めるの複数行は「または」、除くは「ただし … を除く」、割当の固定は「(割当を固定)」
    const m: UrlMatchValue = {
      include: [{ page: { part: "path", op: "startsWith", value: "/a/" } }, { page: { part: "path", op: "startsWith", value: "/b/" } }],
      exclude: [{ page: { part: "path", op: "contains", value: "/old/" } }],
    };
    expect(text({ urlMatch: m, persist: true })).toBe(
      "配信する相手: パス が「/a/」で始まる または パス が「/b/」で始まる(ただし パス が「/old/」を含む を除く)のページを開いた、すべての訪問者のうち 100%(割当を固定)",
    );
  });
});

describe("使えなくなった条件の行(spec §7.5)", () => {
  const PATH = { ctx: "path", op: "startsWith", value: "/lp/" };
  it("legacy_row_renders: 配信条件に古いページの条件があると警告の行が出る(英語の識別子は出さない)", () => {
    const form = experimentFormFromDsl({ and: [{ ctx: "device", op: "in", value: ["mobile"] }, PATH] });
    expect(form?.rows[1]?.type).toBe("legacy");
    const html = renderToStaticMarkup(createElement(ExperimentTargeting, { value: { kind: "form", form: form! }, onChange: () => {}, ctx: { goals: [], goalsHref: "/goals", audiences: [], retentionDays: 30, timezone: "Asia/Tokyo", disabled: false } }));
    expect(html).toContain("この条件は配信条件では使えなくなりました");
    expect(html).toContain("ページのパス が「/lp/」で始まる");
    expect(html).toContain("ページの URL・ホスト・パス・パラメータの条件は、上の「どのページで(対象 URL)」で指定します。対象 URL に移してから、この条件を消してください。このままでは保存できません");
    expect(html).toContain(">この条件を消す</button>");
    expect(html).not.toMatch(/legacy/i);
    // 配信条件の画面全体(基本設定のタブ)でも落ちない
    const tab = renderTab(draft({ targeting: { kind: "form", form: form! } }));
    expect(tab).toContain("この条件は配信条件では使えなくなりました");
    expect(tab).not.toMatch(/legacy/i);
  });
});
