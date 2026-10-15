import { describe, it, expect } from "vitest";
import {
  ANALYTICS_LIMITS, AnalyticsSettingsSchema, DEFAULT_ANALYTICS, ExperimentAnalyticsSchema, VariantAnalyticsSchema,
  analyticsEventNameIssue, analyticsNameIssue, GA4_RESERVED_EVENT_NAMES,
} from "../src/index";

describe("Analytics 命名設定のスキーマと検証(spec §10.9)", () => {
  it("applies the spec §10.9 defaults from an empty object (nested prefault)", () => {
    expect(AnalyticsSettingsSchema.parse({})).toEqual(DEFAULT_ANALYTICS);
    expect(DEFAULT_ANALYTICS).toEqual({
      extraKey: "ab_extra",
      exposure: { event: "ab_exposure", keys: { experimentId: "ab_experiment_id", experimentName: "ab_experiment_name", variantId: "ab_variant_id", variantName: "ab_variant_name" } },
      conversion: { event: "ab_conversion", keys: { goalId: "ab_goal_id", goalName: "ab_goal_name" } },
    });
    // 部分指定は残りを既定値で埋める(全フィールド optional)
    const partial = AnalyticsSettingsSchema.parse({ exposure: { keys: { experimentId: "wtt_exp" } } });
    expect(partial.exposure.keys.experimentId).toBe("wtt_exp");
    expect(partial.exposure.keys.variantName).toBe("ab_variant_name");
    expect(partial.conversion).toEqual(DEFAULT_ANALYTICS.conversion);
  });

  it("analytics_name_regex_and_reserved_prefix_rejected", () => {
    // GA4 パラメータ名規則: 英字始まり・英数字とアンダースコア・40 字以内
    expect(analyticsNameIssue("ab_extra")).toBeNull();
    expect(analyticsNameIssue("a".repeat(ANALYTICS_LIMITS.nameMax))).toBeNull();
    expect(analyticsNameIssue("a".repeat(ANALYTICS_LIMITS.nameMax + 1))).not.toBeNull();
    expect(analyticsNameIssue("")).not.toBeNull();
    expect(analyticsNameIssue("1abc")).not.toBeNull();       // 数字始まり
    expect(analyticsNameIssue("ab-extra")).not.toBeNull();   // ハイフン
    expect(analyticsNameIssue("ab.extra")).not.toBeNull();   // ドット(DLV v2 がネストと解釈する)
    expect(analyticsNameIssue("ab extra")).not.toBeNull();
    // GA4 予約接頭辞(パラメータ名・イベント名とも)
    for (const bad of ["_x", "firebase_x", "ga_x", "google_x", "gtag.x"]) expect(analyticsNameIssue(bad), bad).not.toBeNull();
    expect(analyticsNameIssue("gap_x")).toBeNull(); // 前置き一致は完全な接頭辞のみ
    // サイト設定の各キーにも同じ規則が効く
    expect(AnalyticsSettingsSchema.safeParse({ extraKey: "ga_extra" }).success).toBe(false);
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { keys: { variantName: "1bad" } } }).success).toBe(false);
    expect(AnalyticsSettingsSchema.safeParse({ conversion: { keys: { goalId: "a".repeat(41) } } }).success).toBe(false);
    // extra のキーにも効く(著者側スキーマ)
    expect(ExperimentAnalyticsSchema.safeParse({ extra: { "bad.key": "v" } }).success).toBe(false);
    expect(ExperimentAnalyticsSchema.safeParse({ extra: { firebase_k: "v" } }).success).toBe(false);
    expect(ExperimentAnalyticsSchema.safeParse({ extra: { ok_key: "v" } }).success).toBe(true);
  });

  it("reserved_web_event_name_is_rejected", () => {
    // GA4 のイベント命名規則ヘルプ(予約イベント名)と自動収集イベント(Web)の両方を拒否する
    for (const name of ["page_view", "session_start", "click", "first_visit", "user_engagement", "scroll", "file_download", "form_start", "form_submit", "view_search_results", "video_start", "in_app_purchase", "error", "app_remove"]) {
      expect(GA4_RESERVED_EVENT_NAMES.has(name), name).toBe(true);
      expect(analyticsEventNameIssue(name), name).not.toBeNull();
      expect(AnalyticsSettingsSchema.safeParse({ exposure: { event: name } }).success, name).toBe(false);
      expect(AnalyticsSettingsSchema.safeParse({ conversion: { event: name } }).success, name).toBe(false);
    }
    expect(analyticsEventNameIssue("ab_exposure")).toBeNull();
    expect(analyticsEventNameIssue("page_viewed")).toBeNull(); // 予約名は完全一致のみ
    // イベント名にも名前規則と予約接頭辞が効く
    expect(analyticsEventNameIssue("ga_exposure")).not.toBeNull();
    expect(analyticsEventNameIssue("1exposure")).not.toBeNull();
  });

  it("query_id_event_prefix_is_rejected", () => {
    // GA4 が Web イベント名の予約接頭辞として定める `query_id`。パラメータ名(キー名)には適用しない
    expect(analyticsEventNameIssue("query_id")).not.toBeNull();
    expect(analyticsEventNameIssue("query_id_x")).not.toBeNull();
    expect(analyticsNameIssue("query_id_x")).toBeNull();
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { event: "query_id_exposure" } }).success).toBe(false);
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { keys: { experimentId: "query_id_exp" } } }).success).toBe(true);
  });

  it("analytics_value_over_100_chars_rejected", () => {
    // 値は文字列 1〜100 字。素の文字列長(.length)で数える — 全角も 1 文字(URL エンコード後では数えない。§10.9)
    const ok100 = "あ".repeat(100);
    expect(ExperimentAnalyticsSchema.safeParse({ overrides: { experimentName: ok100 } }).success).toBe(true);
    expect(ExperimentAnalyticsSchema.safeParse({ overrides: { experimentName: "あ".repeat(101) } }).success).toBe(false);
    expect(VariantAnalyticsSchema.safeParse({ overrides: { variantName: "" } }).success).toBe(false); // 空文字は不可
    expect(ExperimentAnalyticsSchema.safeParse({ extra: { k: "x".repeat(101) } }).success).toBe(false);
    expect(ExperimentAnalyticsSchema.safeParse({ extra: { k: "" } }).success).toBe(false);
    expect(ExperimentAnalyticsSchema.safeParse({ extra: { k: 1 } }).success).toBe(false);       // 数値は MVP 外
    expect(ExperimentAnalyticsSchema.safeParse({ extra: { k: true } }).success).toBe(false);    // 真偽値も
    expect(ExperimentAnalyticsSchema.safeParse({ extra: { k: { n: 1 } } }).success).toBe(false); // ネストも(深いマージはしない)
  });

  it("cross_level_overrides_are_rejected_by_schema", () => {
    // spec §10.9 合成規則(2026-09-02 決定): Experiment 名は Experiment が、Variant 名は Variant が決める。レベルをまたぐ上書きは受け付けない。
    // experimentId / variantId(割当ハッシュと persistAssignment の保存キー)/ イベント名(GTM トリガーの張り先)はどちらの側でも上書き不可
    expect(ExperimentAnalyticsSchema.safeParse({ overrides: { experimentName: "x" } }).success).toBe(true);
    expect(ExperimentAnalyticsSchema.safeParse({ overrides: { variantName: "y" } }).success).toBe(false); // 全 Variant が同名になる footgun
    expect(VariantAnalyticsSchema.safeParse({ overrides: { variantName: "y" } }).success).toBe(true);
    expect(VariantAnalyticsSchema.safeParse({ overrides: { experimentName: "x" } }).success).toBe(false); // Variant ごとに Experiment 名が変わる footgun
    for (const S of [ExperimentAnalyticsSchema, VariantAnalyticsSchema]) {
      expect(S.safeParse({ overrides: { experimentId: "x" } }).success).toBe(false);
      expect(S.safeParse({ overrides: { variantId: "x" } }).success).toBe(false);
      expect(S.safeParse({ overrides: { event: "x" } }).success).toBe(false);
      expect(S.safeParse({ overrides: { extraKey: "x" } }).success).toBe(false);
    }
  });

  it("site_keys_duplicate_or_equal_to_event_rejected", () => {
    // exposure 4 + conversion 2 + extraKey の 7 名はまとめて検査する
    expect(AnalyticsSettingsSchema.safeParse({ extraKey: "ab_goal_id" }).success).toBe(false);                  // extraKey と conversion キー
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { keys: { experimentId: "ab_variant_id" } } }).success).toBe(false); // exposure 内
    expect(AnalyticsSettingsSchema.safeParse({ conversion: { keys: { goalId: "ab_experiment_id" } } }).success).toBe(false); // exposure と conversion の間
    expect(AnalyticsSettingsSchema.safeParse({ extraKey: "event" }).success).toBe(false);
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { keys: { variantName: "event" } } }).success).toBe(false);
    expect(AnalyticsSettingsSchema.safeParse({ conversion: { keys: { goalName: "event" } } }).success).toBe(false);
    // イベント名がキー名と同じなのは許容(検査対象はキー名どうしと `event` のみ)
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { event: "ab_extra" } }).success).toBe(true);
  });

  it("exposure_and_conversion_event_names_must_differ", () => {
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { event: "wtt_event" }, conversion: { event: "wtt_event" } }).success).toBe(false);
    expect(AnalyticsSettingsSchema.safeParse({ conversion: { event: "ab_exposure" } }).success).toBe(false); // 片方だけ変えて既定値と衝突
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { event: "wtt_exposure" }, conversion: { event: "wtt_conversion" } }).success).toBe(true);
  });

  it("rejects unknown fields in every analytics schema (strict)", () => {
    expect(AnalyticsSettingsSchema.safeParse({ evil: 1 }).success).toBe(false);
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { evil: 1 } }).success).toBe(false);
    expect(AnalyticsSettingsSchema.safeParse({ exposure: { keys: { evil: "x" } } }).success).toBe(false);
    expect(AnalyticsSettingsSchema.safeParse({ conversion: { keys: { evil: "x" } } }).success).toBe(false);
    expect(ExperimentAnalyticsSchema.safeParse({ evil: 1 }).success).toBe(false);
    expect(VariantAnalyticsSchema.safeParse({ evil: 1 }).success).toBe(false);
    expect(ExperimentAnalyticsSchema.safeParse({ overrides: { evil: "x" } }).success).toBe(false);
    expect(VariantAnalyticsSchema.safeParse({ overrides: { evil: "x" } }).success).toBe(false);
  });
});
