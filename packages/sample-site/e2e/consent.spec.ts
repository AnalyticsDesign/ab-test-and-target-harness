import { test, expect, type Page } from "@playwright/test";
import { deriveExternalUuid } from "@wtt/core";
import { readFileSync } from "node:fs";
import { readDataLayer } from "./helpers";

function trackEdgeRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (req) => {
    if (/\/(v1|__ab)\//.test(req.url())) urls.push(req.url());
  });
  return urls;
}

async function grant(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { AB: { consent(g: boolean): void } }).AB.consent(true));
}
async function revoke(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { AB: { consent(g: boolean): void } }).AB.consent(false));
}
async function cookieValue(context: import("@playwright/test").BrowserContext, name: string): Promise<string | undefined> {
  return (await context.cookies()).find((c) => c.name === name)?.value;
}

test("no_cookie_or_network_before_consent", async ({ context, page }) => {
  // spec §16: required + 事前状態なし = pending。Cookie 発行なし・prehide なし(元表示のまま)。
  // exp_consent は needsProfile: false(ターゲティングなし・persistAssignment: false)なので、
  // 下の requests アサーションは常にローカル評価で決まる zero-request 特性を固定するだけで、
  // consent gate 自体の discriminating な証明にはならない(needsProfile: false だと Mode A は
  // そもそも decision エンドポイントを呼ばない)。consent gate 本体は Task 7 の consent gate
  // unit テスト(fetch spy で pending 中ゼロ回・grant 後 1 回を固定)が証明する。
  const requests = trackEdgeRequests(page); // /v1 と /__ab のみ収集(/s/ の script 読込は対象外)
  await page.goto("/consent.html");
  await page.waitForTimeout(400);
  expect(await context.cookies()).toEqual([]);
  expect(requests).toEqual([]);
  await expect(page.locator(".hero-title")).toHaveText("GA4を基礎から学ぶ");
  await expect(page.locator(".hero-title")).toHaveCSS("opacity", "1"); // prehide なし
  expect(await readDataLayer(page)).toEqual([]);
  // grant で通常起動する(gate が本物であることの対照)
  await grant(page);
  await expect(page.locator(".hero-title")).toHaveText("同意後のコピー");
  await expect.poll(() => cookieValue(context, "_ab_vid")).toBeTruthy();
  expect(requests).toEqual([]); // spec §7.1: Mode A + needsProfile: false はローカル評価のみで decision を送らない(実配信路上の zero-request 特性)
});

test("mode_a_sets_derived_uuid_cookie_with_matching_attributes", async ({ context, page }) => {
  // spec §5.4 / 決定 49 §7.2: UUID Cookie は正本から導出した UUIDv4 で、Path / Max-Age / Secure / SameSite が正本と同一、HttpOnly なし
  await page.goto("/consent.html");
  await grant(page);
  await expect.poll(() => cookieValue(context, "_ab_uuid")).toBeTruthy();
  const cookies = await context.cookies();
  const vid = cookies.find((c) => c.name === "_ab_vid")!;
  const uuid = cookies.find((c) => c.name === "_ab_uuid")!;
  const salt = (JSON.parse(readFileSync(new URL("../../../fixtures/e2e-consent.json", import.meta.url), "utf8")) as { siteSalt: string }).siteSalt;
  expect(uuid.value).toBe(await deriveExternalUuid(salt, vid.value));
  for (const c of [vid, uuid]) {
    expect(c.path).toBe("/");
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe("Lax");
    expect(c.httpOnly).toBe(false); // JS 発行の Cookie に HttpOnly は付かない(D-lite の正本のみ HttpOnly)
    expect(c.expires).toBeGreaterThan(Date.now() / 1000 + 360 * 24 * 3600); // Max-Age ≒ 1 年
  }
});

test("revoke_removes_configured_canonical_and_uuid_cookies", async ({ context, page }) => {
  // spec §16: denied への遷移で、設定された正本 Cookie と UUID Cookie の両方を削除する
  await page.goto("/consent.html");
  await grant(page);
  await expect.poll(() => cookieValue(context, "_ab_uuid")).toBeTruthy();
  await revoke(page);
  await expect.poll(async () => (await context.cookies()).filter((c) => c.name === "_ab_vid" || c.name === "_ab_uuid")).toEqual([]);
});

test("revoke_stops_updates_and_removes_mode_a_cookie", async ({ context, page }) => {
  // spec §16: denied の間は更新停止(SPA 再レンダリングにも再適用しない)+ Mode A Cookie 削除
  await page.goto("/consent.html");
  await grant(page);
  await expect(page.locator(".hero-title")).toHaveText("同意後のコピー");
  await revoke(page);
  await expect.poll(() => cookieValue(context, "_ab_vid")).toBeUndefined();
  await page.click("#rerender"); // 原状に戻す再レンダリング
  await page.waitForTimeout(300);
  await expect(page.locator(".hero-title")).toHaveText("GA4を基礎から学ぶ"); // 再適用されない(updates 停止)
  expect(await page.evaluate(() => (window as unknown as { AB: { getAssignments(): Record<string, string> } }).AB.getAssignments())).toEqual({});
});
// 注(r1 CL-Low-3 / r2 CX-Low-4): このテストが証明するのは「DOM の更新が止まること」と「Cookie が消えること」に限る。
// 「revoke 後に通信しない」を E2E のリクエスト数で見ようとしても、runtime は granted のままでも
// DOM 再レンダリングで decision を再送しない設計(§7.1 の評価は start() で 1 回)なので、
// revoke 処理が無くてもリクエスト数は増えず空振りになる。この主張は Task 7 の revoke 回帰テスト(fetch spy で直接固定する)が担う。
// event 送信の停止は Plan 5 の `forget_disabled_keeps_profile_until_retention`(profile.spec.ts)が担う

test("regrant_after_revoke_does_not_restore_old_identity", async ({ context, page }) => {
  // spec §16: revoke 後に再 granted になったら新しい ID を発行する(旧 Identity は復元しない)
  await page.goto("/consent.html");
  await grant(page);
  await expect.poll(() => cookieValue(context, "_ab_vid")).toBeTruthy();
  const oldId = (await cookieValue(context, "_ab_vid"))!;
  await revoke(page);
  await expect.poll(() => cookieValue(context, "_ab_vid")).toBeUndefined();
  await grant(page);
  await expect.poll(() => cookieValue(context, "_ab_vid")).toBeTruthy();
  expect(await cookieValue(context, "_ab_vid")).not.toBe(oldId);
});
