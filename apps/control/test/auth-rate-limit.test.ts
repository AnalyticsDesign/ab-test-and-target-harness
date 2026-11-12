import { describe, expect, it } from "vitest";
import { BREAK_GLASS, call, expectEnvelope } from "./helpers";

/** 既存の binding の枠を模し、経路と IP が同じ要求だけが上限に当たる。壁時計に依らない。 */
function oneRequestPerKey() {
  const seen = new Set<string>();
  return {
    async limit({ key }: { key: string }) {
      const success = !seen.has(key);
      seen.add(key);
      return { success };
    },
  };
}

describe("anonymous auth rate limit coverage (B233)", () => {
  for (const first of ["GET", "HEAD"]) {
    it.each(["/auth/google/start", "/auth/callback/google"])(`${first} and the other method share the same per-IP limit: %s`, async path => {
      const envOverride = { AUTH_RATE_LIMITER: oneRequestPerKey() };
      const headers = { "cf-connecting-ip": "203.0.113.81" };
      expect((await call(first, path, { headers, envOverride })).status).toBe(400);
      const second = await call(first === "GET" ? "HEAD" : "GET", path, { headers, envOverride });
      expect(second.status).toBe(429);
      if (first === "GET") expect(await second.text()).toBe("");
      else expect(second.headers.get("content-type")).toBe("text/html; charset=utf-8");
      // 別の IP には同じ経路でも枠が残る。
      expect((await call("GET", path, { headers: { "cf-connecting-ip": "203.0.113.82" }, envOverride })).status).toBe(400);
    });
  }

  it.each(["/auth/google/st%61rt", "/auth/callback/go%6fgle"])("encoded HEAD %s is counted before starting OAuth", async path => {
    const envOverride = { AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const res = await call("HEAD", `${path}?flow=test-flow-0123456789abcdef`, { envOverride });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("");
    expect(res.headers.get("location")).toBeNull();
  });

  for (const open of [false, true]) {
    it.each([{}, { callbackURL: "http://localhost:3000/login" }, { callbackURL: "https://evil.example/" }])(`sign-out is rate limited even with break-glass=${open}: %j`, async body => {
      const envOverride = { ...(open ? BREAK_GLASS : {}), AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } };
      const res = await call("POST", "/auth/sign-out", { body, envOverride });
      expect(res.status).toBe(429);
      expect((await expectEnvelope(res)).error).toBe("rate_limited");
    });
  }
  it("encoded sign-out shares the sign-out limit and successful sign-out remains available", async () => {
    const envOverride = { AUTH_RATE_LIMITER: oneRequestPerKey() };
    const headers = { "cf-connecting-ip": "203.0.113.83" };
    const res = await call("POST", "/auth/sign-out", { body: {}, headers, envOverride });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const limited = await call("POST", "/auth/sign-%6fut", { body: {}, headers, envOverride });
    expect(limited.status).toBe(429);
    expect((await expectEnvelope(limited)).error).toBe("rate_limited");
  });
});
