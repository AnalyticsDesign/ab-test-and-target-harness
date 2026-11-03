// apps/control/test/client-version.test.ts
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { API_CONTRACT_VERSION, CLIENT_VERSION_HEADER, MIN_CLIENT_VERSION } from "@wtt/core";
import { ApiError, errorHandler } from "../src/errors";
import type { AppEnv } from "../src/app";
import { clientVersionGuard, clientVersionGuardFor } from "../src/client-version";
import { call, json, setupOwner } from "./helpers";

/**
 * 本体と同じ並び(凍結の判定の後・認証の前)の小さなアプリ。認証は「常に 401」の代わり(判定されたかどうかは 426 か 401 かで分かる)。
 * 最低の版を 2 にして、版 1 の古い管理画面を作る
 */
function appWithMin(min: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use("*", clientVersionGuardFor(min));
  app.use("*", async () => {
    throw new ApiError(401, "unauthorized");
  });
  return app;
}
const send = (app: Hono<AppEnv>, method: string, path: string, version?: string) =>
  app.request(`http://control.test${path}`, { method, headers: version === undefined ? {} : { [CLIENT_VERSION_HEADER]: version } }, env);

describe("client version guard (plan12 K4/K5)", () => {
  it("old_client_writes_get_426_and_reads_pass", async () => {
    const app = appWithMin(2);
    const old = await send(app, "POST", "/workspaces", "1");
    expect(old.status).toBe(426);
    expect(await json(old)).toEqual({
      error: "client_too_old",
      message: "管理画面が古い版です",
      hint: "管理画面ならページを再読み込みしてください(未保存の入力は消えるので、必要なら控えてから)。API を直接呼ぶクライアントは /openapi.json を読み直してから再試行してください",
      apiVersion: API_CONTRACT_VERSION,
      minClientVersion: 2,
      clientVersion: 1,
    });
    // 読み取りは判定されない(認証へ進んで 401)
    expect((await send(app, "GET", "/me", "1")).status).toBe(401);
    // ログインまわり・非常口・何も書かない POST は凍結と同じ一覧で通す
    for (const path of ["/auth/sign-out", "/break-glass/reset-link", "/sites/x/evaluate"]) {
      expect((await send(app, "POST", path, "1")).status, path).toBe(401);
    }
    // 最低の版以上は通る
    expect((await send(app, "POST", "/workspaces", "2")).status).toBe(401);
    expect((await send(app, "POST", "/workspaces", "3")).status).toBe(401);
  });

  it("unnamed_clients_are_not_judged", async () => {
    const app = appWithMin(2);
    expect((await send(app, "POST", "/workspaces")).status).toBe(401);
    // 形に合わない名乗りは 0 と数える = 古い
    const bad = await send(app, "POST", "/workspaces", "abc");
    expect(bad.status).toBe(426);
    expect((await json(bad)).clientVersion).toBe(0);
  });

  it("the real guard is built from MIN_CLIENT_VERSION", () => {
    expect(clientVersionGuard).toBeTypeOf("function");
    expect(MIN_CLIENT_VERSION).toBe(3);
  });

  it("freeze 503 wins over 426 in the real app", async () => {
    const { token } = await setupOwner();
    // 版 0(形に合わない名乗り)は本体の最低の版 1 より古い
    const old = await call("POST", "/workspaces", { token, headers: { [CLIENT_VERSION_HEADER]: "abc" }, body: { name: "x" } });
    expect(old.status).toBe(426);
    await env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('writeFreeze', '{\"reason\":\"r\"}', 1)").run();
    const frozen = await call("POST", "/workspaces", { token, headers: { [CLIENT_VERSION_HEADER]: "abc" }, body: { name: "x" } });
    expect(frozen.status).toBe(503);
    expect((await json(frozen)).error).toBe("write_frozen");
  });
});
