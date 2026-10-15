import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { bakeBootstrap, kvKeys, type CompiledConfig, type SiteSettings } from "@wtt/core";
import { PREVIEW_SOURCE, RUNTIME_SOURCE } from "@wtt/runtime/source";
import { readDataLayer } from "./helpers";

type ChangeReport = { changeId: string; type: string; selector?: string; matched: number; applied: boolean; error?: string };
type Report = { experimentId: string; variantId: string; changes: ChangeReport[]; error?: string };
const report = (page: Page) => page.evaluate(() => (window as unknown as { AB: { getPreviewReport(): Report[] | null } }).AB.getPreviewReport());

/** repo ルート(このファイルは packages/sample-site/e2e/ にある) */
const ROOT = new URL("../../../", import.meta.url);
/** control の `GET …/draft-bootstrap` が返すものと同じ形の JS(compile = pnpm fixture、bake = core の bakeBootstrap) */
let draftBootstrap = "";

test.beforeAll(() => {
  // `pnpm fixture <in> <out>`(--kv-bulk 無し)= compile するだけで KV には何も入れない = 未公開の下書き
  execFileSync("pnpm", ["fixture", "fixtures/e2e-draft.json", "apps/edge/.kv/e2e-draft-config.json"], {
    cwd: fileURLToPath(ROOT),
    stdio: "inherit",
  });
  const config = JSON.parse(readFileSync(new URL("apps/edge/.kv/e2e-draft-config.json", ROOT), "utf8")) as CompiledConfig;
  // settings は seed 済みの site_demo のものを流用する(`pnpm e2e` が edge:seed で必ず作る)
  const bulk = JSON.parse(readFileSync(new URL("apps/edge/.kv/demo-bulk.json", ROOT), "utf8")) as Array<{ key: string; value: string }>;
  const settings = JSON.parse(bulk.find((e) => e.key === kvKeys.settings("site_demo"))!.value) as SiteSettings;
  draftBootstrap = bakeBootstrap(config, settings, RUNTIME_SOURCE, { previewSource: PREVIEW_SOURCE }); // control の draft-bootstrap と同じ(決定 50)
});

