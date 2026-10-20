// apps/control/src/client-version.ts
import { createMiddleware } from "hono/factory";
import { API_CONTRACT_VERSION, CLIENT_VERSION_HEADER, MIN_CLIENT_VERSION, parseClientVersion } from "@wtt/core";
import type { AppEnv } from "./app";
import { ApiError } from "./errors";
import { isWriteGateExempt } from "./write-freeze";

/**
 * plan12 K4/K5: 古い管理画面(API クライアント)の書き込みを断る。
 * 判定するのは書き込みだけ(読み取りと、ログインまわり・非常口・何も書かない POST は凍結と同じ一覧 `isWriteGateExempt` で通す)。
 * 名乗り(CLIENT_VERSION_HEADER)が無いクライアントは判定しない(curl・エージェント)。形に合わない名乗りは版 0 = 古いとして断る。
 * 並びは「凍結の判定の後・認証の前」: 凍結中は 503 が先に返り、認証していない古いクライアントにも 426 が返る
 */
export const CLIENT_TOO_OLD_MESSAGE = "管理画面が古い版です";
export const CLIENT_TOO_OLD_HINT =
  "管理画面ならページを再読み込みしてください(未保存の入力は消えるので、必要なら控えてから)。API を直接呼ぶクライアントは /openapi.json を読み直してから再試行してください";

/** 最低の版を引数にして作る(テストが本体の版を動かさずに古いクライアントを作れるように) */
export function clientVersionGuardFor(min: number) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (isWriteGateExempt(c.req.method, new URL(c.req.url).pathname)) return next();
    const own = parseClientVersion(c.req.header(CLIENT_VERSION_HEADER) ?? null);
    if (own !== null && own < min) {
      throw new ApiError(426, "client_too_old", {
        message: CLIENT_TOO_OLD_MESSAGE,
        hint: CLIENT_TOO_OLD_HINT,
        apiVersion: API_CONTRACT_VERSION,
        minClientVersion: min,
        clientVersion: own,
      });
    }
    await next();
  });
}

export const clientVersionGuard = clientVersionGuardFor(MIN_CLIENT_VERSION);
