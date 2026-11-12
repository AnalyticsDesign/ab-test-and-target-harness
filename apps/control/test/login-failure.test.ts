import { describe, expect, it } from "vitest";
import { isServerFaultCode, loginFailureCode, loginFailurePage, loginFailureStatus, LOGIN_FAILURE_GUIDE, NOT_INVITED } from "../src/login-failure";

describe("the Google sign-in failure page (B231)", () => {
  it("maps raw reasons to the known codes and nothing else", () => {
    expect(loginFailureCode("NOT_INVITED")).toBe("not_invited");
    expect(loginFailureCode("unable_to_create_user")).toBe("oauth_failed"); // 1.7.15 では障害のコード(1.2)
    for (const raw of ["internal_server_error", "UNABLE_TO_CREATE_USER", "unable_to_link_account", "unable_to_update_account", "unable_to_create_session"]) expect(isServerFaultCode(raw), raw).toBe(true);
    for (const raw of ["not_invited", "account_not_linked", "access_denied", "state_mismatch", null]) expect(isServerFaultCode(raw), String(raw)).toBe(false);
    expect(loginFailureCode("account_not_linked")).toBe("account_not_linked");
    expect(loginFailureCode("access_denied")).toBe("access_denied");
    for (const raw of [null, undefined, "", "state_mismatch", "invalid_code", "<script>"]) expect(loginFailureCode(raw)).toBe("oauth_failed");
  });

  it("answers HTML that cannot be framed, cached, sniffed or followed back by Referer", async () => {
    const res = loginFailurePage("not_invited");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('data-code="not_invited"');
    expect(html).toContain(NOT_INVITED);
    expect(html).toContain(LOGIN_FAILURE_GUIDE);
    expect(html).not.toMatch(/<a\b|<script\b|<form\b|http-equiv/i); // 管理画面へのリンク・自動の移動を置かない
  });

  it("does not echo anything but the code (B231 Review Focus 4)", async () => {
    // 呼び出しの側は loginFailureCode を通すので、ここに来るのは一覧の値だけ。一覧の全部で、本文の可変部分がコードと固定の文だけであること
    for (const code of ["not_invited", "email_not_verified", "account_not_linked", "access_denied", "rate_limited", "google_not_configured", "oauth_failed"] as const) {
      const html = await loginFailurePage(code).text();
      expect(html.replace(new RegExp(code, "g"), "")).not.toMatch(/[a-z]+_[a-z_]+/); // ほかのコードが混ざらない
    }
  });

  it("takes the status for control-side faults and carries the cookie expiry it is given", () => {
    const h = new Headers();
    h.append("set-cookie", "wtt_oauth_state=; Path=/auth/callback/google; Max-Age=0; HttpOnly; SameSite=Lax");
    const res = loginFailurePage("oauth_failed", { status: 500, headers: h });
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toEqual(["wtt_oauth_state=; Path=/auth/callback/google; Max-Age=0; HttpOnly; SameSite=Lax"]);
  });

  it("drops location, refresh and link even when the caller hands them in", () => {
    const h = new Headers({ location: "http://localhost:3000/login", refresh: "0;url=http://localhost:3000/", link: "<http://localhost:3000/>; rel=preconnect" });
    const res = loginFailurePage("oauth_failed", { headers: h });
    for (const name of ["location", "refresh", "link"]) expect(res.headers.get(name), name).toBeNull();
  });

  it("NOT_INVITED stays the same literal as admin's copy", () => {
    // 相手: apps/admin/lib/oauth-errors.ts の NOT_INVITED(非常用のパスワードログインが使う)。片方を変えるときは両方とテストを同時に変える
    expect(NOT_INVITED).toBe("このメールアドレスは、どのワークスペースにも所属しておらず、有効な招待もありません。招待されたメールアドレスと違うアカウントでログインしていないか確認し、心当たりが無ければ管理者に招待を依頼してください");
  });
});

it.each([
  ["not_invited", 403], ["email_not_verified", 403], ["account_not_linked", 403],
  ["access_denied", 400], ["oauth_failed", 400], ["rate_limited", 429], ["google_not_configured", 503],
] as const)("%s uses status %s", (code, status) => {
  expect(loginFailureStatus(code)).toBe(status);
  expect(loginFailurePage(code).status).toBe(status);
});
