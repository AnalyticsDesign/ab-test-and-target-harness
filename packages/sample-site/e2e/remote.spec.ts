import { test, expect } from "@playwright/test";
import { findVisitor, presetVisitor, readDataLayer } from "./helpers";

test("needsProfile site posts decision with visitor id and context (spec §9.1)", async ({ context, page }) => {
  const id = findVisitor("exp_remote", "B");
  await presetVisitor(context, id);
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/v1/sites/site_remote/decision") && r.method() === "POST"),
    page.goto("/remote.html"),
  ]);
  const body = req.postDataJSON() as Record<string, unknown>;
  expect(body.v).toBe(1);
  expect(body.visitorId).toBe(id);
  expect(String(body.url)).toContain("/remote.html");
  expect(["mobile", "tablet", "desktop"]).toContain(body.device);
  expect(body.viewport).toEqual({ w: expect.any(Number), h: expect.any(Number) }); // remote.html は viewport の meta を bootstrap より前に持つ
  expect(typeof body.browser).toBe("string");
  expect(typeof body.os).toBe("string");
  expect(body.firstVisitAt).toBeNull(); // presetVisitor の ID は v4 = 発行時刻が不明(null)
  // decision body のフィールドは { v, url, referrer, device, browser, os, viewport, visitorId, firstVisitAt }(決定 49 §9)。
  // 直接 goto なので document.referrer は空文字になる想定 — その実値と厳密一致で最後の 1 フィールドを固定する
  expect(body.referrer).toBe(await page.evaluate(() => document.referrer));
});

test("needsProfile site applies the assignment returned by the profile path (plan 5)", async ({ context, page }) => {
  // Plan 2〜4 の edge は profile=null で空応答だった。Plan 5 で DO が persistAssignment の割当を返す(§7.3 / §7.4)
  await presetVisitor(context, findVisitor("exp_remote", "B"));
  await page.goto("/remote.html");
  await expect(page.locator(".hero-title")).toHaveText("remote B"); // vB weight 100
  await expect(page.locator(".hero-title")).toHaveCSS("opacity", "1");
  expect((await readDataLayer(page)).filter((e) => e.event === "ab_exposure").map((e) => e.ab_experiment_id)).toEqual(["exp_remote"]);
});
