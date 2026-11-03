import type { Page, Route } from "@playwright/test";

/**
 * 本描画の RSC(先読みでないもの)を ms だけ遅らせる。allowPrefetch = false なら先読みは abort する(移動先の先読みが無い状態にする)。
 * 戻り値は解除の関数。shell-reuse.spec.ts と nav-feedback.spec.ts が使う
 */
export async function delayRsc(page: Page, pathRe: RegExp, ms: number, allowPrefetch = false): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    if (!pathRe.test(url.pathname) || !url.search.includes("_rsc")) return route.continue();
    const prefetch = (await route.request().allHeaders())["next-router-prefetch"];
    if (prefetch) return allowPrefetch ? route.continue() : route.abort();
    await new Promise((r) => setTimeout(r, ms));
    return route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  return () => page.unroute("**/*", handler);
}
