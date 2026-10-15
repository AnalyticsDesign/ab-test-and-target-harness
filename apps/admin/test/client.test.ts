import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError, describeError, fieldErrors } from "@/lib/client";

/** ブラウザ側の薄い層。封筒(spec §13.5)の読み方だけを固定する */

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api()", () => {
  it("同一オリジンの /api/control だけを叩き、JSON body に content-type を付ける", async () => {
    fetchMock.mockResolvedValue(json(200, { id: "s1" }));
    await expect(api("PATCH", "/sites/s1", { name: "x" })).resolves.toEqual({ id: "s1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/control/sites/s1");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("FormData は content-type を付けない(boundary はブラウザに任せる)", async () => {
    fetchMock.mockResolvedValue(json(201, {}));
    const fd = new FormData();
    fd.set("file", new Blob(["x"]), "a.png");
    await api("POST", "/sites/s1/assets", fd);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeUndefined();
    expect(init.body).toBe(fd);
  });

  it("204 は null、非 2xx は封筒の code で ApiClientError", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api("DELETE", "/sites/s1")).resolves.toBeNull();
    fetchMock.mockResolvedValue(json(403, { error: "forbidden", message: "この操作を行う Role がありません", required: "admin" }));
    await expect(api("POST", "/sites/s1/publish")).rejects.toMatchObject({ status: 403, code: "forbidden", extra: { required: "admin" } });
  });

  it("body が JSON でない非 2xx でも http_<status> で落ちる", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 502 }));
    await expect(api("GET", "/me")).rejects.toMatchObject({ status: 502, code: "http_502" });
  });
});

describe("describeError()", () => {
  it("control の message と hint をそのまま出す", () => {
    const e = new ApiClientError(403, "forbidden", { error: "forbidden", message: "この操作を行う Role がありません", hint: "ADMIN 以上の Role が必要です" });
    expect(describeError(e)).toBe("この操作を行う Role がありません ADMIN 以上の Role が必要です");
  });

  it("message も hint も無い封筒だけ汎用文に落とす", () => {
    expect(describeError(new ApiClientError(500, "internal", {}))).toBe("エラーが発生しました(internal)");
  });

  it("ApiClientError 以外はその message", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});

describe("fieldErrors()", () => {
  it("422 の issues をフィールド名 → メッセージに畳む", () => {
    const e = new ApiClientError(422, "validation_failed", {
      error: "validation_failed",
      message: "Too big",
      path: ["name"],
      issues: [
        { path: ["name"], message: "Too big" },
        { path: ["analytics", "exposure", "event"], message: "Required" },
      ],
    });
    expect(fieldErrors(e)).toEqual({ name: "Too big", "analytics.exposure.event": "Required" });
  });

  it("issues が無い封筒は path 単体で拾う", () => {
    expect(fieldErrors(new ApiClientError(422, "name_too_long", { error: "name_too_long", message: "名前が長すぎます", path: ["variants", 0, "name"] }))).toEqual({
      "variants.0.name": "名前が長すぎます",
    });
  });

  it("封筒でなければ空", () => {
    expect(fieldErrors(new Error("boom"))).toEqual({});
  });

  it("path が配列でなく文字列でもクラッシュせず同じキーになる", () => {
    // control はいまどの 422 でも path を配列で返す(invalid_analytics / invalid_settings も
    // validationFailed() 経由になった)。これは契約の再現ではなく、配列以外が来ても
    // `.join` で落ちないという UI 境界の防御を固定するテスト
    const e = new ApiClientError(422, "invalid_analytics", { error: "invalid_analytics", message: "Invalid enum value", path: "exposure.event" });
    expect(fieldErrors(e)).toEqual({ "exposure.event": "Invalid enum value" });
  });
});
