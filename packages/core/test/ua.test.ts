import { describe, expect, it } from "vitest";
import { detectBrowser, detectDevice, detectOs } from "../src/ua";

/** 代表的な User-Agent と期待値(決定 49、設計書 §9 の判定表)。runtime と control の evaluate が同じ関数を使う */
const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1",
  iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
  iphoneEdge: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/140.3485.94 Mobile/15E148 Safari/605.1.15",
  ipadSafari: "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  ipadosDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  androidSamsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  androidEdge: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0",
  androidOpera: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/91.0.0.0",
  androidWebView: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36",
  androidLine: "Mozilla/5.0 (Linux; Android 14; SM-S921Q Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Line/14.16.0/IAB",
  iphoneLine: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.16.0",
  winChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  winEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  winFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  winOpera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/122.0.0.0",
  winYandex: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 YaBrowser/25.8.0.0 Safari/537.36",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  empty: "",
};

describe("detectBrowser / detectOs(設計書 §9)", () => {
  it.each([
    ["iphoneSafari", "safari", "ios", "mobile"],
    ["iphoneChrome", "chrome", "ios", "mobile"], // iOS 上の Chrome はブランドで分ける
    ["iphoneFirefox", "firefox", "ios", "mobile"],
    ["iphoneEdge", "edge", "ios", "mobile"],
    ["ipadSafari", "safari", "ios", "tablet"],
    ["ipadosDesktop", "safari", "macos", "desktop"], // iPadOS のデスクトップ表示は macOS(端末の判定と同じ扱い)
    ["androidChrome", "chrome", "android", "mobile"],
    ["androidSamsung", "samsung", "android", "mobile"], // Chrome/ を含むが Samsung を先に見る
    ["androidEdge", "edge", "android", "mobile"],
    ["androidFirefox", "firefox", "android", "mobile"],
    ["androidOpera", "other", "android", "mobile"], // Chromium の別ブランドは Chrome に数えない
    ["androidWebView", "chrome", "android", "mobile"], // アプリ内ブラウザ・WebView は今の判定順のまま(ユーザー決定 2026-10-02)
    ["androidLine", "chrome", "android", "mobile"],
    ["iphoneLine", "other", "ios", "mobile"], // iOS は Version/ が無ければその他
    ["winChrome", "chrome", "windows", "desktop"],
    ["winEdge", "edge", "windows", "desktop"],
    ["winFirefox", "firefox", "windows", "desktop"],
    ["winOpera", "other", "windows", "desktop"],
    ["winYandex", "other", "windows", "desktop"],
    ["macChrome", "chrome", "macos", "desktop"],
    ["chromeos", "chrome", "chromeos", "desktop"],
    ["linuxFirefox", "firefox", "linux", "desktop"],
    ["googlebot", "other", "other", "desktop"],
    ["empty", "other", "other", "desktop"],
  ] as const)("%s → %s / %s / %s", (key, browser, os, device) => {
    expect(detectBrowser(UA[key])).toBe(browser);
    expect(detectOs(UA[key])).toBe(os);
    expect(detectDevice(UA[key])).toBe(device);
  });
});
