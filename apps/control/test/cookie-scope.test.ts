import { describe, expect, it } from "vitest";
import { deriveCookieScopes, registrableDomain, tagHosts } from "../src/cookie-scope";
import type { SiteRow } from "../src/db";

/** B139 Task 3: 共有の範囲を hosts / allowedOrigins から導く関数(spec §10.1 の B139 の段階の式) */

/** 導く関数が読む列だけを持つ行(ほかの列は使わない) */
const row = (p: { hosts?: string[]; allowedOrigins?: string[]; share?: 0 | 1 }): SiteRow =>
  ({
    hosts_json: JSON.stringify(p.hosts ?? []),
    allowed_origins_json: JSON.stringify(p.allowedOrigins ?? []),
    share_subdomains: p.share ?? 1,
  }) as SiteRow;

describe("cookie-scope", () => {
  it("registrable_domain_respects_private_suffixes", () => {
    expect(registrableDomain("a.pages.dev")).toBe("a.pages.dev");
    expect(registrableDomain("x.y.workers.dev")).toBe("y.workers.dev");
    expect(registrableDomain("u.github.io")).toBe("u.github.io");
    expect(registrableDomain("www.example.co.jp")).toBe("example.co.jp");
    expect(registrableDomain("co.jp")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("127.0.0.1")).toBeNull();
  });

  it("dev_and_ip_origins_are_not_grouped", () => {
    const r = row({
      allowedOrigins: ["https://www.example.com", "http://www.example.com", "https://www.example.com:8443", "https://127.0.0.1", "http://localhost:8080"],
    });
    expect(deriveCookieScopes(r).scopes).toEqual(["example.com"]);
  });

  it("groups_by_registrable_domain", () => {
    const r = row({ hosts: ["www.example.com"], allowedOrigins: ["https://form.example.com", "https://shop.example-shop.jp"] });
    expect(deriveCookieScopes(r).groups).toEqual([
      { domain: "example.com", hosts: ["www.example.com", "form.example.com"] },
      { domain: "example-shop.jp", hosts: ["shop.example-shop.jp"] },
    ]);
  });

  it("tag_hosts_dedupes_hosts_and_origins", () => {
    const r = row({ hosts: ["www.example.com"], allowedOrigins: ["https://www.example.com", "https://WWW.Example.com", "not a url"] });
    expect(tagHosts(r)).toEqual(["www.example.com"]);
  });

  it("sharing_off_yields_no_scopes", () => {
    expect(deriveCookieScopes(row({ hosts: ["www.example.com"], share: 0 }))).toEqual({ groups: [], scopes: [] });
  });
});
