/**
 * User-Agent からの分類(端末・ブラウザ・OS)。runtime(ブラウザで判定する)と control の evaluate が同じ関数を使う。zod を使わない。
 * 端末は spec §6.1(2026-09-01 決定)のまま runtime から移した。ブラウザ・OS は決定 49(設計書 §9): 名前は GA4 にそろえるが、
 * GA4 の分類には厳密に合わせない。edge は判定しない(runtime が decision の body で送る値をそのまま使う)
 */
export const DEVICES = ["mobile", "tablet", "desktop"] as const;
export const BROWSERS = ["chrome", "safari", "edge", "firefox", "samsung", "other"] as const;
export const OSES = ["ios", "android", "windows", "macos", "chromeos", "linux", "other"] as const;
export type Device = (typeof DEVICES)[number];
export type Browser = (typeof BROWSERS)[number];
export type Os = (typeof OSES)[number];

/**
 * spec §6.1(2026-09-01 決定): device は **User-Agent のみ**から判定する。viewport も maxTouchPoints も使わない —
 * GA4 の device category は UA から決まるため、幅を混ぜるとツールの mobile 群と GA4 の mobile 群がずれ、
 * `ab_exposure` でセグメントを切る分析レシピが成立しなくなる。
 * 判定順は tablet → mobile → desktop で固定(iPad の Safari は UA に `Mobile/15E148` を含むため)
 */
export function detectDevice(ua: string): Device {
  if (/iPad|Tablet|Silk/i.test(ua)) return "tablet"; // iPad / Firefox on Android タブレット / Amazon Fire
  if (/Android/i.test(ua) && !/Mobi/i.test(ua)) return "tablet"; // Chrome on Android タブレットは Mobile トークンを付けない
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return "mobile";
  return "desktop"; // iPadOS のデスクトップ表示(Macintosh UA)もここ。GA4 と同じ分類にする
}

/**
 * 判定順は Edge → Samsung Internet → Firefox → Chrome(別ブランドの印があればその他)→ Safari(`Version/` 付き)→ その他。
 * iOS 上の Chrome(CriOS)/ Firefox(FxiOS)/ Edge(EdgiOS)は、エンジンは WebKit でもブランドで分ける
 */
export function detectBrowser(ua: string): Browser {
  if (/Edg(?:iOS|A)?\//.test(ua)) return "edge";
  if (/SamsungBrowser\//.test(ua)) return "samsung";
  if (/Firefox\/|FxiOS\//.test(ua)) return "firefox";
  // Chromium 系の別ブランド(Opera・Yandex・Vivaldi・Whale・UC・DuckDuckGo)は Chrome に数えない
  if (/Chrome\/|CriOS\//.test(ua)) return /OPR\/|OPT\/|YaBrowser\/|Vivaldi\/|Whale\/|UCBrowser\/|DuckDuckGo\//.test(ua) ? "other" : "chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "safari";
  return "other";
}

/** 判定順は iOS → Android → Windows → ChromeOS → macOS → Linux → その他。iPadOS のデスクトップ表示(Macintosh UA)は macOS(端末の判定と同じ扱い) */
export function detectOs(ua: string): Os {
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Macintosh/.test(ua)) return "macos";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}
