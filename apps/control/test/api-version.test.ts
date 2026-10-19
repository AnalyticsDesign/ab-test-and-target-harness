import { describe, expect, it } from "vitest";
import { API_CONTRACT_VERSION, API_VERSION_HEADER } from "@wtt/core";
import { alignToWindow, AUTH_RATE_LIMIT, call } from "./helpers";

// backlog D13 / 決定 56 (1): control は全応答に自分の API 契約の版を付ける(判定はしない)
describe("api contract version header (D13 / decision 56 (1))", () => {
  const expectVersion = (res: Response, label: string) => expect(res.headers.get(API_VERSION_HEADER), label).toBe(String(API_CONTRACT_VERSION));

  it("is 1 in v1.0", () => {
    expect(API_CONTRACT_VERSION).toBe(1);
    expect(API_VERSION_HEADER).toBe("x-wtt-api-version");
  });

  it("is on success, error envelopes and passthrough responses", async () => {
    expectVersion(await call("GET", "/"), "200 text");
    expectVersion(await call("GET", "/llms.txt"), "200 llms");
    expectVersion(await call("GET", "/me"), "401 envelope");
    expectVersion(await call("GET", "/no-such-route"), "404 envelope");
    expectVersion(await call("GET", "/auth/get-session"), "Better Auth passthrough");
  });

  it("is on the 429 of the rate limiter (the first middleware runs before it)", async () => {
    await alignToWindow({ fresh: true });
    const ip = "198.19.0.1";
    // 誤ったトークンの POST /setup はすぐ 403 になる(sign-in はパスワードの比較で遅く、窓に収まらないおそれがある)
    let last: Response | undefined;
    for (let i = 0; i < AUTH_RATE_LIMIT + 1; i++) last = await call("POST", "/setup", { headers: { "cf-connecting-ip": ip, "x-setup-token": "wrong" }, body: {} });
    expect(last!.status).toBe(429);
    expectVersion(last!, "429 envelope");
  }, 25_000); // 窓の待ち(最大 10 秒)+ 31 回
});
