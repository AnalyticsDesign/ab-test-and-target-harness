import { describe, it, expect } from "vitest";
import { SiteSettingsSchema, parseSiteSettings, toRuntimeSettings, kvKeys } from "../src/settings";
import { DecisionBodySchema, DliteRequestSchema } from "../src/protocol";
import { DEFAULT_ANALYTICS } from "../src/analytics-defaults";
import { NEW_PROFILE_BUDGET_DEFAULTS, NEW_PROFILE_HOURLY_RATIO, NEW_PROFILE_INSTANCE_PER_DAY_FREE, newProfileLimits, utcHourKey } from "../src/new-profile-budget";

describe("SiteSettings (spec §5.4 site-settings record)", () => {
  it("applies defaults from minimal input", () => {
    const s = SiteSettingsSchema.parse({ settingsVersion: 1, siteId: "site_1" });
    expect(s.mode).toBe("A");
    expect(s.idSource).toBe("ab");
    expect(s.allowedOrigins).toEqual([]);
    expect(s.hosts).toEqual([]);
    expect(s.visitorCookieName).toBe("_ab_vid");
    expect(s.uuidCookieEnabled).toBe(false);
    expect(s.uuidCookieName).toBe("_ab_uuid");
    expect(s.previousCookieNames).toEqual([]);
    expect(s.decisionTimeoutMs).toBe(1000);
    expect(s.consentMode).toBe("implicit");
  });
  it("rejects invalid cookie names and identical canonical/uuid names (spec §13.5 保存時検証と同じ規則)", () => {
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", visitorCookieName: "bad name" })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", visitorCookieName: "a=b" })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", visitorCookieName: "_x", uuidCookieName: "_x" })).toBeNull();
  });
  it("mode_c_can_enable_uuid_cookie(決定 49 §7.2)", () => {
    // BYOID(cookie:)でも UUID Cookie を有効にできる(導出した UUIDv4 は BYOID の訪問者にも出す)
    expect(SiteSettingsSchema.safeParse({ settingsVersion: 1, siteId: "s", idSource: "cookie:_site_uid", uuidCookieEnabled: true }).success).toBe(true);
  });
  it("mode_b_cannot_use_byoid_idsource(spec §4: フックは Phase 2。r2 CX-Medium-10)", () => {
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", mode: "B", idSource: "cookie:sid" })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", mode: "B" })).not.toBeNull();
  });
  it("rejects malformed idSource / origins / hosts(決定 29)", () => {
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", idSource: "cookie:bad name" })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", allowedOrigins: ["https://a.example/"] })).toBeNull(); // 末尾スラッシュ
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", allowedOrigins: ["ftp://a.example"] })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", allowedOrigins: ["https://a.example"] })).not.toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", hosts: ["EXAMPLE.com"] })).toBeNull(); // 小文字のみ
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s".repeat(64) })).not.toBeNull(); // siteId も 64/65 境界(r2 CX-Medium-8)
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s".repeat(65) })).toBeNull();
  });
  it("cookie_and_idsource_name_accept_64_and_reject_65(決定 29、r2 CX-Medium-9)", () => {
    const n64 = "a".repeat(64);
    const n65 = "a".repeat(65);
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", visitorCookieName: n64 })).not.toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", visitorCookieName: n65 })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", idSource: `cookie:${n64}` })).not.toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", idSource: `cookie:${n65}` })).toBeNull();
  });
  it("rejects unknown settingsVersion, unknown fields, out-of-range timeout (fail-closed)", () => {
    expect(parseSiteSettings({ settingsVersion: 2, siteId: "s" })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", evil: 1 })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", decisionTimeoutMs: 100 })).toBeNull();
    expect(parseSiteSettings("junk")).toBeNull();
  });
  it("toRuntimeSettings exposes only the runtime subset (spec §5.4: hosts / allowedOrigins は焼き込まない)", () => {
    const s = SiteSettingsSchema.parse({
      settingsVersion: 1, siteId: "site_1", hosts: ["example.com"], allowedOrigins: ["https://example.com"],
      previousCookieNames: [{ name: "_old", until: 1757000000 }],
    });
    const r = toRuntimeSettings(s);
    expect(r).toEqual({
      mode: "A", idSource: "ab", visitorCookieName: "_ab_vid",
      uuidCookieEnabled: false, uuidCookieName: "_ab_uuid",
      previousCookieNames: ["_old"], decisionTimeoutMs: 1000, consentMode: "implicit",
      analytics: DEFAULT_ANALYTICS, forgetOnRevoke: true,
    });
    expect("hosts" in r).toBe(false);
    expect("allowedOrigins" in r).toBe(false);
    expect("siteId" in r).toBe(false);
  });
  it("analytics defaults to the spec §10.9 names and accepts a partial override", () => {
    const s = SiteSettingsSchema.parse({ settingsVersion: 1, siteId: "site_1" });
    expect(s.analytics).toEqual(DEFAULT_ANALYTICS); // 旧 record(analytics 無し)も新 edge で既定名になる
    const renamed = SiteSettingsSchema.parse({ settingsVersion: 1, siteId: "site_1", analytics: { extraKey: "wtt_x", exposure: { event: "wtt_exposure" } } });
    expect(renamed.analytics.extraKey).toBe("wtt_x");
    expect(renamed.analytics.exposure.event).toBe("wtt_exposure");
    expect(renamed.analytics.exposure.keys).toEqual(DEFAULT_ANALYTICS.exposure.keys);
    expect(renamed.analytics.conversion).toEqual(DEFAULT_ANALYTICS.conversion);
    // 検証はスキーマに載っている(§10.9 の規則が settings 経由でも効く)
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", analytics: { extraKey: "ga_x" } })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", analytics: { conversion: { event: "ab_exposure" } } })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "s", analytics: { evil: 1 } })).toBeNull();
    // settingsVersion は据え置き(optional 追加。決定 29 / §10.9)
    expect(renamed.settingsVersion).toBe(1);
  });
  it("retentionDays と forgetOnRevoke は optional で既定 90 / true(決定 37。旧 record は欠落のまま parse できる)", () => {
    const s = parseSiteSettings({ settingsVersion: 1, siteId: "site_a" })!;
    expect(s.retentionDays).toBe(90);
    expect(s.forgetOnRevoke).toBe(true);
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "site_a", retentionDays: 3650, forgetOnRevoke: false })).toMatchObject({ retentionDays: 3650, forgetOnRevoke: false });
    // 範囲外・型不正は record 全体を拒否(strict。§8.3 は 1〜3650)
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "site_a", retentionDays: 0 })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "site_a", retentionDays: 3651 })).toBeNull();
    expect(parseSiteSettings({ settingsVersion: 1, siteId: "site_a", forgetOnRevoke: "yes" })).toBeNull();
  });
  it("toRuntimeSettings は forgetOnRevoke を渡し retentionDays は渡さない(runtime に不要)", () => {
    const s = parseSiteSettings({ settingsVersion: 1, siteId: "site_a", forgetOnRevoke: false })!;
    const r = toRuntimeSettings(s);
    expect(r.forgetOnRevoke).toBe(false);
    expect("retentionDays" in r).toBe(false);
  });
  it("kvKeys produce the spec §9.4 / §5.4 key shapes", () => {
    expect(kvKeys.config("site_1", 42)).toBe("site:site_1:config:v42");
    expect(kvKeys.active("site_1")).toBe("site:site_1:active");
    expect(kvKeys.settings("site_1")).toBe("site:site_1:settings");
    expect(kvKeys.host("Example.COM")).toBe("host:example.com");
  });
});

