import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureFetchPatch, runWithFetchDedupe } from "vinext/shims/fetch-cache";
import { runWithConnectionProbe, runWithIsolatedDynamicUsage } from "vinext/shims/headers";
import { createRequestContext, getRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";

/**
 * admin speed C の契約テスト: lib/control-dedupe.ts が頼る vinext(1.0.0-beta.10)の仕組みを、本物の vinext の関数で確かめる。
 * test/control-dedupe.test.ts は isFetchDedupeActive を自分で立てているので、vinext 側が変わっても通ってしまう。ここは印を立てるのも
 * 子の文脈を作るのも vinext に任せ、vinext の版を上げたときに次のどれかが変わっていれば落ちる:
 * - ページの描画は runWithFetchDedupe の中で走り、そこで isFetchDedupeActive が立つ(dist/shims/fetch-cache.js:841 の runWithFetchDedupe。
 *   呼ぶのは dist/server/app-page-dispatch.js:188 の dispatchAppPage と、:156 の再検証の描画 runAppPageRevalidationContext)
 * - 試しの実行(probe)は runWithConnectionProbe / runWithIsolatedDynamicUsage(dist/shims/headers.js。呼ぶのは dist/server/app-page-execution.js の
 *   probeAppPageLayouts など)の子の文脈で走る。子の文脈は runWithUnifiedStateMutation(dist/shims/unified-request-context.js:192)が親を浅く写して
 *   作るので、requestCache(= cacheForRequest の置き場)を親と共有する。これが崩れると probe と本描画で 2 回送る
 * - Route Handler の経路(dist/server/app-route-handler-dispatch.js)は runWithFetchDedupe を呼ばない(= まとめない)
 * 行番号は 1.0.0-beta.10 のもの(版を上げたら読み直す手がかり)
 * import はすべて package.json の exports にある道(vinext/shims/*)。Route Handler の dispatch(dispatchAppRouteHandler)は exports に無く、
 * 呼ぶにも route・ISR の口など大きな options が要るので、本物を呼ぶ代わりに dist の中身を読んで確かめる(下の describe)。
 * 注: runWithFetchDedupe は globalThis.fetch を vinext のものに差し替える。ここでの control への送り先は binding の差し替えなので影響しない
 */

let binding: { fetch: ReturnType<typeof vi.fn> };

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "wtt_session" ? { value: "t1" } : undefined) }),
  headers: async () => new Headers({ host: "localhost:3000", "cf-connecting-ip": "203.0.113.1" }),
}));
vi.mock("@/lib/control-binding", () => ({ controlBinding: async () => binding }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

const { controlFetch } = await import("@/lib/control");

/** vinext が要求ごとに作るのと同じ、既定の要求の文脈(dist/server/app-rsc-handler.js の createRequestContext → runWithRequestContext) */
const inRequest = <T>(fn: () => Promise<T>) => runWithRequestContext(createRequestContext(), fn);

beforeEach(() => {
  binding = { fetch: vi.fn(async () => Response.json({ ok: true })) };
});

describe("vinext のページの描画の経路(本物の runWithFetchDedupe)", () => {
  it("要求の文脈の既定では isFetchDedupeActive は立っていない", async () => {
    await inRequest(async () => expect(getRequestContext().isFetchDedupeActive).toBe(false));
  });

  it("runWithFetchDedupe の中で isFetchDedupeActive が立ち、同じ GET が 1 回になる", async () => {
    await inRequest(() =>
      runWithFetchDedupe(async () => {
        expect(getRequestContext().isFetchDedupeActive).toBe(true);
        await controlFetch("/me");
        await controlFetch("/me");
      }),
    );
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it("probe の子の文脈(runWithConnectionProbe)と本描画をまたいで、同じ覚えを使う", async () => {
    await inRequest(() =>
      runWithFetchDedupe(async () => {
        const outer = getRequestContext();
        await runWithConnectionProbe(async () => {
          // 子の文脈が別のオブジェクトであること(= 本当に子をまたいでいる)と、置き場を共有していること
          expect(getRequestContext()).not.toBe(outer);
          expect(getRequestContext().requestCache).toBe(outer.requestCache);
          await controlFetch("/me");
        });
        await controlFetch("/me");
      }),
    );
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it("動的な使い方を調べる子の文脈(runWithIsolatedDynamicUsage)をまたいでも 1 回", async () => {
    await inRequest(() =>
      runWithFetchDedupe(async () => {
        await runWithIsolatedDynamicUsage(() => controlFetch("/me"));
        await controlFetch("/me");
      }),
    );
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });

  it("runWithFetchDedupe を入れ子にしても(印が立っていれば素通し)同じ覚え", async () => {
    await inRequest(() =>
      runWithFetchDedupe(async () => {
        await runWithFetchDedupe(() => controlFetch("/me"));
        await controlFetch("/me");
      }),
    );
    expect(binding.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("vinext の Route Handler の経路(印が立たない = まとめない)", () => {
  it("要求の文脈に ensureFetchPatch だけ(dispatchAppRouteHandler が呼ぶのと同じ)では、同じ GET を 2 回送る", async () => {
    await inRequest(async () => {
      ensureFetchPatch();
      expect(getRequestContext().isFetchDedupeActive).toBe(false);
      await controlFetch("/me");
      await controlFetch("/me");
    });
    expect(binding.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("vinext の dist の中身(dispatch が runWithFetchDedupe で包むか)", () => {
  // vinext/package.json は exports に無いので、exports にある shims/fetch-cache の実際の場所から dist/server を辿る
  const serverDir = path.join(path.dirname(fileURLToPath(import.meta.resolve("vinext/shims/fetch-cache"))), "..", "server");
  const read = (name: string) => readFileSync(path.join(serverDir, name), "utf8");

  it("ページの dispatch は描画全体を runWithFetchDedupe で包む", () => {
    expect(read("app-page-dispatch.js")).toMatch(/runWithFetchDedupe\(\(\) => dispatchAppPageInner\(/);
  });

  it("Route Handler の dispatch は runWithFetchDedupe を使わない", () => {
    expect(read("app-route-handler-dispatch.js")).not.toMatch(/runWithFetchDedupe/);
  });
});
