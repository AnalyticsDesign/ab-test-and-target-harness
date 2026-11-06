import { describe, expect, it, vi } from "vitest";
import { call, setupOwner } from "./helpers";

/**
 * B162 の目的を、包み(auth-d1-dialect.ts)を外した後も見張る(B179 Task 7)。kysely 0.28 は driver の結果に
 * `numUpdatedOrDeletedRows` のキーがあると `kysely:warning: outdated driver/plugin detected!` を console.log した。
 * 1.7 は kysely 0.29 と組み込みの D1 の driver を使い、どちらもそのキーを出さない。
 * この警告は module 単位で 1 回だけ出る(kysely の logOnce)ので、Better Auth の照会を他より先に走らせないと見張れない。
 * そのため、このファイルには **この 1 件だけ** を置く(ファイルごとに module が読み直される。spy を張ってから最初の照会を流す)。
 * 他のテストを足さない
 */
describe("better-auth does not print the kysely outdated-driver warning (B162, B179)", () => {
  it("no_kysely_outdated_driver_warning_b162", async () => {
    const spy = vi.spyOn(console, "log");
    try {
      const { token } = await setupOwner();
      expect((await call("GET", "/me", { token })).status).toBe(200);
      const warned = spy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("outdated driver/plugin")));
      expect(warned).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 20_000);
});
