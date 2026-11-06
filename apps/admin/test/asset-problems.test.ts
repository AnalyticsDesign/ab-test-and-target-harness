import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/client";
import { ASSET_PROBLEMS_TITLE, assetGuardRejection, assetProblemRows, parseAssetProblems, publishFailureProblems, shortAssetUrl } from "@/lib/asset-problems";
import type { AssetProblem, PublishResult } from "@/lib/types";

/**
 * B68 Task 8: 公開の確認の窓・公開の失敗・状態を変えるボタン(開始・再開)の 409 に出す「公開できない画像」の一覧。
 * 部品(PublishPanel・StatusButtons)は描かず、一覧の行を作る関数と、409 の封筒から一覧を取り出す関数を見る
 */

const missing: AssetProblem = { url: "https://assets.example.com/sites/s1/images/asset_aaaaaaaaaa.png", reason: "missing", experimentId: "e1", variantId: "b", changeId: "c1" };
const other: AssetProblem = { url: "https://assets.example.com/sites/s2/images/asset_bbbbbbbbbb.png", reason: "other_site", experimentId: "e9", variantId: "a", changeId: "c2" };

describe("assetProblemRows(公開の確認の窓)", () => {
  it("lists_reason_url_and_a_link_to_the_variant", () => {
    const rows = assetProblemRows([missing, other], {
      wid: "w1",
      siteId: "s1",
      experimentName: (id) => (id === "e1" ? "料金ページ" : undefined),
      variantName: (eid, vid) => (eid === "e1" && vid === "b" ? "B パターン" : undefined),
    });
    expect(ASSET_PROBLEMS_TITLE).toBe("公開できない画像があります");
    expect(rows).toEqual([
      {
        key: "e1/b/c1/0",
        reason: "見つからない画像",
        url: missing.url,
        shortUrl: "…/asset_aaaaaaaaaa.png",
        label: "料金ページ / B パターン",
        href: "/w/w1/sites/s1/experiments/e1?tab=variants&variant=b",
        experimentId: "e1",
        variantId: "b",
      },
      {
        key: "e9/a/c2/1",
        reason: "別のサイトの画像",
        url: other.url,
        shortUrl: "…/asset_bbbbbbbbbb.png",
        // 名前が手元に無ければ ID を出す(読みは足さない)
        label: "e9 / a",
        href: "/w/w1/sites/s1/experiments/e9?tab=variants&variant=a",
        experimentId: "e9",
        variantId: "a",
      },
    ]);
  });

  it("encodes_ids_in_the_link", () => {
    const [row] = assetProblemRows([{ ...missing, experimentId: "e 1", variantId: "b&c" }], { wid: "w1", siteId: "s1" });
    expect(row!.href).toBe("/w/w1/sites/s1/experiments/e%201?tab=variants&variant=b%26c");
  });

  it("short_url_keeps_short_urls_and_cuts_long_ones", () => {
    expect(shortAssetUrl("https://a.example/x.png")).toBe("https://a.example/x.png");
    expect(shortAssetUrl(missing.url)).toBe("…/asset_aaaaaaaaaa.png");
  });
});

describe("parseAssetProblems", () => {
  it("keeps_only_well_formed_items", () => {
    expect(parseAssetProblems([missing, { url: 1 }, { ...other, reason: "weird" }, null])).toEqual([missing]);
    expect(parseAssetProblems(undefined)).toEqual([]);
    expect(parseAssetProblems({})).toEqual([]);
  });
});

describe("publishFailureProblems(公開の失敗の応答)", () => {
  it("returns_the_problems_of_a_failed_publish", () => {
    const r: PublishResult = { ok: false, version: 4, error: "asset_missing", message: "公開する内容に、見つからない画像があります", assetProblems: [missing] };
    expect(publishFailureProblems(r)).toEqual([missing]);
  });

  it("is_empty_for_success_and_other_failures", () => {
    expect(publishFailureProblems({ ok: true, version: 3, needsProfile: false, superseded: false, staticDeploy: "deployed", warnings: [] })).toEqual([]);
    expect(publishFailureProblems({ ok: false, version: 4, error: "kv_put_failed", message: "x" })).toEqual([]);
    expect(publishFailureProblems(null)).toEqual([]);
  });
});

describe("assetGuardRejection(状態を変えるボタンの 409)", () => {
  const envelope = (code: string) =>
    new ApiClientError(409, code, {
      error: code,
      message: "画像の確かめに通らないため、状態を変えませんでした",
      hint: "次の画像が見つからないため公開できません。パターンの変更から外すか、別の画像を選び直してください。状態は変わっていません。直してからもう一度操作してください",
      assetProblems: [missing],
    });

  it("start_and_resume_show_the_unchanged_state_and_the_problems", () => {
    for (const code of ["asset_missing", "asset_other_site"]) {
      const r = assetGuardRejection(envelope(code), "running");
      expect(r).not.toBeNull();
      expect(r!.text).toContain("状態を変えませんでした");
      expect(r!.text).toContain("状態は変わっていません");
      expect(r!.problems).toEqual([missing]);
    }
  });

  it("pause_and_archive_have_no_asset_branch", () => {
    // 止める操作は control が画像を確かめないので、この表示の分岐に入れない(応答は今のままの扱い)
    expect(assetGuardRejection(envelope("asset_missing"), "paused")).toBeNull();
    expect(assetGuardRejection(envelope("asset_other_site"), "archived")).toBeNull();
  });

  it("other_errors_are_not_asset_rejections", () => {
    expect(assetGuardRejection(new ApiClientError(409, "invalid_transition", { error: "invalid_transition", message: "x" }), "running")).toBeNull();
    expect(assetGuardRejection(new ApiClientError(422, "asset_missing", { error: "asset_missing" }), "running")).toBeNull();
    expect(assetGuardRejection(new Error("x"), "running")).toBeNull();
  });
});
