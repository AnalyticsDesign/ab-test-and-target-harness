import { test, expect, type Page } from "@playwright/test";
import { findVisitor, presetVisitor } from "./helpers";

// D9 ①(設計書 §3.2)の K1 の持ち越し: パーソナライズ S(並びで前)とテスト T(並びで後 = 優先が高い)が同じ #cta の文言を変える。
// S は #cta と .fixed の 2 つの変更を持つ。.fixed は後から付くので、再 scan で S の 2 つ目の変更が T の書いた要素に一致する

const COOKIE = "_wtto_vid";

async function addFixed(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById("cta")!.classList.add("fixed"));
}

test("test_variant_text_wins_over_personalization_even_after_late_match", async ({ context, page }) => {
  await presetVisitor(context, findVisitor("exp_order_t", "B"), { name: COOKIE });
  await page.goto("/order.html");
  await expect(page.locator("#cta")).toHaveText("T の文言");
  // 後から S の .fixed の変更にも一致する。並びで前の S は、並びで後の T が書いた部分(中身)を上書きしない
  await addFixed(page);
  await page.waitForTimeout(300);
  await expect(page.locator("#cta")).toHaveText("T の文言");
});

test("personalization_text_shows_when_test_variant_changes_nothing", async ({ context, page }) => {
  // 対照: T の A(変更なし)の訪問者には S が見え、.fixed の後の再 scan で S の 2 つ目の変更も効く(上のテストの再 scan が本当に起きることの証明)
  await presetVisitor(context, findVisitor("exp_order_t", "A"), { name: COOKIE });
  await page.goto("/order.html");
  await expect(page.locator("#cta")).toHaveText("S の文言");
  await addFixed(page);
  await expect(page.locator("#cta")).toHaveText("S の文言(fixed)");
});
