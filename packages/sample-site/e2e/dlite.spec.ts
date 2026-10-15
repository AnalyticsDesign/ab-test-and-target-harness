import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { uuidToVisitorId } from "@wtt/core";
import { findVisitor, presetVisitor, readDataLayer } from "./helpers";

test("d_lite_runtime_never_writes_document_cookie", async ({ context, page }) => {
  // spec §9.6: D-lite の Identity Cookie は edge 所有(HttpOnly)。runtime は document.cookie を読みも書きもしない。
  // r1 CX-Medium-7 / CL-Low-2: HttpOnly Cookie は JS 書込が黙って拒否されるため、値の比較だけでは
  // 「runtime が書こうとしたか」を識別できない。setter/getter を計測して 0 回であることを直接証明する
  await page.addInitScript(() => {
    const w = window as unknown as { __cookieWrites: number; __cookieReads: number };
    w.__cookieWrites = 0;
    w.__cookieReads = 0;
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get() { w.__cookieReads++; return desc.get!.call(document); },
      set(v: string) { w.__cookieWrites++; desc.set!.call(document, v); },
    });
  });
  await page.goto("/dlite.html");
  await expect.poll(async () => (await context.cookies()).find((c) => c.name === "_ab_vid")).toBeTruthy();
  const vid = (await context.cookies()).find((c) => c.name === "_ab_vid")!;
  expect(vid.httpOnly).toBe(true); // edge の Set-Cookie 由来である証明
  const counts = await page.evaluate(() => ({
    writes: (window as unknown as { __cookieWrites: number }).__cookieWrites,
    reads: (window as unknown as { __cookieReads: number }).__cookieReads,
  }));
  expect(counts.writes).toBe(0);
  expect(counts.reads).toBe(0);
});

test("d-lite applies changes based on the edge-owned cookie", async ({ context, page }) => {
  // exp_dlite は persistAssignment: true(Plan 10 B6)なので事前 Cookie の割当は DO にも保存される。variant / weight を変えると wrangler dev の残った DO が旧 variant を固定し得る → その場合は .wrangler/state を消す
  await presetVisitor(context, findVisitor("exp_dlite", "B"), { httpOnly: true });
  await page.goto("/dlite.html");
  await expect(page.locator(".hero-title")).toHaveText("D-lite B");
});

test("d-lite revoke posts consent body and clears the edge cookie", async ({ context, page }) => {
  // spec §16: D-lite の revoke は /__ab/decision へ consent body を 1 回送り、edge が Max-Age=0 を返す
  await page.goto("/dlite.html");
  await expect.poll(async () => (await context.cookies()).some((c) => c.name === "_ab_vid")).toBe(true);
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/__ab/decision") && r.method() === "POST" && String(r.postData()).includes("consent")),
    page.evaluate(() => (window as unknown as { AB: { consent(g: boolean): void } }).AB.consent(false)),
  ]);
  expect(req.postDataJSON()).toEqual({ kind: "consent", value: "denied" });
  await expect.poll(async () => (await context.cookies()).some((c) => c.name === "_ab_vid")).toBe(false);
});

test("d_lite_goal_is_recorded_via_ab_event_with_cookie_identity_only", async ({ context, page }) => {
  // spec §9.2 / §9.6: D-lite の Goal は同一オリジンの /__ab/event へ転送され、body に visitorId を載せない(Cookie が正)。
  // Plan 5 繰越(backlog B6)。204 は黙殺経路(Cookie 不正・未知の goalId)でも返るので、記録されたことは
  // converted(g_dlite_buy) を条件にする exp_dlite_converted がリロード後に適用されることで観測する(r1 CL-Medium-1)
  const vid = uuidToVisitorId(randomUUID())!; // 他テストと Profile を共有しない新しい訪問者
  await presetVisitor(context, vid, { httpOnly: true });
  await Promise.all([page.waitForResponse((r) => r.url().includes("/__ab/decision")), page.goto("/dlite.html")]);
  await expect(page.locator(".old-banner")).toHaveText("旧バナー"); // まだ converted ではない
  const [req] = await Promise.all([page.waitForRequest((r) => r.url().includes("/__ab/event") && r.method() === "POST"), page.click("#buy")]);
  const body = req.postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ type: "goal", goalId: "g_dlite_buy" });
  expect(body).not.toHaveProperty("visitorId");
  expect((await req.response())?.status()).toBe(204);
  await expect.poll(async () => (await readDataLayer(page)).filter((e) => e.event === "ab_conversion").map((e) => e.ab_goal_id)).toEqual(["g_dlite_buy"]);
  await page.reload();
  await expect(page.locator(".old-banner")).toHaveText("D-lite converted"); // DO に Goal が記録された証拠(黙殺なら「旧バナー」のまま)
});
