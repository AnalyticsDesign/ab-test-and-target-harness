import { describe, expect, it } from "vitest";
import { deriveCookieScopes, registrableDomain, tagHosts } from "../src/cookie-scope";
import type { SiteRow } from "../src/db";
import type { DomainRow } from "../src/domains";

/** B139 Task 3: 共有の範囲をタグを置くドメインから導く関数。B148 で入力を hosts / allowedOrigins から domains_json に差し替えた */

/** 導く関数が読む列だけを持つ行(ほかの列は使わない)。行は [値, 判定] で渡す */
const row = (p: { domains?: Array<[string, DomainRow["verdict"]]>; share?: 0 | 1 }): SiteRow =>
  ({
    domains_json: JSON.stringify((p.domains ?? []).map(([value, verdict]) => ({ value, verdict, checkedAt: null, triedAt: null }))),
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

  it("dev_and_ip_rows_are_not_grouped", () => {
    const r = row({
      domains: [["www.example.com", "unknown"], ["http://www.example.com", "dev"], ["https://www.example.com:8443", "dev"], ["127.0.0.1", "unknown"], ["http://localhost:8080", "dev"]],
    });
    expect(deriveCookieScopes(r).scopes).toEqual(["example.com"]);
  });

  it("groups_by_registrable_domain", () => {
    const r = row({ domains: [["www.example.com", "edge"], ["form.example.com", "outside"], ["shop.example-shop.jp", "unknown"]] });
    expect(deriveCookieScopes(r).groups).toEqual([
      { domain: "example.com", hosts: ["www.example.com", "form.example.com"] },
      { domain: "example-shop.jp", hosts: ["shop.example-shop.jp"] },
    ]);
  });

  it("tag_hosts_reads_non_dev_rows_of_domains", () => {
    const r = row({ domains: [["www.example.com", "edge"], ["http://localhost:8080", "dev"], ["form.example.com", "unknown"]] });
    expect(tagHosts(r)).toEqual(["www.example.com", "form.example.com"]);
  });

  it("sharing_off_yields_no_scopes", () => {
    expect(deriveCookieScopes(row({ domains: [["www.example.com", "edge"]], share: 0 }))).toEqual({ groups: [], scopes: [] });
  });
});
