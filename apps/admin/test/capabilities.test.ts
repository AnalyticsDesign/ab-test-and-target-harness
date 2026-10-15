import { describe, expect, it } from "vitest";
import { DEFAULT_CAPABILITIES, resolveCapabilities } from "../lib/capabilities";

// 決定 43 (6) / 44 (5): 取得失敗は「有効」側、edge 未設定は「帯なし」側に倒す。最終判定は control
describe("resolveCapabilities", () => {
  it("passes_through_a_200_body", () => {
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false, edgeOrigin: "https://wtt-edge.x.workers.dev", tagOrigin: "https://wtt-static.x.workers.dev", edgeOnWorkersDev: true, passwordLogin: true } })).toEqual({
      imageUpload: false,
      edgeOrigin: "https://wtt-edge.x.workers.dev",
      tagOrigin: "https://wtt-static.x.workers.dev",
      edgeOnWorkersDev: true,
      passwordLogin: true,
      writeFreeze: null,
    });
  });
  it("falls_back_to_defaults_on_error_or_malformed", () => {
    expect(resolveCapabilities({ status: 502, data: { error: "control_unreachable" } })).toEqual(DEFAULT_CAPABILITIES);
    expect(resolveCapabilities({ status: 200, data: null })).toEqual(DEFAULT_CAPABILITIES);
    expect(resolveCapabilities({ status: 200, data: { imageUpload: "yes" } })).toEqual(DEFAULT_CAPABILITIES);
    // CX-Medium-7: edge 側のフィールドも「存在するが型不正」なら全体を既定に倒す(帯を誤って出さない・消さない)
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false, edgeOrigin: 1, edgeOnWorkersDev: true } })).toEqual(DEFAULT_CAPABILITIES);
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false, edgeOrigin: "https://x.workers.dev", edgeOnWorkersDev: "yes" } })).toEqual(DEFAULT_CAPABILITIES);
    // edgeOrigin が null で edgeOnWorkersDev が true は control の実装上あり得ないが、形としては正しいのでそのまま通す
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, edgeOrigin: null, edgeOnWorkersDev: true } })).toEqual({ imageUpload: true, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: true, passwordLogin: false, writeFreeze: null });
    // 決定 46: パスワード欄・リセットリンク・帯は「型が正しい true」だけで出す(型不正は応答全体を既定に倒す)
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, passwordLogin: "yes" } })).toEqual(DEFAULT_CAPABILITIES);
    expect(DEFAULT_CAPABILITIES).toEqual({ imageUpload: true, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false, writeFreeze: null });
    // tagOrigin が「存在するが型不正」なら応答全体を既定に倒す
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, tagOrigin: 1 } })).toEqual(DEFAULT_CAPABILITIES);
  });
  it("tagOrigin_is_passed_through_and_falls_back_to_edgeOrigin_for_old_control", () => {
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, edgeOrigin: "https://e.x", tagOrigin: "https://s.x" } }).tagOrigin).toBe("https://s.x");
    // 応答に tagOrigin が無い古い control では、設置タグは edge と同じホスト
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, edgeOrigin: "https://e.x" } }).tagOrigin).toBe("https://e.x");
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true } }).tagOrigin).toBeNull();
  });
  it("fills_missing_fields_with_defaults", () => {
    // 古い control(/capabilities に edgeOrigin が無い版)にも耐える
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false } })).toEqual({ imageUpload: false, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false, writeFreeze: null });
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false, passwordLogin: true } }).passwordLogin).toBe(true);
  });
});

import { changeTypeOptions } from "../lib/capabilities";

describe("changeTypeOptions", () => {
  it("hides_IMAGE_when_upload_disabled_unless_editing_an_existing_IMAGE", () => {
    expect(changeTypeOptions(true, "TEXT")).toEqual(["TEXT", "IMAGE", "HIDE", "ATTRIBUTE", "HTML", "CSS", "CUSTOM_JS"]);
    expect(changeTypeOptions(false, "TEXT")).toEqual(["TEXT", "HIDE", "ATTRIBUTE", "HTML", "CSS", "CUSTOM_JS"]);
    expect(changeTypeOptions(false, "IMAGE")).toEqual(["TEXT", "IMAGE", "HIDE", "ATTRIBUTE", "HTML", "CSS", "CUSTOM_JS"]);
  });
});

import { shouldShowBreakGlassBanner, shouldShowResetLink } from "../lib/capabilities";

describe("break-glass visibility", () => {
  it("the reset-link button and the banner appear only while the password door is open", () => {
    expect(shouldShowResetLink(DEFAULT_CAPABILITIES)).toBe(false);
    expect(shouldShowBreakGlassBanner(DEFAULT_CAPABILITIES)).toBe(false);
    const open = { ...DEFAULT_CAPABILITIES, passwordLogin: true };
    expect(shouldShowResetLink(open)).toBe(true);
    expect(shouldShowBreakGlassBanner(open)).toBe(true);
  });
});

import { nextWriteFreeze, parseCapabilities, writeFreezeBannerText } from "../lib/capabilities";

