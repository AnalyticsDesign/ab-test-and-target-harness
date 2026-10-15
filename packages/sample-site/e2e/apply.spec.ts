import { test, expect } from "@playwright/test";
import { findVisitor, presetVisitor, readDataLayer } from "./helpers";

test("mode A secure cookie works on http://localhost (smoke — 落ちたら環境要因を先に疑う)", async ({ context, page }) => {
  // Secure 属性付き document.cookie 書込が localhost(trustworthy origin)で有効なことの canary。
  // ここが落ちる場合は runtime ではなく、プロキシ / seed / ブラウザの Secure Cookie 制約を先に切り分ける
  await page.goto("/");
  await expect.poll(async () => (await context.cookies()).some((c) => c.name === "_ab_vid")).toBe(true);
});

test("vB visitor sees replaced copy, hidden banner, swapped CTA and image (real runtime)", async ({ context, page }) => {
  await presetVisitor(context, findVisitor("exp_hero", "B"));
  await page.goto("/");
  await expect(page.locator(".hero-title")).toHaveText("1日でGA4を「分かる」に変える");
  await expect(page.locator(".old-banner")).toBeHidden();
  await expect(page.locator("a.cta")).toHaveAttribute("href", "/lp2/");
  await expect(page.locator(".hero-img")).toHaveAttribute("src", "https://placehold.co/600x200.png");
  await expect(page.locator(".hero-img")).not.toHaveAttribute("srcset", /./);
  await expect(page.locator(".injected")).toHaveCount(1); // HTML Change(append、runScripts false)
  await expect(page.locator(".hero-title")).toHaveAttribute("data-wtt", "b"); // CUSTOM_JS(c_js)
  await expect(page.locator("style[data-ab-experiment='exp_hero'][data-ab-change='c_css']")).toHaveCount(1); // CSS
});

test("vA visitor sees the original copy", async ({ context, page }) => {
  await presetVisitor(context, findVisitor("exp_hero", "A"));
  await page.goto("/");
  await expect(page.locator(".hero-title")).toHaveText("GA4を基礎から学ぶ");
  await expect(page.locator(".old-banner")).toBeVisible();
});

test("runtime_unknown_schema_applies_nothing", async ({ context, page }) => {
  // §18.1「config version 拒否」名の runtime 半分(edge 側の同名 it は Plan 2 済。§18.1 名の文字列はコメントに書かない)。
  // edge は未知 schemaVersion を配信しない(fail-closed)ため、配信路上の改竄として bootstrap 応答を書き換えて注入する
  await presetVisitor(context, findVisitor("exp_hero", "B"));
  await page.route("**/s/site_demo.js", async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('"schemaVersion":2', '"schemaVersion":3');
    await route.fulfill({ response: res, body });
  });
  await page.goto("/");
  await page.waitForTimeout(300);
  await expect(page.locator(".hero-title")).toHaveText("GA4を基礎から学ぶ");
  expect(await readDataLayer(page)).toEqual([]);
});

test("control_variant_exposes_when_sibling_selector_present", async ({ context, page }) => {
  // vA(対照、Change なし)でも exposureSelectors(.hero-title = vB の Change セレクタ)が DOM にあれば 1 回だけ Exposure(spec §10.5)
  await presetVisitor(context, findVisitor("exp_hero", "A"));
  await page.goto("/");
  await expect.poll(async () => (await readDataLayer(page)).filter((e) => e.event === "ab_exposure" && e.ab_experiment_id === "exp_hero")).toEqual([
    { event: "ab_exposure", ab_experiment_id: "exp_hero", ab_experiment_name: "Hero copy", ab_variant_id: "vA", ab_variant_name: "A", ab_extra: null },
  ]);
});

test("no_exposure_when_no_selector_in_dom", async ({ context, page }) => {
  // exp_ghost のセレクタ .ghost-missing はページに存在しない → vA/vB どちらでも Exposure なし(assignment はある)(spec §10.5)
  await presetVisitor(context, findVisitor("exp_hero", "B"));
  await page.goto("/");
  await expect(page.locator(".hero-title")).toHaveText("1日でGA4を「分かる」に変える"); // 適用完了まで待つ
  await page.waitForTimeout(200);
  const exposures = (await readDataLayer(page)).filter((e) => e.event === "ab_exposure");
  expect(exposures.map((e) => e.ab_experiment_id)).toEqual(["exp_hero"]); // exp_ghost は含まれない
  expect(await page.evaluate(() => (window as unknown as { AB: { getAssignments(): Record<string, string> } }).AB.getAssignments())).toHaveProperty("exp_ghost");
});

test("multiple_changes_on_same_element_apply_once_each", async ({ context, page }) => {
  // .hero-title には c_text(TEXT)と c_mark(ATTRIBUTE)の 2 Change。各 1 回だけ適用される(spec §10.4 WeakMap 管理)
  await presetVisitor(context, findVisitor("exp_hero", "B"));
  await page.addInitScript(() => {
    const w = window as unknown as { __markMutations: number };
    w.__markMutations = 0;
    new MutationObserver((records) => {
      for (const r of records) if (r.type === "attributes" && r.attributeName === "data-wtt-mark") w.__markMutations++;
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-wtt-mark"] }); // init script 時点で documentElement 未生成でも安全なよう document を観察する
  });
  await page.goto("/");
  await expect(page.locator(".hero-title")).toHaveText("1日でGA4を「分かる」に変える");
  await expect(page.locator(".hero-title")).toHaveAttribute("data-wtt-mark", "1");
  await page.waitForTimeout(300); // observer の再スキャンが走っても再適用されないことを見る
  expect(await page.evaluate(() => (window as unknown as { __markMutations: number }).__markMutations)).toBe(1);
});

test("spa_replacement_reapplies_dom_changes_only", async ({ context, page }) => {
  // SPA の再レンダリング(template から原状復元)後、DOM 部分のみ再適用。Exposure は増えない(spec §10.4 / §10.5)
  await presetVisitor(context, findVisitor("exp_hero", "B"));
  await page.goto("/");
  await expect(page.locator(".hero-title")).toHaveText("1日でGA4を「分かる」に変える");
  await page.click("#rerender");
  await expect(page.locator(".hero-title")).toHaveText("1日でGA4を「分かる」に変える"); // 新要素に再適用
  await expect(page.locator(".old-banner")).toBeHidden();
  await expect(page.locator("a.cta")).toHaveAttribute("href", "/lp2/");
  // 全 Change type の再適用を見る(spec §18: IMAGE も対象。r1 CX-Medium-6)
  await expect(page.locator(".hero-img")).toHaveAttribute("src", "https://placehold.co/600x200.png");
  await expect(page.locator(".hero-img")).not.toHaveAttribute("srcset", /./);
  await expect(page.locator(".extra .injected")).toHaveCount(1); // HTML も新要素に再適用(spec §10.4)
  const exposures = (await readDataLayer(page)).filter((e) => e.event === "ab_exposure" && e.ab_experiment_id === "exp_hero");
  expect(exposures).toHaveLength(1); // 再適用で Exposure は二重計上しない
});
