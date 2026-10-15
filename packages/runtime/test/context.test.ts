import { expect, it } from "vitest";
import { collectContext, detectDevice } from "../src/context";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const FIREFOX_ANDROID_TABLET = "Mozilla/5.0 (Android 14; Tablet; rv:130.0) Gecko/130.0 Firefox/130.0";
const FIRE_TABLET = "Mozilla/5.0 (Linux; Android 9; KFTRWI) AppleWebKit/537.36 Silk/119.1 like Chrome/119 Safari/537.36";
const IPADOS_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15"; // iPadOS 13+ のデスクトップ表示
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36";

it("detects device from the user agent alone (spec §6.1 の判定表)", () => {
  expect(detectDevice(IPHONE)).toBe("mobile");
  expect(detectDevice(ANDROID_PHONE)).toBe("mobile");
  expect(detectDevice(IPAD)).toBe("tablet");                   // Mobile/15E148 を含むが tablet を先に見る
  expect(detectDevice(ANDROID_TABLET)).toBe("tablet");         // Android で Mobi トークンなし
  expect(detectDevice(FIREFOX_ANDROID_TABLET)).toBe("tablet"); // Tablet トークン
  expect(detectDevice(FIRE_TABLET)).toBe("tablet");            // Silk
  expect(detectDevice(IPADOS_DESKTOP)).toBe("desktop");        // GA4 と同じ分類(touch points で補正しない)
  expect(detectDevice(MAC)).toBe("desktop");
});

it("viewport width never changes the device classification (spec §6.1、2026-09-01 決定)", () => {
  // ウィンドウを狭めた desktop は desktop のまま。幅を混ぜると GA4 の device category と母集団がずれる
  expect(detectDevice(MAC)).toBe("desktop");
  const { ctx, viewport } = collectContext({ url: "https://site.test/", referrer: "", userAgent: MAC, width: 380, height: 800, hasViewportMeta: true, now: 1 });
  expect(ctx.device).toBe("desktop");
  expect(viewport).toEqual({ w: 380, h: 800 }); // 判定には使わないが decision body では送る(§9.1)
});

it("collects url, query, referrer, browser / os, viewport and the decision time (spec §10.1 / 決定 49 §11.1)", () => {
  const { ctx, viewport } = collectContext({
    url: "https://site.test/pricing?utm=x&b=2", referrer: "https://google.com/",
    userAgent: MAC, width: 1440, height: 900, hasViewportMeta: true, now: 1_700_000_000_000, firstVisitAt: 1_690_000_000_000,
  });
  expect(ctx).toEqual({
    url: "https://site.test/pricing?utm=x&b=2", query: { utm: "x", b: "2" }, device: "desktop", browser: "chrome", os: "macos",
    referrer: "https://google.com/", now: 1_700_000_000_000, viewportWidth: 1440, firstVisitAt: 1_690_000_000_000,
  });
  expect(viewport).toEqual({ w: 1440, h: 900 });
});

it("viewport の meta が無い時点の幅は不明(判定にも decision の body にも使わない。決定 49 §11)", () => {
  const { ctx, viewport } = collectContext({ url: "https://site.test/", referrer: "", userAgent: IPHONE, width: 980, height: 1800, hasViewportMeta: false, now: 1 });
  expect(ctx.viewportWidth).toBeUndefined();
  expect(viewport).toBeNull();
});

it("firstVisitAt は与えられたときだけ入れる(null = 発行時刻が不明は入れる)", () => {
  const base = { url: "https://site.test/", referrer: "", userAgent: MAC, width: 1, height: 1, hasViewportMeta: true, now: 1 };
  expect("firstVisitAt" in collectContext(base).ctx).toBe(false);
  expect(collectContext({ ...base, firstVisitAt: null }).ctx.firstVisitAt).toBeNull();
});
