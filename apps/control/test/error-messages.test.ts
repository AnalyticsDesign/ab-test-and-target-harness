import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { ApiError, DEFAULT_MESSAGES } from "../src/errors";

it.each([
  "account_exists",
  "invitation_email_mismatch",
  "invitation_expired",
  "invitation_used",
  "no_session_token",
  "reset_link_unavailable",
  "role_cap_too_high",
  "session_required",
])("returns a user-facing default message for %s", (code) => {
  const body = new ApiError(400, code).toBody();
  expect(body.error).toBe(code);
  expect(body.message).toMatch(/[ぁ-んァ-ヶ一-龠]/u);
});

it("defines default messages for ApiError calls without an override object", () => {
  const missing = new Set<string>();
  for (const [file, source] of Object.entries(env.TEST_SOURCES)) {
    if (!file.startsWith("control/")) continue;
    for (const [, , code] of source.matchAll(/\bnew ApiError\(\s*\d+\s*,\s*(["'])(\w+)\1\s*,?\s*\)/g)) {
      if (!Object.hasOwn(DEFAULT_MESSAGES, code!)) missing.add(`${file}: ${code}`);
    }
  }
  expect([...missing]).toEqual([]);
});
