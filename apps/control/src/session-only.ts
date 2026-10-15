import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./app";
import { carriesApiKey } from "./auth";
import { ApiError } from "./errors";

/**
 * backlog B42 / brief K17(大原則): **人とアクセス権の書き込みは、人が管理画面から行う**(API キーでは 403 `session_required`)。
 * API キーはサイト・エクスペリエンスの運用(作る・直す・公開する・読む)に使う。
 * これまで決定 48(鍵で鍵を管理させない)・決定 53 (10)(システム管理者の昇格・降格)と個別に決めてきたものを、ここ 1 か所に宣言する。
 * 理由: 漏れた鍵で、鍵を増やす・自分を招待して居座る・他人のパスワードを変える・ワークスペースを消す、を止める
 * (鍵を失効させても、増やした鍵・招待で入ったメンバー・変えたパスワードは残る)。読み取りは鍵でも使える。
 * 宣言の漏れは test/session-only.test.ts がルータの掃引で見つける。鍵の検証より前に断る(漏れた鍵でも、無効な鍵でも同じ 403)
 */
export const SESSION_ONLY: ReadonlyArray<{ method: "GET" | "POST" | "PATCH" | "DELETE" | "ALL"; path: string; hint: string }> = [
  // API キーの管理(決定 48)
  { method: "GET", path: "/me/api-keys", hint: "API キーの管理はセッション(管理画面)からのみ行えます" },
  { method: "POST", path: "/me/api-keys", hint: "API キーの管理はセッション(管理画面)からのみ行えます" },
  { method: "DELETE", path: "/me/api-keys/:kid", hint: "API キーの管理はセッション(管理画面)からのみ行えます" },
  { method: "GET", path: "/workspaces/:wid/api-keys", hint: "API キーの管理はセッション(管理画面)からのみ行えます" },
  { method: "DELETE", path: "/workspaces/:wid/api-keys/:kid", hint: "API キーの管理はセッション(管理画面)からのみ行えます" },
  // システム管理者(決定 53 (10))
  { method: "POST", path: "/instance-admins", hint: "システム管理者の追加・外すはセッション(管理画面)からのみ行えます" },
  { method: "DELETE", path: "/instance-admins/:userId", hint: "システム管理者の追加・外すはセッション(管理画面)からのみ行えます" },
  // ワークスペースの作成・削除
  { method: "POST", path: "/workspaces", hint: "ワークスペースの作成・削除はセッション(管理画面)からのみ行えます" },
  { method: "DELETE", path: "/workspaces/:wid", hint: "ワークスペースの作成・削除はセッション(管理画面)からのみ行えます" },
  // 使用状況の設定(見られる人 = アクセス権。同じ口の残りの項目もまとめて扱う)
  { method: "PATCH", path: "/usage/settings", hint: "使用状況の設定の変更はセッション(管理画面)からのみ行えます" },
  // メンバー・招待・パスワード
  { method: "PATCH", path: "/workspaces/:wid/members/:memberId", hint: "メンバーの変更はセッション(管理画面)からのみ行えます" },
  { method: "DELETE", path: "/workspaces/:wid/members/:memberId", hint: "メンバーの変更はセッション(管理画面)からのみ行えます" },
  { method: "POST", path: "/workspaces/:wid/members/:memberId/reset-link", hint: "リセットリンクの発行はセッション(管理画面)からのみ行えます" },
  { method: "POST", path: "/workspaces/:wid/invitations", hint: "招待の発行・取り消しはセッション(管理画面)からのみ行えます" },
  { method: "DELETE", path: "/workspaces/:wid/invitations/:id", hint: "招待の発行・取り消しはセッション(管理画面)からのみ行えます" },
  { method: "POST", path: "/invitations/:id/accept", hint: "招待の受諾は、Google でログインしてから管理画面で行ってください(API キーは使えません)" },
  // ログインとログイン状態(Better Auth のパススルー)
  { method: "ALL", path: "/auth/*", hint: "ログインとログイン状態の操作に API キーは使えません" },
];

/** 要求が API キー経由なら 403 `session_required`(各ルートの認証・検証より前に効かせる) */
export const refuseApiKey = (hint: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    // 鍵の形を広く取って断る(`Bearer` を付けない `Authorization: wtt_…` も。差分レビュー r2 の B1)
    if (carriesApiKey(c.req.raw.headers)) throw new ApiError(403, "session_required", { hint });
    await next();
  });
