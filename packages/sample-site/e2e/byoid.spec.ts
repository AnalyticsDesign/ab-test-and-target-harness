import { test, expect } from "@playwright/test";
import { bucketOf, hashByoidValue } from "@wtt/core";

const SESSION = "sess-e2e-001";
const SALT = "byoid-salt-0001"; // fixtures/e2e-byoid.json の siteSalt

test("mode C hashes the site cookie and drives the assignment (spec §4.3)", async ({ context, page }) => {
  await context.addCookies([{ name: "_site_session", value: SESSION, domain: "localhost", path: "/" }]);
  const hashed = await hashByoidValue(SALT, SESSION);
  const expected = bucketOf(hashed, "exp_byoid") < 5000 ? "vA" : "vB"; // 50/50
  await page.goto("/byoid.html");
  await expect(page.locator(".hero-title")).toHaveText(expected === "vB" ? "BYOID B" : "GA4を基礎から学ぶ");
  expect(await page.evaluate(() => (window as unknown as { AB: { getAssignments(): Record<string, string> } }).AB.getAssignments())).toEqual({ exp_byoid: expected });
  // 決定 49 §7.4: Mode C でも参考用の匿名 Cookie(UUIDv7)を置く。識別(割当)は BYOID のハッシュのまま。生値も送らない(このサイトは needsProfile なしでリクエスト自体ゼロ)
  expect((await context.cookies()).find((c) => c.name === "_ab_vid")?.value).toMatch(/^[A-Za-z0-9_-]{22}$/);
});

test("mode C falls back to an anonymous id when the site cookie is absent (spec §4.3)", async ({ context, page }) => {
  await page.goto("/byoid.html");
  await expect.poll(async () => (await context.cookies()).find((c) => c.name === "_ab_vid")?.value).toMatch(/^[A-Za-z0-9_-]{22}$/);
});