describe("decision protocol (spec §9.1)", () => {
  const body = { v: 1, url: "https://example.com/", referrer: "", device: "mobile", visitorId: "x" };
  it("accepts a decision body and defaults referrer", () => {
    const parsed = DecisionBodySchema.parse({ v: 1, url: "https://example.com/", device: "desktop" });
    expect(parsed.referrer).toBe("");
  });
  it("rejects missing v / unknown fields / bad device", () => {
    expect(DecisionBodySchema.safeParse({ ...body, v: undefined }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ ...body, evil: 1 }).success).toBe(false);
    expect(DecisionBodySchema.safeParse({ ...body, device: "tv" }).success).toBe(false);
  });
  it("DliteRequestSchema distinguishes consent from decision (spec §9.1)", () => {
    const consent = DliteRequestSchema.parse({ kind: "consent", value: "denied" });
    expect(consent).toEqual({ kind: "consent", value: "denied" });
    const dec = DliteRequestSchema.parse({ v: 2, url: "https://e.com/", device: "tablet" });
    expect("v" in dec && dec.v).toBe(2);
    expect(DliteRequestSchema.safeParse({ kind: "consent", value: "granted" }).success).toBe(false);
  });
});

describe("idSource validation (decision 29)", () => {
  it("idSource accepts ab and cookie:<name> with cookie-name token 1..64 (decision 29)", () => {
    const base = { settingsVersion: 1, siteId: "site_x" };
    expect(parseSiteSettings({ ...base, idSource: "ab" })).not.toBeNull();
    expect(parseSiteSettings({ ...base, idSource: "cookie:_my.id" })).not.toBeNull();
    expect(parseSiteSettings({ ...base, idSource: "cookie:" })).toBeNull();          // 空名
    expect(parseSiteSettings({ ...base, idSource: `cookie:${"a".repeat(65)}` })).toBeNull(); // 65 字
    expect(parseSiteSettings({ ...base, idSource: "cookie:bad name" })).toBeNull();  // 空白は token 外
    expect(parseSiteSettings({ ...base, idSource: "localStorage:k" })).toBeNull();   // Phase 2
  });

  it("byoid_cookie_name_must_not_collide_with_identity_cookie_names", () => {
    // spec §4.3(2026-09-01 決定): 参照先が正本と同名だと、フォールバックで自分が書いた匿名 ID を
    // 次の起動で BYOID として読み、同じ訪問者の ID が 22 文字 → 43 文字に変わる
    const base = { settingsVersion: 1, siteId: "site_x" };
    expect(parseSiteSettings({ ...base, idSource: "cookie:_ab_vid" })).toBeNull();                              // 正本(既定名)
    expect(parseSiteSettings({ ...base, idSource: "cookie:my_vid", visitorCookieName: "my_vid" })).toBeNull();  // 正本(変更後の名前)
    expect(parseSiteSettings({ ...base, idSource: "cookie:_ab_uuid", uuidCookieEnabled: false })).toBeNull();   // UUID 名(無効時も予約された名前として拒否)
    expect(parseSiteSettings({ ...base, idSource: "cookie:_old", previousCookieNames: [{ name: "_old", until: 1 }] })).toBeNull(); // 旧名(保持期限は見ない)
    expect(parseSiteSettings({ ...base, idSource: "cookie:_site_session" })).not.toBeNull();                    // 無関係な名前は通る
  });
});

