import { beforeAll, expect, it, vi } from "vitest";
import { API_CONTRACT_VERSION } from "@wtt/core";
// setupFiles が app を先に読むため、既存の regex-compile テストと同じく読み直す。
let h: typeof import("./helpers");
beforeAll(async () => {
  vi.resetModules();
  h = await import("./helpers");
});

vi.mock("../src/generated/release", () => ({ RELEASE_VERSION: "v9.87.6" }));
const SENTINEL = "v9.87.6";
const leaks = async (res: Response) => {
  const head = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  return (await res.text()).includes(SENTINEL) || head.includes(SENTINEL);
};
it("product_version_is_not_exposed_on_unauthenticated_entries_b142", async () => {
  for (const [m, p] of [["GET", "/llms.txt"], ["GET", "/openapi.json"], ["GET", "/login-options"], ["GET", "/auth/google/start"], ["GET", "/capabilities"], ["POST", "/workspaces"]] as const) {
    expect(await leaks(await h.call(m, p)), `${m} ${p}`).toBe(false);
  }
  // 不正な API キー・セッションの 401(鍵の作り直しの hint の枝)も見る
  for (const token of ["wtt_invalid", "not-a-session"]) {
    const res = await h.call("GET", "/capabilities", { token });
    expect(res.status, token).toBe(401);
    expect(await leaks(res), token).toBe(false);
  }
});
it("product_version_reaches_a_signed_in_caller_with_the_sentinel_b142", async () => {
  const { token } = await h.setupOwner();
  expect((await h.json(await h.call("GET", "/capabilities", { token }))).productVersion).toBe(SENTINEL);
  expect([...(await h.call("GET", "/me", { token })).headers].some(([, v]) => v.includes(SENTINEL))).toBe(false);
});
it("openapi_info_uses_the_api_contract_version", async () => {
  expect((await h.json(await h.call("GET", "/openapi.json"))).info.version).toBe(String(API_CONTRACT_VERSION));
});
