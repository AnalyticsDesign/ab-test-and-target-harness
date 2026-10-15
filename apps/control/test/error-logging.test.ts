import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, errorHandler } from "../src/errors";

/**
 * errorHandler のログの出し分け(backlog D10)。トークン未設定(usage_not_configured)は想定内の状態なので、
 * スタックを付けない 1 行の warn にする。ほかの 5xx(usage_upstream_failed を含む)は今までどおり error
 */
function appThrowing(err: Error): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.get("/x", () => {
    throw err;
  });
  return app;
}

describe("errorHandler logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs usage_not_configured as a one-line warn, not an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await appThrowing(new ApiError(503, "usage_not_configured")).request("/x");
    expect(res.status).toBe(503);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("usage_not_configured");
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps console.error for other 5xx such as usage_upstream_failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await appThrowing(new ApiError(502, "usage_upstream_failed")).request("/x");
    expect(res.status).toBe(502);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