describe("resultsCollectUntil (D9 ②、K7)", () => {
  const min = { settingsVersion: 1, siteId: "site_1" };
  it("reads a record with resultsCollectUntil and keeps records without it", () => {
    const withIt = SiteSettingsSchema.parse({ ...min, resultsCollectUntil: { AAAAAAAAAAAAAAAAAAAAAA: 1_800_000_000_000 } });
    expect(withIt.resultsCollectUntil).toEqual({ AAAAAAAAAAAAAAAAAAAAAA: 1_800_000_000_000 });
    expect(SiteSettingsSchema.parse(min).resultsCollectUntil).toBeUndefined();
  });
  it("rejects a negative or non-integer value", () => {
    expect(SiteSettingsSchema.safeParse({ ...min, resultsCollectUntil: { AAAAAAAAAAAAAAAAAAAAAA: -1 } }).success).toBe(false);
    expect(SiteSettingsSchema.safeParse({ ...min, resultsCollectUntil: { AAAAAAAAAAAAAAAAAAAAAA: 1.5 } }).success).toBe(false);
  });
  it("is not baked into the runtime settings", () => {
    const s = SiteSettingsSchema.parse({ ...min, resultsCollectUntil: { AAAAAAAAAAAAAAAAAAAAAA: 5 } });
    expect(toRuntimeSettings(s)).not.toHaveProperty("resultsCollectUntil");
  });
});

describe("newProfileBudget(plan12 K9・決定 63 (8))", () => {
  const min = { settingsVersion: 1, siteId: "site_1" };
  it("newProfileBudget の無い record も読める(既存の record の互換)", () => {
    expect(SiteSettingsSchema.parse(min).newProfileBudget).toBeUndefined();
  });
  it("perDay は 1 以上の整数。instancePerDay は省略できる", () => {
    expect(SiteSettingsSchema.parse({ ...min, newProfileBudget: { perDay: 20_000 } }).newProfileBudget).toEqual({ perDay: 20_000 });
    expect(SiteSettingsSchema.parse({ ...min, newProfileBudget: { perDay: 20_000, instancePerDay: 20_000 } }).newProfileBudget).toEqual({ perDay: 20_000, instancePerDay: 20_000 });
    expect(SiteSettingsSchema.safeParse({ ...min, newProfileBudget: { perDay: 0 } }).success).toBe(false);
    expect(SiteSettingsSchema.safeParse({ ...min, newProfileBudget: { perDay: 1.5 } }).success).toBe(false);
    expect(SiteSettingsSchema.safeParse({ ...min, newProfileBudget: { perDay: 100_000_001 } }).success).toBe(false);
    expect(SiteSettingsSchema.safeParse({ ...min, newProfileBudget: { perDay: 10, instancePerDay: 0 } }).success).toBe(false);
    expect(SiteSettingsSchema.safeParse({ ...min, newProfileBudget: { perDay: 10, extra: 1 } }).success).toBe(false); // strict
    expect(SiteSettingsSchema.safeParse({ ...min, newProfileBudget: {} }).success).toBe(false);
  });
  it("runtime の設定には焼かない", () => {
    const s = SiteSettingsSchema.parse({ ...min, newProfileBudget: { perDay: 5 } });
    expect(toRuntimeSettings(s)).not.toHaveProperty("newProfileBudget");
  });
  it("newProfileLimits は 1 時間の上限を 1 日の上限 × 0.1 の切り上げにする", () => {
    expect(NEW_PROFILE_HOURLY_RATIO).toBe(0.1);
    expect(NEW_PROFILE_BUDGET_DEFAULTS).toEqual({ free: 20_000, paid: 200_000 });
    expect(NEW_PROFILE_INSTANCE_PER_DAY_FREE).toBe(20_000);
    expect(newProfileLimits(20_000)).toEqual({ perHour: 2_000, perDay: 20_000 });
    expect(newProfileLimits(15)).toEqual({ perHour: 2, perDay: 15 });
    expect(newProfileLimits(1)).toEqual({ perHour: 1, perDay: 1 });
  });
  it("utcHourKey は UTC の YYYY-MM-DDTHH", () => {
    expect(utcHourKey(Date.UTC(2026, 9, 19, 23, 59, 59))).toBe("2026-10-19T23");
    expect(utcHourKey(Date.UTC(2026, 9, 20, 0, 0, 0))).toBe("2026-10-20T00");
  });
});
