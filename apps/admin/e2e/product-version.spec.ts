import { test, expect, type Page } from "@playwright/test";
import { API_CONTRACT_VERSION } from "@wtt/core";
import { acceptInvite, issueInvite, login, openMembers, waitForHydration } from "./fixtures";
// 期待の版は生成ファイルから読む(開発では dev、公開の版ではリリースの作業が版の文字列に書き換えるため、決め打ちしない)
import { RELEASE_VERSION as ADMIN_VERSION } from "../generated/release";
import { RELEASE_VERSION as CONTROL_VERSION } from "../../control/src/generated/release";

/** B142: sign-in 1 回と招待受諾 1 回。専用の閲覧者を使い、既存メンバーの状態は変えない。 */
test("a viewer can check the installation version from settings and directly, without exposing it after logout", async ({ page, browser }) => {
  await login(page);
  await openMembers(page);
  const url = await issueInvite(page, "product-version-viewer@e2e.example", /^閲覧者/);
  const { ctx, page: viewer } = await acceptInvite(browser, url, "Product Version Viewer");
  const checkVersions = async (p: Page) => {
    // 同じ tree から作った admin と control なので、版は同じ(違えば版の食い違いの表示になり、下の確かめで落ちる)
    expect(CONTROL_VERSION).toBe(ADMIN_VERSION);
    for (const id of ["product-version", "admin-version", "control-version"]) await expect(p.getByTestId(id)).toHaveText(ADMIN_VERSION);
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
    // ログアウトの後に画面の RSC を直接取っても、版の表は返らない(redirect だけ)。vinext の layout の扱いが変わったときに気づくため
    for (const [url, headers] of [["/w/me/about.rsc", {}], ["/w/me/about", { RSC: "1" }]] as const) {
      const rsc = await viewer.request.get(url, { headers, maxRedirects: 0 });
      expect(await rsc.text(), url).not.toContain("admin-version");
    }
  } finally {
    await ctx.close();
  }
});
