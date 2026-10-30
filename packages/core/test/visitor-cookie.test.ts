import { describe, it, expect } from "vitest";
import { generateVisitorId } from "../src/id";
import { chooseVisitorId, cookieValues, markerCookieName, pickCookieDomain } from "../src/visitor-cookie";

// B139 §3.4: 同じ名前の Cookie が複数ある(Domain 付きと host 限定の併存)ときの値の選び方
const A = generateVisitorId(), B = generateVisitorId(), C = generateVisitorId();

describe("chooseVisitorId (B139 §3.4)", () => {
  it("edge_picks_single_value", () => expect(chooseVisitorId([A], undefined, true)).toEqual({ id: A, fresh: false }));
  it("edge_uses_duplicate_cookies_with_same_value", () => expect(chooseVisitorId([A, A], undefined, false)).toEqual({ id: A, fresh: false }));
  it("edge_picks_server_written_id_when_marker_matches_other_value", () => expect(chooseVisitorId([B, A], B, true)).toEqual({ id: A, fresh: false }));
  it("edge_issues_new_id_when_values_differ_without_marker", () => expect(chooseVisitorId([A, B], undefined, true)).toEqual({ id: null, fresh: true }));
  it("edge_issues_new_id_for_three_values", () => expect(chooseVisitorId([A, B, C], C, true)).toEqual({ id: null, fresh: true }));
  it("edge_ignores_marker_when_sharing_off", () => expect(chooseVisitorId([B, A], B, false)).toEqual({ id: null, fresh: true }));
  it("ignores_malformed_values_when_counting", () => expect(chooseVisitorId(["", "x", A], undefined, true)).toEqual({ id: A, fresh: false }));
  it("returns_no_id_and_not_fresh_when_no_valid_value", () => {
    expect(chooseVisitorId([], undefined, true)).toEqual({ id: null, fresh: false });
    expect(chooseVisitorId(["", "x"], A, true)).toEqual({ id: null, fresh: false });
  });
  it("marker_that_matches_neither_value_does_not_decide", () => expect(chooseVisitorId([A, B], C, true)).toEqual({ id: null, fresh: true }));
  it("marker_ignored_when_it_is_malformed_even_if_one_value_equals_it", () => expect(chooseVisitorId([A, "x"], "x", true)).toEqual({ id: A, fresh: false }));
});

describe("cookieValues", () => {
  it("cookie_values_returns_all_in_order", () => expect(cookieValues(`a=1; _ab_vid=${A}; b=2; _ab_vid=${B}`, "_ab_vid")).toEqual([A, B]));
  it("parses_pairs_without_spaces_and_keeps_values_verbatim", () => {
    expect(cookieValues("a=1;_ab_vid=x%20y;_ab_vid=p=q", "_ab_vid")).toEqual(["x%20y", "p=q"]);
  });
  it("skips_pairs_without_equals_and_does_not_match_name_prefix_or_suffix", () => {
    expect(cookieValues("_ab_vid; x_ab_vid=1; _ab_vid2=2; _ab_vid=3", "_ab_vid")).toEqual(["3"]);
  });
  it("returns_empty_for_empty_header", () => expect(cookieValues("", "_ab_vid")).toEqual([]));
  it("keeps_empty_value", () => expect(cookieValues("_ab_vid=", "_ab_vid")).toEqual([""]));
});

describe("pickCookieDomain", () => {
  it("cookie_domain_selected_per_registrable_group", () => {
    expect(pickCookieDomain("form.example.com", ["example.com", "example-shop.jp"])).toBe("example.com");
    expect(pickCookieDomain("shop.example-shop.jp", ["example.com", "example-shop.jp"])).toBe("example-shop.jp");
    expect(pickCookieDomain("example.com", ["example.com"])).toBe("example.com");
    expect(pickCookieDomain("badexample.com", ["example.com"])).toBeNull();
  });
  it("pick_cookie_domain_returns_null_outside_scopes", () => expect(pickCookieDomain("preview.workers.dev", ["example.com"])).toBeNull());
  it("returns_null_for_empty_scopes", () => expect(pickCookieDomain("example.com", [])).toBeNull());
});

describe("markerCookieName", () => {
  it("appends_js_suffix", () => expect(markerCookieName("_ab_vid")).toBe("_ab_vid_js"));
});
