import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      resultsStore: false,
      writeFreeze: null,
      productVersion: null,
      apiVersion: null,
      minClientVersion: null,
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
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, edgeOrigin: null, edgeOnWorkersDev: true } })).toEqual({ imageUpload: true, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: true, passwordLogin: false, resultsStore: false, writeFreeze: null, productVersion: null, apiVersion: null, minClientVersion: null });
    // 決定 46: パスワード欄・リセットリンク・帯は「型が正しい true」だけで出す(型不正は応答全体を既定に倒す)
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, passwordLogin: "yes" } })).toEqual(DEFAULT_CAPABILITIES);
    expect(DEFAULT_CAPABILITIES).toEqual({ imageUpload: true, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false, resultsStore: false, writeFreeze: null, productVersion: null, apiVersion: null, minClientVersion: null });
    // tagOrigin が「存在するが型不正」なら応答全体を既定に倒す
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, tagOrigin: 1 } })).toEqual(DEFAULT_CAPABILITIES);
  });
  it("image_uploader_is_kept_only_when_the_body_has_a_boolean", () => {
    // B68: R2 なしの画像アップローダーの有無。古い control(フィールドなし)は undefined のまま(画面は false として扱う)
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false, imageUploader: true } }).imageUploader).toBe(true);
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false, imageUploader: false } }).imageUploader).toBe(false);
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false } }).imageUploader).toBeUndefined();
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false, imageUploader: "yes" } })).toEqual(DEFAULT_CAPABILITIES);
  });
  it("resultsStore_is_true_only_for_a_true_boolean_and_defaults_to_false", () => {
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, resultsStore: true } }).resultsStore).toBe(true);
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, resultsStore: false } }).resultsStore).toBe(false);
    // 古い control(フィールドなし)は既定の false
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true } }).resultsStore).toBe(false);
    // 型不正は応答全体を既定に倒す(結果の記録を誤って有効にできるように見せない)
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false, resultsStore: "yes" } })).toEqual(DEFAULT_CAPABILITIES);
    expect(DEFAULT_CAPABILITIES.resultsStore).toBe(false);
  });
  it("tagOrigin_is_passed_through_and_falls_back_to_edgeOrigin_for_old_control", () => {
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, edgeOrigin: "https://e.x", tagOrigin: "https://s.x" } }).tagOrigin).toBe("https://s.x");
    // 応答に tagOrigin が無い古い control では、設置タグは edge と同じホスト
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true, edgeOrigin: "https://e.x" } }).tagOrigin).toBe("https://e.x");
    expect(resolveCapabilities({ status: 200, data: { imageUpload: true } }).tagOrigin).toBeNull();
  });
  it("fills_missing_fields_with_defaults", () => {
    // 古い control(/capabilities に edgeOrigin が無い版)にも耐える
    expect(resolveCapabilities({ status: 200, data: { imageUpload: false } })).toEqual({ imageUpload: false, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false, resultsStore: false, writeFreeze: null, productVersion: null, apiVersion: null, minClientVersion: null });
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

import { nextCapabilities, versionBannerKind } from "../lib/capabilities";
import { startCapabilitiesPoll } from "../lib/capabilities-poll";

// plan12 K6: 管理画面の版(own)と control の /capabilities の版から、版のバナーの種類を決める
describe("versionBannerKind", () => {
  it("own 1 vs control api 1 / min 1: no banner", () => {
    expect(versionBannerKind(1, { apiVersion: 1, minClientVersion: 1 })).toBeNull();
  });
  it("own below min: incompatible (writes are refused)", () => {
    expect(versionBannerKind(1, { apiVersion: 2, minClientVersion: 2 })).toBe("incompatible");
  });
  it("own below api but not below min: outdated", () => {
    expect(versionBannerKind(1, { apiVersion: 2, minClientVersion: 1 })).toBe("outdated");
  });
  it("own above api: control_outdated", () => {
    expect(versionBannerKind(2, { apiVersion: 1, minClientVersion: 1 })).toBe("control_outdated");
  });
  it("no capabilities, or an old control without the numbers: no banner", () => {
    expect(versionBannerKind(1, null)).toBeNull();
    expect(versionBannerKind(1, { apiVersion: null, minClientVersion: null })).toBeNull();
    expect(versionBannerKind(1, { apiVersion: 2, minClientVersion: null })).toBeNull();
    expect(versionBannerKind(1, { apiVersion: null, minClientVersion: 2 })).toBeNull();
  });
});

describe("parseCapabilities: apiVersion / minClientVersion", () => {
  const base = { imageUpload: true, edgeOrigin: null, tagOrigin: null, edgeOnWorkersDev: false, passwordLogin: false };
  it("reads both numbers", () => {
    const c = parseCapabilities({ ...base, apiVersion: 3, minClientVersion: 2 });
    expect(c?.apiVersion).toBe(3);
    expect(c?.minClientVersion).toBe(2);
  });
  it("a missing number (old control) becomes null and the rest is kept", () => {
    expect(parseCapabilities(base)).toMatchObject({ apiVersion: null, minClientVersion: null, imageUpload: true });
    expect(parseCapabilities({ ...base, apiVersion: 3 })).toMatchObject({ apiVersion: 3, minClientVersion: null });
  });
  it("a wrongly typed number makes the whole body null", () => {
    expect(parseCapabilities({ ...base, apiVersion: "3", minClientVersion: 1 })).toBeNull();
    expect(parseCapabilities({ ...base, apiVersion: 3, minClientVersion: null })).toBeNull();
    expect(parseCapabilities({ ...base, apiVersion: Number.NaN, minClientVersion: 1 })).toBeNull();
  });
  it("nextCapabilities replaces on a good body and keeps the previous on a failure", () => {
    const prev = { ...DEFAULT_CAPABILITIES, apiVersion: 1, minClientVersion: 1 };
    expect(nextCapabilities(prev, { ...base, apiVersion: 2, minClientVersion: 2 })).toMatchObject({ apiVersion: 2, minClientVersion: 2 });
    expect(nextCapabilities(prev, null)).toBe(prev);
    expect(nextCapabilities(prev, { ...base, apiVersion: "x" })).toBe(prev);
  });
});

// 共有の取り直し: WriteFreezeBanner と VersionBanner が別々に取りに行かない(60 秒に 1 回)
describe("capabilities poll", () => {
  type Listener = () => void;
  const fakeDoc = () => {
    const listeners = new Set<Listener>();
    return {
      visibilityState: "visible" as string,
      addEventListener: (_t: "visibilitychange", l: Listener) => void listeners.add(l),
      removeEventListener: (_t: "visibilitychange", l: Listener) => void listeners.delete(l),
      fire: () => listeners.forEach((l) => l()),
      size: () => listeners.size,
    };
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fetches once per 60 s no matter how many banners read the result", async () => {
    const doc = fakeDoc();
    const fetchCaps = vi.fn(async () => ({}));
    const seen: unknown[] = [];
    // バナーが 2 つあっても、取得するのは CapabilitiesBanners が呼ぶ 1 回の poll だけ(ここでは poll を 1 つ起動して数える)
    const stop = startCapabilitiesPoll({ fetchCaps, onData: (d) => seen.push(d), doc });
    expect(fetchCaps).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchCaps).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCaps).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchCaps).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
    stop();
  });

  it("skips hidden tabs, refetches when the tab becomes visible, and a failure is passed as null", async () => {
    const doc = fakeDoc();
    const fetchCaps = vi.fn(async () => {
      throw new Error("down");
    });
    const seen: unknown[] = [];
    const stop = startCapabilitiesPoll({ fetchCaps, onData: (d) => seen.push(d), doc });
    doc.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchCaps).toHaveBeenCalledTimes(0);
    doc.fire(); // 隠れたままの visibilitychange では取らない
    expect(fetchCaps).toHaveBeenCalledTimes(0);
    doc.visibilityState = "visible";
    doc.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCaps).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([null]); // 失敗は null(呼び出し側が直前の表示を保つ)
    stop();
  });

  it("stop() clears the timer and the listener, and drops a response that arrives after it", async () => {
    const doc = fakeDoc();
    let resolve!: (v: unknown) => void;
    const fetchCaps = vi.fn(() => new Promise<unknown>((r) => (resolve = r)));
    const seen: unknown[] = [];
    const stop = startCapabilitiesPoll({ fetchCaps, onData: (d) => seen.push(d), doc });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchCaps).toHaveBeenCalledTimes(1);
    stop();
    expect(doc.size()).toBe(0);
    resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchCaps).toHaveBeenCalledTimes(1);
  });

  // B146: 60 秒ごとの取得とタブを戻したときの取得が前後しても、古い応答で帯を古い表示に戻さない(最後に出した要求の応答だけ渡す)
  describe("overlapping requests", () => {
    /** 要求ごとに、応答の時機を試験が決められる fetchCaps */
    const deferredFetch = () => {
      const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
      const fetchCaps = vi.fn(() => new Promise<unknown>((resolve, reject) => pending.push({ resolve, reject })));
      /** i 番目(0 始まり)に出した要求 */
      const req = (i: number) => {
        const p = pending[i];
        if (!p) throw new Error(`request ${i} was not sent`);
        return p;
      };
      return { fetchCaps, req };
    };
    /** 2 回取りに行かせる(1 回目は 60 秒ごとの取得、2 回目はタブが前に戻ったときの取得) */
    const startTwo = async (fetchCaps: () => Promise<unknown>, seen: unknown[]) => {
      const doc = fakeDoc();
      const stop = startCapabilitiesPoll({ fetchCaps, onData: (d) => seen.push(d), doc });
      await vi.advanceTimersByTimeAsync(60_000);
      doc.fire();
      return stop;
    };

    it("drops an earlier request's response that arrives after the later request's", async () => {
      const { fetchCaps, req } = deferredFetch();
      const seen: unknown[] = [];
      const stop = await startTwo(fetchCaps, seen);
      expect(fetchCaps).toHaveBeenCalledTimes(2);
      req(1).resolve({ n: 2 });
      await vi.advanceTimersByTimeAsync(0);
      req(0).resolve({ n: 1 }); // 先に出した要求の応答が後から着く
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([{ n: 2 }]);
      stop();
    });

    it("passes the later request's response and drops the earlier one even when the earlier arrives first", async () => {
      const { fetchCaps, req } = deferredFetch();
      const seen: unknown[] = [];
      const stop = await startTwo(fetchCaps, seen);
      req(0).resolve({ n: 1 }); // 新しい要求を出した後なので、先に着いても渡さない
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([]);
      req(1).resolve({ n: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([{ n: 2 }]);
      stop();
    });

    it("a failure (null) is passed only for the latest request: an earlier failure is dropped", async () => {
      const { fetchCaps, req } = deferredFetch();
      const seen: unknown[] = [];
      const stop = await startTwo(fetchCaps, seen);
      req(1).resolve({ n: 2 });
      await vi.advanceTimersByTimeAsync(0);
      req(0).reject(new Error("down")); // 古い要求の失敗は渡さない
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([{ n: 2 }]);
      stop();
    });

    it("a failure (null) is passed only for the latest request: the latest failure is passed as null", async () => {
      const { fetchCaps, req } = deferredFetch();
      const seen: unknown[] = [];
      const stop = await startTwo(fetchCaps, seen);
      req(0).resolve({ n: 1 });
      req(1).reject(new Error("down"));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([null]); // 呼び出し側が直前の表示を保つ
      stop();
    });

    it("stop() drops the responses of every request still in flight", async () => {
      const { fetchCaps, req } = deferredFetch();
      const seen: unknown[] = [];
      const stop = await startTwo(fetchCaps, seen);
      stop();
      req(1).resolve({ n: 2 });
      req(0).resolve({ n: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([]);
    });
  });
});

// 取得を 1 回にする構造: /capabilities を取りに行くのは useCapabilitiesPoll だけで、CapabilitiesBanners がそれを 1 回呼んで 2 つの帯に値を渡す
describe("capabilities banners structure", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (f: string) => strip(readFileSync(path.join(import.meta.dirname, "..", f), "utf8"));
  it("only the poll hook fetches /capabilities; CapabilitiesBanners calls it once and feeds both banners", () => {
    expect(read("components/useCapabilitiesPoll.ts")).toMatch(/startCapabilitiesPoll\(/);
    const banners = read("components/CapabilitiesBanners.tsx");
    expect(banners.match(/useCapabilitiesPoll\(/g)).toHaveLength(1);
    expect(banners).toMatch(/<WriteFreezeBanner\b/);
    expect(banners).toMatch(/<VersionBanner\b/);
    for (const f of ["components/WriteFreezeBanner.tsx", "components/VersionBanner.tsx"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/useCapabilitiesPoll|from "@\/lib\/client"|\bapi\(|fetch\(/);
    }
    // layout は CapabilitiesBanners だけを置く(帯を直接置くと取得が増える)
    const layout = read("app/w/layout.tsx");
    expect(layout).toMatch(/<CapabilitiesBanners\b/);
    expect(layout).not.toMatch(/<WriteFreezeBanner\b|<VersionBanner\b/);
  });
});
