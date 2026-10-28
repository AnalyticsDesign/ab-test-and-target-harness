import { describe, it, expect } from "vitest";
import {
  API_CONTRACT_VERSION, CLIENT_IP_HEADER, MIN_CLIENT_VERSION, MIN_CLIENT_VERSION_HEADER,
  MIN_CLIENT_VERSION_KEPT_BECAUSE, lowerClientVersion, parseClientVersion,
} from "../src/index";

describe("parseClientVersion", () => {
  it("名乗りなし(null)は null", () => {
    expect(parseClientVersion(null)).toBeNull();
  });
  it("正の整数はその数", () => {
    expect(parseClientVersion("1")).toBe(1);
    expect(parseClientVersion("12")).toBe(12);
  });
  it("形に合わない名乗りは 0", () => {
    expect(parseClientVersion("0")).toBe(0);
    expect(parseClientVersion("01")).toBe(0);
    expect(parseClientVersion("-1")).toBe(0);
    expect(parseClientVersion("1.5")).toBe(0);
    expect(parseClientVersion("abc")).toBe(0);
    expect(parseClientVersion(" 1")).toBe(0);
    expect(parseClientVersion("")).toBe(0);
    expect(parseClientVersion("1234567")).toBe(0); // 7 桁は上限超え
  });
});

describe("lowerClientVersion", () => {
  it("自分とブラウザの名乗りの小さいほう", () => {
    expect(lowerClientVersion(1, "1")).toBe(1);
    expect(lowerClientVersion(2, "1")).toBe(1);
    expect(lowerClientVersion(1, "2")).toBe(1);
  });
  it("ブラウザの名乗りがない・読めないときは 0", () => {
    expect(lowerClientVersion(1, null)).toBe(0);
    expect(lowerClientVersion(1, "x")).toBe(0);
  });
});

describe("版の定数", () => {
  it("MIN_CLIENT_VERSION は 1 で、契約の版以下", () => {
    expect(MIN_CLIENT_VERSION).toBe(1);
    expect(MIN_CLIENT_VERSION).toBeLessThanOrEqual(API_CONTRACT_VERSION);
  });
  it("MIN を契約の版より低く据え置くなら理由を書く", () => {
    // 定数どうしの比較は literal 型のままだと TS2367 になるので number として比べる
    expect((MIN_CLIENT_VERSION as number) === API_CONTRACT_VERSION ||MIN_CLIENT_VERSION_KEPT_BECAUSE.trim() !== "").toBe(true);
  });
  it("ヘッダー名", () => {
    expect(MIN_CLIENT_VERSION_HEADER).toBe("x-wtt-min-client-version");
    expect(CLIENT_IP_HEADER).toBe("x-wtt-client-ip");
  });
});
