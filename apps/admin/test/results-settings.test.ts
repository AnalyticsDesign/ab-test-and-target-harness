import { describe, expect, it } from "vitest";
import { countExperimentsForResults, cspNotice, resultsToggleNotice, splitCode } from "../lib/results-settings";
import type { Experiment } from "../lib/types";

describe("resultsToggleNotice", () => {
  it("returns_null_when_enabling_with_no_running_tests", () => {
    expect(resultsToggleNotice({ enabling: true, runningTests: 0, runningRecordedTests: 0 })).toBeNull();
  });
  it("mentions_the_count_when_enabling_with_running_tests", () => {
    const text = resultsToggleNotice({ enabling: true, runningTests: 2, runningRecordedTests: 0 });
    expect(text).toBe("実行中の 2 件のテストは対象になりません。結果を見たいテストは、複製して開始し直してください");
  });
  it("ignores_recorded_tests_when_enabling", () => {
    expect(resultsToggleNotice({ enabling: true, runningTests: 0, runningRecordedTests: 3 })).toBeNull();
  });
  it("warns_with_the_count_when_disabling_with_recorded_tests", () => {
    expect(resultsToggleNotice({ enabling: false, runningTests: 5, runningRecordedTests: 1 })).toBe(
      "記録中の 1 件のテストの記録が止まります。止めた時間が評価時点までの期間の 5% を超えると、判定できなくなります",
    );
  });
  it("returns_null_when_disabling_without_recorded_tests", () => {
    expect(resultsToggleNotice({ enabling: false, runningTests: 5, runningRecordedTests: 0 })).toBeNull();
  });
});

describe("cspNotice", () => {
  it("guides_the_route_when_edge_shares_the_site_host", () => {
    const text = cspNotice({ mode: "A", edgeOrigin: "https://www.example.com", tagOrigin: "https://www.example.com", siteDomain: "www.example.com" });
    expect(text).toContain("/v1/*");
    expect(text).toContain("Route");
    expect(text).not.toContain("connect-src");
  });
  it("guides_connect_src_with_the_edge_address_when_origin_differs", () => {
    const text = cspNotice({ mode: "A", edgeOrigin: "https://wtt-edge.x.workers.dev", tagOrigin: null, siteDomain: "www.example.com" });
    expect(text).toContain("connect-src");
    expect(text).toContain("https://wtt-edge.x.workers.dev");
    expect(text).toContain("足さないと送信が届かず、ツール側でも失敗を数えられません");
  });
  it("compares_hosts_ignoring_scheme_case_and_path_of_the_site_domain", () => {
    expect(cspNotice({ mode: "A", edgeOrigin: "https://WWW.example.com", tagOrigin: null, siteDomain: "https://www.Example.com/" })).toContain("Route");
  });
  it("falls_back_to_tag_origin_when_edge_origin_is_unset", () => {
    expect(cspNotice({ mode: "A", edgeOrigin: null, tagOrigin: "https://tag.example.net", siteDomain: "www.example.com" })).toContain("https://tag.example.net");
  });
  it("still_guides_connect_src_without_an_address_when_both_origins_are_unknown", () => {
    const text = cspNotice({ mode: "A", edgeOrigin: null, tagOrigin: null, siteDomain: "www.example.com" });
    expect(text).toContain("connect-src");
  });
  it("guides_the_ab_route_in_mode_b_even_when_the_edge_origin_differs", () => {
    // Mode B は同じオリジンの /__ab/event に送るので、edge の origin が別でも connect-src の案内は出さない
    const text = cspNotice({ mode: "B", edgeOrigin: "https://wtt-edge.x.workers.dev", tagOrigin: null, siteDomain: "www.example.com" });
    expect(text).toBe("結果は同じホストの `/__ab/event` に送ります。`/__ab/*` の Route が edge に向いていることを確かめてください");
    expect(text).not.toContain("connect-src");
    expect(text).not.toContain("wtt-edge.x.workers.dev");
  });
});

describe("splitCode", () => {
  it("splits_backtick_spans_into_code_parts", () => {
    expect(splitCode("サイトの CSP の `connect-src` に足す")).toEqual([
      { code: false, text: "サイトの CSP の " },
      { code: true, text: "connect-src" },
      { code: false, text: " に足す" },
    ]);
  });
  it("drops_empty_parts_and_keeps_text_without_backticks", () => {
    expect(splitCode("`/v1/*` の Route")).toEqual([
      { code: true, text: "/v1/*" },
      { code: false, text: " の Route" },
    ]);
    expect(splitCode("文だけ")).toEqual([{ code: false, text: "文だけ" }]);
  });
});

describe("countExperimentsForResults", () => {
  const exp = (o: Partial<Experiment>) => ({ kind: "test", status: "running", runId: null, ...o }) as Experiment;
  it("counts_running_tests_and_recorded_running_or_paused_tests", () => {
    const list = [
      exp({ status: "running", runId: "r1" }),
      exp({ status: "running" }),
      exp({ status: "paused", runId: "r2" }),
      exp({ status: "paused" }),
      exp({ status: "archived", runId: "r3" }),
      exp({ status: "draft" }),
      exp({ kind: "single", status: "running" }),
    ];
    // runningTests は記録の対象外(runId が無い)の実行中のテストだけ。runId を持つ実行中のテストは数えない
    expect(countExperimentsForResults(list)).toEqual({ runningTests: 1, runningRecordedTests: 2 });
  });
  it("treats_a_missing_run_id_like_null", () => {
    // runId を返さない古い control の応答(undefined)は記録していないものとして数える
    const list = [exp({ status: "running", runId: undefined }), exp({ status: "paused", runId: undefined })];
    expect(countExperimentsForResults(list)).toEqual({ runningTests: 1, runningRecordedTests: 0 });
  });
});
