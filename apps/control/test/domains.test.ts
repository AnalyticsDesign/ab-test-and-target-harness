import { describe, expect, test } from "vitest";
import { checkDomainList, deriveDomainColumns, domainGroups, normalizeDomainInput, type DomainRow } from "../src/domains";

/** B148 Task 1: ドメイン一覧の行・入力のそろえ方・一覧から導く列(純粋な関数) */

describe("domains", () => {
  test("normalizes_and_rejects_duplicates_after_normalizing", () => {
    expect(normalizeDomainInput(" HTTPS://WWW.Example.com/ ")).toEqual({ ok: true, value: "www.example.com", dev: false });
    expect(normalizeDomainInput("www.example.com.")).toEqual({ ok: true, value: "www.example.com", dev: false });
    expect(normalizeDomainInput("http://localhost:8080")).toEqual({ ok: true, value: "http://localhost:8080", dev: true });
    expect(normalizeDomainInput("https://www.example.com:8443")).toEqual({ ok: true, value: "https://www.example.com:8443", dev: true });
    expect(normalizeDomainInput("www.example.com/form")).toEqual({ ok: false, reason: "path" });
    expect(normalizeDomainInput("*.example.com")).toEqual({ ok: false, reason: "wildcard" });
    expect(normalizeDomainInput("例え.jp")).toEqual({ ok: false, reason: "not_domain" }); // IDN は punycode で書く(spec §6.2)
    expect(checkDomainList(["www.example.com", "https://WWW.example.com/"])).toEqual({ errors: [{ index: 1, reason: "duplicate" }] });
    expect(checkDomainList([])).toEqual({ errors: [{ index: null, reason: "empty" }] });
    expect(checkDomainList(Array.from({ length: 51 }, (_, i) => `h${i}.example.com`))).toEqual({ errors: [{ index: null, reason: "too_many" }] });
    // scheme・port だけ違う行は重複にしない(spec §6.2)
    expect(checkDomainList(["www.example.com", "https://www.example.com:8443"])).toHaveProperty("rows");
  });

  test("accepts the maximum host and line lengths and rejects longer input", () => {
    const labels = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)];
    const host = labels.join(".");
    expect(normalizeDomainInput(`https://${host}.:65535/`)).toEqual({
      ok: true, value: `https://${host}:65535`, dev: true,
    });
    expect(normalizeDomainInput(host + "d")).toEqual({ ok: false, reason: "not_domain" });
    expect(normalizeDomainInput(`https://${host}.:65535//`)).toEqual({ ok: false, reason: "not_domain" });
  });

  test("derives_the_three_columns_from_domains", () => {
    const rows: DomainRow[] = [
      { value: "www.example.com", verdict: "edge", checkedAt: 1, triedAt: 1 },
      { value: "form.example.com", verdict: "outside", checkedAt: 1, triedAt: 1 },
      { value: "new.example.com", verdict: "unknown", checkedAt: null, triedAt: null },
      { value: "http://localhost:8080", verdict: "dev", checkedAt: null, triedAt: null },
    ];
    expect(deriveDomainColumns(rows, "B")).toEqual({
      domain: "www.example.com",
      allowedOrigins: ["https://www.example.com", "https://form.example.com", "https://new.example.com", "http://localhost:8080"],
      hosts: ["www.example.com"],
    });
    expect(deriveDomainColumns(rows, "A").hosts).toEqual([]); // Mode A は hosts を持たない
    expect(domainGroups(rows, "B")).toEqual({ edge: ["www.example.com"], outside: ["form.example.com"], unchecked: ["new.example.com"] });
    expect(domainGroups(rows, "A")).toEqual({ edge: [], outside: [], unchecked: [] });
  });

  test("edge_cases_of_input", () => {
    // 空・空白だけはドメインではない
    expect(normalizeDomainInput("")).toEqual({ ok: false, reason: "not_domain" });
    expect(normalizeDomainInput("   ")).toEqual({ ok: false, reason: "not_domain" });
    expect(normalizeDomainInput("https://")).toEqual({ ok: false, reason: "not_domain" });
    // localhost・IP は Origin で書いたときだけ開発用(素のホスト名は通常の行)
    expect(normalizeDomainInput("localhost")).toEqual({ ok: true, value: "localhost", dev: false });
    expect(normalizeDomainInput("127.0.0.1")).toEqual({ ok: true, value: "127.0.0.1", dev: false });
    expect(normalizeDomainInput("http://127.0.0.1:3000/")).toEqual({ ok: true, value: "http://127.0.0.1:3000", dev: true });
    // scheme の無い port 付きは https の Origin として開発用の行にする
    expect(normalizeDomainInput("Localhost:8080")).toEqual({ ok: true, value: "https://localhost:8080", dev: true });
    // http は port が無くても開発用
    expect(normalizeDomainInput("http://www.example.com")).toEqual({ ok: true, value: "http://www.example.com", dev: true });
    // port の範囲外・不正
    expect(normalizeDomainInput("http://localhost:0")).toEqual({ ok: false, reason: "not_domain" });
    expect(normalizeDomainInput("http://localhost:99999")).toEqual({ ok: false, reason: "not_domain" });
    expect(normalizeDomainInput("localhost:")).toEqual({ ok: false, reason: "not_domain" });
    // 空のラベル・記号・認証情報
    expect(normalizeDomainInput(".example.com")).toEqual({ ok: false, reason: "not_domain" });
    expect(normalizeDomainInput("a..example.com")).toEqual({ ok: false, reason: "not_domain" });
    expect(normalizeDomainInput("user@example.com")).toEqual({ ok: false, reason: "not_domain" });
    // query・fragment も path 扱い
    expect(normalizeDomainInput("www.example.com?x=1")).toEqual({ ok: false, reason: "path" });
    expect(normalizeDomainInput("www.example.com#top")).toEqual({ ok: false, reason: "path" });
    // 他の scheme は受けない
    expect(normalizeDomainInput("ftp://www.example.com")).toEqual({ ok: false, reason: "not_domain" });
  });

  test("default_ports_are_dropped_to_the_canonical_origin", () => {
    // core の設定の検査は new URL(v).origin === v を求める。既定のポートを残すと保存で英語の 422 になるので、そろえるときに落とす
    expect(normalizeDomainInput("http://localhost:80")).toEqual({ ok: true, value: "http://localhost", dev: true });
    expect(normalizeDomainInput("http://www.example.com:80/")).toEqual({ ok: true, value: "http://www.example.com", dev: true });
    // https の 443 を落とすと scheme も port も無い形なので、通常の行
    expect(normalizeDomainInput("https://www.example.com:443")).toEqual({ ok: true, value: "www.example.com", dev: false });
    expect(normalizeDomainInput("www.example.com:443")).toEqual({ ok: true, value: "www.example.com", dev: false });
    // 既定でないポートは残る
    expect(normalizeDomainInput("http://localhost:443")).toEqual({ ok: true, value: "http://localhost:443", dev: true });
    expect(normalizeDomainInput("https://localhost:80")).toEqual({ ok: true, value: "https://localhost:80", dev: true });
    // URL が別の形に書き直すホストは受けない(保存で英語の 422 にしない)
    expect(normalizeDomainInput("http://0x7f.1:8080")).toEqual({ ok: false, reason: "not_domain" });
    expect(normalizeDomainInput("1.2.3")).toEqual({ ok: false, reason: "not_domain" });
    // 既定のポートの有無だけ違う行は重複
    expect(checkDomainList(["www.example.com", "https://www.example.com:443"])).toEqual({ errors: [{ index: 1, reason: "duplicate" }] });
  });

  test("check_list_reports_every_bad_row_with_its_index", () => {
    expect(checkDomainList(["a.example.com", "x/y", "*.example.com", "A.example.com", ""])).toEqual({
      errors: [
        { index: 1, reason: "path" },
        { index: 2, reason: "wildcard" },
        { index: 3, reason: "duplicate" },
        { index: 4, reason: "not_domain" },
      ],
    });
    // ちょうど 50 行は通り、rows は入力順の正規化後の値と dev を持つ
    const fifty = Array.from({ length: 50 }, (_, i) => `h${i}.example.com`);
    expect(checkDomainList(fifty)).toHaveProperty("rows");
    expect(checkDomainList(["WWW.example.com", "http://localhost:8080"])).toEqual({
      rows: [{ value: "www.example.com", dev: false }, { value: "http://localhost:8080", dev: true }],
    });
  });

  test("derived_domain_uses_hostname_when_first_row_is_dev", () => {
    const rows: DomainRow[] = [
      { value: "http://localhost:8080", verdict: "dev", checkedAt: null, triedAt: null },
      { value: "www.example.com", verdict: "edge", checkedAt: 1, triedAt: 1 },
    ];
    expect(deriveDomainColumns(rows, "A")).toEqual({
      domain: "localhost",
      allowedOrigins: ["http://localhost:8080", "https://www.example.com"],
      hosts: [],
    });
  });
});