test("preview_report_marks_unmatched_selector", async ({ context, page }) => {
  // spec §10.8 / §12.3 (a) / 決定 39 (4): 当たった selector と外れた selector を report で見分けられる
  const decisionCalls: string[] = [];
  page.on("request", (r) => {
    if (/\/v1\//.test(r.url())) decisionCalls.push(r.url());
  });
  await page.goto("/preview.html#__ab_preview=exp_preview:vB");
  await expect(page.locator(".preview-title")).toHaveText("プレビュー適用");

  const r = (await report(page))!;
  expect(r).toHaveLength(1);
  expect(r[0]!.experimentId).toBe("exp_preview");
  expect(r[0]!.variantId).toBe("vB");
  expect(r[0]!.changes).toEqual([
    { changeId: "c_hit", type: "TEXT", selector: ".preview-title", matched: 1, applied: true },
    { changeId: "c_miss", type: "TEXT", selector: ".no-such-title", matched: 0, applied: false },
    { changeId: "c_css", type: "CSS", matched: 1, applied: true },
  ]);

  // 完全隔離: 他の Experiment は動かない / Exposure なし / Cookie なし / decision 通信なし
  await expect(page.locator(".hero-title")).toHaveText("GA4を基礎から学ぶ");
  expect((await readDataLayer(page)).filter((e) => e.event === "ab_exposure")).toHaveLength(0);
  expect((await context.cookies()).find((c) => c.name === "_ab_vid")).toBeUndefined();
  expect(decisionCalls).toEqual([]);
  // CSS Change は preview でも注入される(見た目を本番と揃える)
  await expect(page.locator("style[data-ab-experiment='exp_preview'][data-ab-change='c_css']")).toHaveCount(1);
});

test("preview は未知の実験を報告し、通常表示では null を返す", async ({ context, page }) => {
  await page.goto("/preview.html#__ab_preview=exp_nope:vB");
  expect(await report(page)).toEqual([{ experimentId: "exp_nope", variantId: "vB", changes: [], error: "unknown experiment or variant" }]);
  expect((await context.cookies()).find((c) => c.name === "_ab_vid")).toBeUndefined();

  // 通常表示: getPreviewReport は null、Exposure は出て Cookie も作られる(本番経路は無傷)
  await page.goto("/preview.html");
  expect(await report(page)).toBeNull();
  await expect.poll(async () => (await readDataLayer(page)).some((e) => e.event === "ab_exposure")).toBe(true);
  await expect.poll(async () => (await context.cookies()).some((c) => c.name === "_ab_vid")).toBe(true);
});

test("preview_empty_hash_stays_isolated", async ({ context, page }) => {
  // 決定 39 (9): `#__ab_preview=`(空)でも隔離モードに入る(fail-closed)。何も適用せず、計測にも混ざらない
  await page.goto("/preview.html#__ab_preview=");
  expect(await report(page)).toEqual([{ experimentId: "", variantId: "", changes: [], error: "invalid preview request" }]);
  await expect(page.locator(".preview-title")).toHaveText("元の見出し");
  await expect(page.locator(".hero-title")).toHaveText("GA4を基礎から学ぶ"); // 公開中の実験も動かない
  await page.waitForLoadState("load");
  await page.waitForTimeout(500); // 通常経路なら Exposure と Cookie が出ているだけの時間を置く
  expect((await readDataLayer(page)).filter((e) => e.event === "ab_exposure")).toHaveLength(0);
  expect((await context.cookies()).find((c) => c.name === "_ab_vid")).toBeUndefined();
});

test("draft_bootstrap_injection_wins_over_installed_tag", async ({ context, page }) => {
  // §13.10 レシピ 2: 設置タグ(/s/site_demo.js)のあるページに、未公開の下書きの bootstrap を addInitScript で注入する。
  // addInitScript はページのどのスクリプトよりも先に走るので、下書きが先に起動し、後から走る設置タグは no-op になる
  expect(draftBootstrap).toContain("exp_injected");
  await page.addInitScript({ content: draftBootstrap });
  await page.goto("/preview.html#__ab_preview=exp_injected:vB");

  // 下書きの Change が当たっている(edge が配る config には exp_injected は存在しない)
  await expect(page.locator(".preview-title")).toHaveText("下書きの見出し");
  const r = (await report(page))!;
  expect(r).toHaveLength(1);
  expect(r[0]!.experimentId).toBe("exp_injected");
  expect(r[0]!.changes).toEqual([{ changeId: "c_draft", type: "TEXT", selector: ".preview-title", matched: 1, applied: true }]);

  // 隔離も維持: 公開中の exp_hero / exp_preview は動かず、Exposure も Cookie も出ない
  await expect(page.locator(".hero-title")).toHaveText("GA4を基礎から学ぶ");
  expect((await readDataLayer(page)).filter((e) => e.event === "ab_exposure")).toHaveLength(0);
  expect((await context.cookies()).find((c) => c.name === "_ab_vid")).toBeUndefined();

  // ページ読込(設置タグの実行)が終わった後も維持される = 二重起動が下書きを上書きしない
  await page.waitForLoadState("load");
  await page.waitForTimeout(500);
  await expect(page.locator(".preview-title")).toHaveText("下書きの見出し");
  expect((await report(page))![0]!.changes[0]).toMatchObject({ matched: 1, applied: true });
  expect((await readDataLayer(page)).filter((e) => e.event === "ab_exposure")).toHaveLength(0);
});

test("draft_bootstrap_preserves_page_csp_nonce", async ({ context, page }) => {
  // CX-High-6: nonce + 'strict-dynamic' の CSP ページ(/code-csp.html)に下書きを注入しても、
  // 設置タグが残した nonce(__WTT_NONCE__)を引き継いで CSS / HTML の <script> / CUSTOM_JS が適用される
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations?: number };
    w.__cspViolations = 0;
    document.addEventListener("securitypolicyviolation", () => {
      w.__cspViolations = (w.__cspViolations ?? 0) + 1;
    });
  });
  await page.addInitScript({ content: draftBootstrap });
  const cspHeader = page.waitForResponse((r) => r.url().endsWith("/code-csp.html"));
  await page.goto("/code-csp.html#__ab_preview=exp_injected_csp:vB");
  expect((await cspHeader).headers()["content-security-policy"]).toContain("'strict-dynamic'"); // ヘッダが効いている

  // CSS(style-src 'nonce-…')・HTML runScripts・CUSTOM_JS のすべてが適用される = nonce を引き継げている
  await expect(page.locator(".code-title")).toHaveCSS("letter-spacing", "4px");
  await expect(page.locator(".code-title")).toHaveAttribute("data-draft-ctx", "exp_injected_csp/vB/c_draft_js");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __wttDraftScript?: number }).__wttDraftScript ?? 0))
    .toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __cspViolations?: number }).__cspViolations)).toBe(0);

  const r = (await report(page))!;
  expect(r).toHaveLength(1);
  expect(r[0]!.changes.map((c) => [c.changeId, c.applied, c.error])).toEqual([
    ["c_draft_css", true, undefined],
    ["c_draft_html", true, undefined],
    ["c_draft_js", true, undefined],
  ]);

  // 隔離は維持: 公開中の実験は動かず、Exposure も Cookie も出ない
  expect((await readDataLayer(page)).filter((e) => e.event === "ab_exposure")).toHaveLength(0);
  expect((await context.cookies()).find((c) => c.name === "_ab_vid")).toBeUndefined();
});
