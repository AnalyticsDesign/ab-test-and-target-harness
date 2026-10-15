import { describe, expect, it } from "vitest";
import { API_CONTRACT_VERSION, API_VERSION_HEADER } from "@wtt/core";
import { alignToWindow, call } from "./helpers";

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
    await alignToWindow();
    const ip = "198.19.0.1";
    let last: Response | undefined;
    for (let i = 0; i < 12; i++) last = await call("POST", "/auth/sign-in/email", { headers: { "cf-connecting-ip": ip }, body: {} });
    expect(last!.status).toBe(429);
    expectVersion(last!, "429 envelope");
  });
});
