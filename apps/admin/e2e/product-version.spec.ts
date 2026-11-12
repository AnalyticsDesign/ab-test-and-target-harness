import { test, expect, type Page } from "@playwright/test";
import { API_CONTRACT_VERSION } from "@wtt/core";
import { acceptInvite, issueInvite, login, openMembers, waitForHydration } from "./fixtures";

/** B142: sign-in 1 回と招待受諾 1 回。専用の閲覧者を使い、既存メンバーの状態は変えない。 */
test("a viewer can check the installation version from settings and directly, without exposing it after logout", async ({ page, browser }) => {
  await login(page);
  await openMembers(page);
  const url = await issueInvite(page, "product-version-viewer@e2e.example", /^閲覧者/);
  const { ctx, page: viewer } = await acceptInvite(browser, url, "Product Version Viewer");
  const checkVersions = async (p: Page) => {
    for (const id of ["product-version", "admin-version", "control-version"]) await expect(p.getByTestId(id)).toHaveText("dev");
    await expect(p.getByTestId("api-version")).toHaveText(String(API_CONTRACT_VERSION));
    await expect(p.getByTestId("version-mismatch")).toHaveCount(0);
  };
  try {
    await waitForHydration(viewer);
    await viewer.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "設定", exact: true }).click();
    await viewer.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "この導入について", exact: true }).click();
    await expect(viewer).toHaveURL(/\/w\/me\/about$/);
    await checkVersions(viewer);
    await viewer.goto("/w/me/about");
    await waitForHydration(viewer);
    await checkVersions(viewer);
    await viewer.getByTestId("user-menu").locator("summary").click();
    await viewer.getByRole("button", { name: "ログアウト", exact: true }).click();
    await expect(viewer).toHaveURL(/\/login$/);
    const response = await viewer.goto("/login");
    const html = await response!.text();
    expect(html).not.toContain("この導入について");
    expect(html).not.toContain("この説明は管理画面と同じ版");
  } finally {
    await ctx.close();
  }
});
