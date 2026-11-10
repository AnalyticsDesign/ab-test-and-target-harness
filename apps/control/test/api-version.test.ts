import { describe, expect, it } from "vitest";
import { API_CONTRACT_VERSION, API_VERSION_HEADER, MIN_CLIENT_VERSION, MIN_CLIENT_VERSION_HEADER } from "@wtt/core";
import { alignToWindow, AUTH_RATE_LIMIT, call, json, setupOwner } from "./helpers";

// backlog D13 / 決定 56 (1): control は全応答に自分の API 契約の版を付ける(判定はしない)
describe("api contract version header (D13 / decision 56 (1))", () => {
  const expectVersion = (res: Response, label: string) => {
    expect(res.headers.get(API_VERSION_HEADER), label).toBe(String(API_CONTRACT_VERSION));
    // plan12 K4: 最低の版も同じ入口で付ける(管理画面のバナーと API クライアントが読む)
    expect(res.headers.get(MIN_CLIENT_VERSION_HEADER), `${label} (min client version)`).toBe(String(MIN_CLIENT_VERSION));
  };

  it("is 7 with the minimum raised to 7 (B56: bind writes to preview)", () => {
    expect(API_CONTRACT_VERSION).toBe(7);
    expect(API_VERSION_HEADER).toBe("x-wtt-api-version");
    expect(MIN_CLIENT_VERSION_HEADER).toBe("x-wtt-min-client-version");
    expect(MIN_CLIENT_VERSION).toBe(7);
  });

  // B69(spec §9.1): 版 4 の管理画面(古い形の urlMatch を送る)からの書き込みは 426 で読み込み直しを促す
  it("client_version_4_write_is_426", async () => {
    const owner = await setupOwner();
    const res = await call("POST", "/workspaces", { token: owner.token, headers: { "x-wtt-client-version": "4" }, body: { name: "W4" } });
    expect(res.status).toBe(426);
    expect((await json(res)).error).toBe("client_too_old");
  });

  // B69 追補(追 §6): 版 5 の管理画面は and を持つ行を編集すると and を落として保存しうるので、書き込みは 426 で読み込み直しを促す
  it("client_version_5_write_is_426", async () => {
    const owner = await setupOwner();
    const res = await call("POST", "/workspaces", { token: owner.token, headers: { "x-wtt-client-version": "5" }, body: { name: "W5" } });
    expect(res.status).toBe(426);
    expect((await json(res)).error).toBe("client_too_old");
  });

  // B56/Q424: 版6の画面はexpectDigestを送らないので、書き込みは426で読み込み直しを促す。
  it("client_version_6_write_is_426", async () => {
    const owner = await setupOwner();
    const res = await call("POST", "/workspaces", { token: owner.token, headers: { "x-wtt-client-version": "6" }, body: { name: "W6" } });
    expect(res.status).toBe(426);
    expect((await json(res)).error).toBe("client_too_old");
  });

  it("client_version_7_write_passes", async () => {
    const owner = await setupOwner();
    const res = await call("POST", "/workspaces", { token: owner.token, headers: { "x-wtt-client-version": "7" }, body: { name: "W7" } });
    expect(res.status).toBe(201);
  });

  it("is on success, error envelopes and passthrough responses", async () => {
    expectVersion(await call("GET", "/"), "200 text");
    expectVersion(await call("GET", "/llms.txt"), "200 llms");
    expectVersion(await call("GET", "/me"), "401 envelope");
    expectVersion(await call("GET", "/no-such-route"), "404 envelope");
    expectVersion(await call("GET", "/auth/get-session"), "Better Auth passthrough");
    expectVersion(await call("POST", "/workspaces", { headers: { "x-wtt-client-version": "abc" }, body: {} }), "426 envelope");
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
