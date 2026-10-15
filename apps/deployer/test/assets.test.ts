import { describe, expect, it } from "vitest";
import { assetHash, manifestKey, toBase64 } from "../src/assets";

describe("assets", () => {
  it("toBase64 は UTF-8 のバイト列を base64 にし、size はバイト数", () => {
    expect(toBase64("hello")).toEqual({ b64: "aGVsbG8=", size: 5 });
    expect(toBase64("あ")).toEqual({ b64: "44GC", size: 3 }); // 設定に日本語の名前が入る
  });
  it("toBase64 は大きな文字列(引数の上限を超える長さ)でも落ちない", () => {
    const big = "x".repeat(300_000);
    const { b64, size } = toBase64(big);
    expect(size).toBe(300_000);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(big);
  });
  it("assetHash は wrangler と同じ(SHA-256(base64 + 拡張子) の先頭 32 桁)", async () => {
    // node -e で計算した値: sha256("aGVsbG8=" + "js").slice(0, 32)
    expect(await assetHash("aGVsbG8=", "js")).toBe("5d81cb7e2afd1222f0934e57f4fb0db8");
  });
  it("manifestKey はキーの順序に依存しない", () => {
    const a = { "/s/a.js": { hash: "h1", size: 1 }, "/s/b.js": { hash: "h2", size: 2 } };
    const b = { "/s/b.js": { hash: "h2", size: 2 }, "/s/a.js": { hash: "h1", size: 1 } };
    expect(manifestKey(a)).toBe(manifestKey(b));
    expect(manifestKey(a)).not.toBe(manifestKey({ ...a, "/s/a.js": { hash: "h9", size: 1 } }));
  });
});
