import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsagePanel } from "@/components/usage/UsagePanel";
import type { UsageSettings } from "@/lib/types";

// SSR の表示だけを確かめるので、保存後にルーターを呼ぶ hook は差し替える。
vi.mock("@/lib/use-refresh-and-wait", () => ({ useRefreshAndWait: () => async () => "done" }));

const render = (cloudflarePlan: UsageSettings["cloudflarePlan"], showPaidReference: boolean) => renderToStaticMarkup(createElement(UsagePanel, {
  settings: { usageVisibility: "members", cloudflarePlan, showPaidReference },
  usage: { ok: false, title: "使用状況を取得できませんでした", hint: "時間をおいて開き直してください" },
  controlCapacity: undefined,
}));

describe("使用状況の Paid の比較", () => {
  it.each([true, false])("Free では保存値が %s でも比較の欄を見出しごと出さない", (checked) => {
    const html = render("free", checked);
    expect(html).not.toContain("Paid の比較");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Free は日次の上限を表示します");
    expect(html).toContain("Cloudflare のプラン");
  });

  it.each([true, false])("Paid では比較を使え、保存値 %s を表示する", (checked) => {
    const html = render("paid", checked);
    expect(html).toContain("<legend>Paid の比較</legend>");
    expect(html).toContain("月額 $5 に含まれる量と比べる");
    const input = html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).not.toContain("disabled");
    expect(input!.includes('checked=""')).toBe(checked);
  });
});