// backlog D13 / 決定 56 (5)(6): バナーの読み取りと文。時刻は見ている人のタイムゾーン(試験は Asia/Tokyo で固定)
describe("write freeze banner", () => {
  const TZ = "Asia/Tokyo";
  const NOW = Date.parse("2026-10-10T02:00:00Z"); // 11:00 JST

  it("resolve passes a well-formed writeFreeze, treats a missing one as null and a malformed one as the defaults", () => {
    const base = { imageUpload: true, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false };
    expect(resolveCapabilities({ status: 200, data: { ...base, writeFreeze: { reason: "r", until: null, since: 1 } } }).writeFreeze).toEqual({ reason: "r", until: null, since: 1 });
    expect(resolveCapabilities({ status: 200, data: { ...base, writeFreeze: { reason: null, until: null, since: null } } }).writeFreeze).toEqual({ reason: null, until: null, since: null });
    expect(resolveCapabilities({ status: 200, data: base }).writeFreeze).toBeNull();
    expect(resolveCapabilities({ status: 200, data: { ...base, writeFreeze: null } }).writeFreeze).toBeNull();
    expect(resolveCapabilities({ status: 200, data: { ...base, writeFreeze: { reason: 1, until: null, since: 1 } } })).toEqual(DEFAULT_CAPABILITIES);
    expect(resolveCapabilities({ status: 200, data: { ...base, writeFreeze: "yes" } })).toEqual(DEFAULT_CAPABILITIES);
    expect(DEFAULT_CAPABILITIES.writeFreeze).toBeNull();
    // 配列は capabilities ではない(形の検査は parseCapabilities に分け、取り直しと共有する。レビュー r2 CX-Medium-6)
    expect(parseCapabilities([])).toBeNull();
    expect(resolveCapabilities({ status: 200, data: [] })).toEqual(DEFAULT_CAPABILITIES);
  });

  it("text: reason with a future resume time, no resume time, a passed resume time, unreadable, and before mount", () => {
    expect(writeFreezeBannerText({ reason: "v1.1 への更新", until: "2026-10-10T12:00:00+09:00", since: 1 }, NOW, TZ)).toBe("メンテナンス中のため、変更は保存できません。理由: v1.1 への更新。再開の見込み: 10/10 12:00");
    expect(writeFreezeBannerText({ reason: "v1.1 への更新", until: null, since: 1 }, NOW, TZ)).toBe("メンテナンス中のため、変更は保存できません。理由: v1.1 への更新");
    expect(writeFreezeBannerText({ reason: "v1.1 への更新", until: "2026-10-10T10:00:00+09:00", since: 1 }, NOW, TZ)).toBe("メンテナンス中のため、変更は保存できません。理由: v1.1 への更新。再開の見込み(10/10 10:00)を過ぎています。作業者に確認してください");
    expect(writeFreezeBannerText({ reason: null, until: null, since: null }, NOW, TZ)).toBe("メンテナンス中のため、変更は保存できません(凍結の設定が読めません。作業者に確認してください)");
    // マウント前(サーバーの描画)は時刻を含めない(ハイドレーションの食い違いを避ける)
    expect(writeFreezeBannerText({ reason: "v1.1 への更新", until: "2026-10-10T12:00:00+09:00", since: 1 }, null, TZ)).toBe("メンテナンス中のため、変更は保存できません。理由: v1.1 への更新");
    // 読めない until は無いものとして扱う
    expect(writeFreezeBannerText({ reason: "r", until: "garbage", since: 1 }, NOW, TZ)).toBe("メンテナンス中のため、変更は保存できません。理由: r");
  });

  // P17: 開いている画面のバナーは /capabilities を取り直して出す・消すを切り替える。取り直しが失敗・形が不正なら直前の表示を保つ(レビュー r1 CL-High-1)
  it("next state from a re-fetched /capabilities: follow freeze and thaw, keep the previous state on a failure or a malformed body", () => {
    const frozen = { reason: "r", until: null, since: 1 };
    const base = { imageUpload: true, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false };
    expect(nextWriteFreeze(null, { ...base, writeFreeze: frozen })).toEqual(frozen); // 凍結が入った
    expect(nextWriteFreeze(frozen, { ...base, writeFreeze: null })).toBeNull(); // 外れた
    expect(nextWriteFreeze(frozen, base)).toBeNull(); // 古い control(フィールドが無い)= 凍結していない
    expect(nextWriteFreeze(frozen, null)).toEqual(frozen); // 取り直しに失敗(呼び出し側が null を渡す)
    expect(nextWriteFreeze(frozen, "x")).toEqual(frozen);
    expect(nextWriteFreeze(frozen, { ...base, writeFreeze: { reason: 1 } })).toEqual(frozen); // 形が不正
    expect(nextWriteFreeze(frozen, { ...base, imageUpload: "yes" })).toEqual(frozen); // ほかのフィールドの型が不正 = 応答全体を信用しない(P12 と同じ規則。レビュー r2 CX-Medium-6)
    expect(nextWriteFreeze(frozen, { ...base, tagOrigin: 1 })).toEqual(frozen); // 7i の tagOrigin も同じ規則
    expect(nextWriteFreeze(frozen, [])).toEqual(frozen); // 配列
    expect(nextWriteFreeze(null, { ...base, writeFreeze: "yes" })).toBeNull();
  });
});
