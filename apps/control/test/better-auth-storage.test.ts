import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAuth } from "../src/auth";
import type { Env } from "../src/env";
import { applyControlMigrations, resetStorage } from "./apply-migrations";
import {
  BREAK_GLASS,
  BREAK_GLASS_PASSWORD,
  call,
  googleSignIn,
  inviteAndJoin,
  joinWithPassword,
  json,
  sessionTokenOf,
  setupOwner,
  uniqueEmail,
} from "./helpers";

/**
 * B179 Task 4(B128 ①): better-auth の挙動のうち、control が「そうなっている」ことに頼っている所を固定する(最初は 1.4.21 で書き、
 * B179 Task 6〜9 で 1.7.15 でも同じ形であることを確かめた。今後の版上げでも見張る)。ただし unverified_password_user_google_link は、Task 6(1.7)で意図して挙動を変えた形を見る。
 * キー・セッション・招待・Google の結びつきにまたがるので、api-keys.test.ts には足さず独立したファイルにしている
 */

/** パスワードと Google の往復を通すので、全体を流す負荷の下では既定の 5 秒を超えうる */
const TIMEOUT = 20_000;

describe("better-auth behaviours the upgrade must keep (B128, B179)", () => {
  it("apikey_storage_format_b128", async () => {
    // apikey の行の列の形。control は metadata を JSON.parse で読み(roleCap / keyScope / 期限。api-key-scope.ts / api-key-expiry.ts)、
    // 時刻は ISO 文字列・期限の列は NULL という前提で動く。版を上げて保存の形が変わると、行を直接読む所が壊れる
    const owner = await setupOwner();
    const made = await json<{ id: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "format", workspaceId: owner.workspaceId } }));
    const row = await env.DB.prepare(`select "userId", createdAt, updatedAt, enabled, metadata, expiresAt, typeof(createdAt) as ct, typeof(updatedAt) as ut, typeof(enabled) as et, typeof(metadata) as mt from apikey where id = ?`)
      .bind(made.id)
      .first<{ userId: string; createdAt: unknown; updatedAt: unknown; enabled: unknown; metadata: unknown; expiresAt: unknown; ct: string; ut: string; et: string; mt: string }>();
    expect(row).not.toBeNull();
    // 持ち主 = "userId" の列(B179 D2: 1.7 の referenceId をこの列に読み替える)
    expect(row!.userId).toBe(owner.userId);
    // 時刻 = ISO 8601 の文字列(epoch ミリ秒の数値ではない)
    for (const [value, type] of [[row!.createdAt, row!.ct], [row!.updatedAt, row!.ut]] as const) {
      expect(type).toBe("text");
      expect(new Date(value as string).toISOString()).toBe(value);
    }
    // enabled = 整数の 1(boolean は D1 では 0 / 1)
    expect(row!.et).toBe("integer");
    expect(row!.enabled).toBe(1);
    // metadata = JSON のオブジェクトを 1 回だけ文字列にしたもの(二重にエンコードされていない)
    expect(row!.mt).toBe("text");
    const parsed: unknown = JSON.parse(row!.metadata as string);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed)).toBe(false);
    // 期限は Better Auth の列に入れない(B43: metadata に持つ。入れると期限切れの鍵が失効の記録ごと消される)
    expect(row!.expiresAt).toBeNull();
  }, TIMEOUT);

  it("api_key_session_id_is_key_row_id_b33", async () => {
    // app.ts の requireSession が、鍵経由の getSession の session.id を apikey の行の id として使う(上限・失効・範囲の照会の鍵)。
    // 版を上げて session.id の意味が変わると、すべての API キーが 401 になる
    const owner = await setupOwner();
    const made = await json<{ id: string; key: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "session-id", workspaceId: null } }));
    const auth = getAuth(env as unknown as Env);
    // x-api-key と Authorization: Bearer wtt_… のどちらでも同じ(apiKeyFromHeaders が受ける 2 通り)
    for (const headers of [new Headers({ "x-api-key": made.key }), new Headers({ authorization: `Bearer ${made.key}` })]) {
      const session = await auth.api.getSession({ headers });
      expect(session, [...headers.keys()].join()).not.toBeNull();
      expect(session!.session.id).toBe(made.id);
      expect(session!.user.id).toBe(owner.userId);
    }
    // 通常のセッションの id は session 表の行の id(鍵の id ではない)
    const normal = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${owner.token}` }) });
    expect(normal).not.toBeNull();
    expect(normal!.session.id).not.toBe(made.id);
  }, TIMEOUT);

  it("password_user_can_accept_invitation_b179", async () => {
    // D9 の見張り: 非常口を開け、招待 → パスワードで sign-up → 受諾が 200 になり、所属ができる。
    // joinWithPassword が受諾の 200 を確かめるので、ここでは受諾の結果(所属・未確認のまま)を見る
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner, "editor");
    const member = await env.DB.prepare(`select role from member where "userId" = ? and "organizationId" = ?`).bind(pw.userId, owner.workspaceId).first<{ role: string }>();
    expect(member?.role).toBe("editor");
    const user = await env.DB.prepare(`select "emailVerified" as v from "user" where id = ?`).bind(pw.userId).first<{ v: number }>();
    expect(user?.v).toBe(0); // パスワードで作った人は確かめられていない(次のテストの前提)
  }, TIMEOUT);

  it("unverified_password_user_google_link", async () => {
    // B179(GHSA-g38m の修正の確かめ): パスワードで作った人(emailVerified = 0)が同じメールの Google(検証済み)でログインしても、
    // 1.7 は既存の user に結びつけない(accountLinking.requireLocalEmailVerified の既定 true)。1.4.21 は結びつけてログインさせ、
    // emailVerified を 1 にしていた(このテストの前の形)。戻り先は /login?error=account_not_linked で、セッション・token は作られない
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner, "editor"); // setupOwner の人は確認済みなので使わない
    const googleAccounts = () => env.DB.prepare(`select count(*) as n from account where "userId" = ? and "providerId" = 'google'`).bind(pw.userId).first<{ n: number }>();
    const sessions = () => env.DB.prepare(`select count(*) as n from session where "userId" = ?`).bind(pw.userId).first<{ n: number }>();
    expect((await googleAccounts())?.n).toBe(0);
    const sessionsBefore = (await sessions())?.n;

    const { token, location } = await googleSignIn(pw.email);
    expect(token).toBeNull();
    const back = new URL(location);
    expect(`${back.origin}${back.pathname}`).toBe("http://localhost:3000/login"); // wrangler.jsonc の AB_ADMIN_URL
    expect(back.searchParams.get("error")).toBe("account_not_linked");
    expect(back.searchParams.has("code")).toBe(false);
    expect(back.searchParams.has("error_description")).toBe(false);
    expect((await googleAccounts())?.n).toBe(0); // 結びつかない
    expect((await sessions())?.n).toBe(sessionsBefore); // セッションは増えない
    expect(await env.DB.prepare(`select count(*) as n from "user" where lower(email) = lower(?)`).bind(pw.email).first<{ n: number }>()).toEqual({ n: 1 }); // 新しい user も作られない
    expect(await env.DB.prepare(`select "emailVerified" as v from "user" where id = ?`).bind(pw.userId).first()).toEqual({ v: 0 });
  }, TIMEOUT);

  it("new_key_row_keeps_user_id_column_b179", async () => {
    // D2: 1.7 のプラグインの持ち主(referenceId)は "userId" の列に読み替える。configId は既定の設定の名前
    const owner = await setupOwner();
    const made = await json<{ id: string }>(await call("POST", "/me/api-keys", { token: owner.token, body: { name: "owner-col", workspaceId: owner.workspaceId } }));
    const row = await env.DB.prepare(`select "userId", "configId" from apikey where id = ?`).bind(made.id).first<{ userId: string; configId: string }>();
    expect(row).toEqual({ userId: owner.userId, configId: "default" });
    // 列は 0001 のまま(referenceId の列は作らない)
    const cols = (await env.DB.prepare(`select name from pragma_table_info('apikey')`).all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).toContain("userId");
    expect(cols).not.toContain("referenceId");
  }, TIMEOUT);

  it("user_delete_cascades_api_keys_b179", async () => {
    // D2: "userId" の列の外部キー(references "user" on delete cascade)が残っている。user を消すと鍵の行も消える
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const made = await json<{ id: string }>(await call("POST", "/me/api-keys", { token: ed.token, body: { name: "cascade", workspaceId: owner.workspaceId } }));
    const keys = () => env.DB.prepare(`select count(*) as n from apikey where id = ?`).bind(made.id).first<{ n: number }>();
    expect((await keys())?.n).toBe(1);
    await env.DB.prepare(`delete from "user" where id = ?`).bind(ed.userId).run();
    expect((await keys())?.n).toBe(0);
  }, TIMEOUT);

  it("legacy_key_still_works_after_migration_b179", async () => {
    // マイグレーション 0025 の前に 1.4.21 が書いた形の鍵の行(configId の列が無い)を入れ、0025 を当てた後に 1.7 でその鍵が通る。
    // 鍵の hash は 1.4.21 の defaultKeyHasher(SHA-256 → base64url・padding なし)をここで独立に計算する
    // (1.7 の hash の関数を使うと、将来 hash の形が変わったときに気づけない)
    await resetStorage({ before: "0025" });
    expect((await env.DB.prepare(`select name from pragma_table_info('apikey') where name = 'configId'`).all()).results).toHaveLength(0);
    const owner = await setupOwner();
    const hash = async (key: string) =>
      btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const now = new Date().toISOString();
    // 平文は接頭辞 + 64 文字(1.4.21 の既定の長さ。プラグインは defaultKeyLength(64)より短い鍵を照会の前に断る)
    const legacy = [
      { id: "legacy-key-default", key: `wtt_${"legacyDefaultConfig".padEnd(64, "0")}` },
      { id: "legacy-key-empty", key: `wtt_${"legacyEmptyConfigId".padEnd(64, "1")}` },
    ];
    for (const k of legacy) {
      // 1.4.21 の createApiKey が書く列(rateLimit は control の設定 enabled: false のときの既定の値)
      await env.DB.prepare(
        `insert into apikey (id, name, start, prefix, key, "userId", "refillInterval", "refillAmount", "lastRefillAt", enabled, "rateLimitEnabled",
           "rateLimitTimeWindow", "rateLimitMax", "requestCount", remaining, "lastRequest", "expiresAt", "createdAt", "updatedAt", permissions, metadata)
         values (?1, 'legacy', ?2, 'wtt_', ?3, ?4, null, null, null, 1, 0, 86400000, 10, 0, null, null, null, ?5, ?5, null, ?6)`,
      )
        .bind(k.id, k.key.slice(0, 6), await hash(k.key), owner.userId, now, JSON.stringify({ scope: "workspace", workspaceId: owner.workspaceId, expiresAt: null }))
        .run();
    }
    await applyControlMigrations();
    const rows = (await env.DB.prepare(`select id, "configId" from apikey order by id`).all<{ id: string; configId: string }>()).results;
    expect(rows).toEqual([
      { id: "legacy-key-default", configId: "default" },
      { id: "legacy-key-empty", configId: "default" },
    ]);
    // configId が空文字の行(既定の設定として扱われる。isDefaultConfigId)
    await env.DB.prepare(`update apikey set "configId" = '' where id = 'legacy-key-empty'`).run();
    for (const k of legacy) {
      const me = await call("GET", "/me", { token: k.key });
      expect(me.status, k.id).toBe(200);
      expect((await json<{ email: string }>(me)).email).toBe(owner.email);
    }
  }, TIMEOUT);

  it("missing_column_does_not_take_down_auth_b179", () => {
    // D13 の見張り: 1.7 の実行時の表の形の検査を切っている(オンだと、列が 1 本足りないだけでログイン・鍵の検証の全経路が例外になる)。
    // 列を実際に消すと D1 の他のテストを壊すので、設定の値を見る
    const options = (getAuth(env as unknown as Env) as unknown as { options: { advanced?: { database?: { validateSchema?: unknown } } } }).options;
    expect(options.advanced?.database?.validateSchema).toBe(false);
  });

  it("hooks_see_endpoint_path_on_1_7_b179", async () => {
    // 1.7 の databaseHooks は endpoint の文脈を AsyncLocalStorage から受け取る。取れないと ctx が null になり、
    // user.create.before が「招待が無い」で全員を断り、セッションの印(loginMethod)が null になる
    const owner = await setupOwner();
    // 招待の無い人は断られ(/callback/google の path を見て allowlist の外として検査される)、招待のある人は入れる
    const stranger = uniqueEmail("stranger");
    const refused = await googleSignIn(stranger);
    expect(refused.token).toBeNull();
    expect(new URL(refused.location).searchParams.get("error")).toBe("not_invited");
    const invited = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    // セッションの印: Google = /callback/google、パスワード = /sign-up/email・/sign-in/email
    const methodOf = async (bearer: string) =>
      (await env.DB.prepare(`select "loginMethod" as m from session where token = ?`).bind(sessionTokenOf(bearer)).first<{ m: string | null }>())?.m;
    expect(await methodOf(invited.token)).toBe("google");
    const pw = await joinWithPassword(owner);
    expect(await methodOf(pw.token)).toBe("password");
    const signIn = await call("POST", "/auth/sign-in/email", { body: { email: pw.email, password: BREAK_GLASS_PASSWORD }, headers: { origin: "http://localhost:3000" }, envOverride: BREAK_GLASS });
    expect(signIn.status).toBe(200);
    expect(await methodOf(signIn.headers.get("set-auth-token")!)).toBe("password");
  }, TIMEOUT);

  it("origin_check_on_email_sign_in_b179", async () => {
    // 1.6 から、メールのサインインは Cookie が無くても Origin を trustedOrigins(= AB_ADMIN_URL)と照らす。
    // 管理画面の BFF はブラウザの Origin(requireOrigin で管理画面自身と確かめたもの)をそのまま渡す
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    const signIn = (headers: Record<string, string>) =>
      call("POST", "/auth/sign-in/email", { body: { email: pw.email, password: BREAK_GLASS_PASSWORD }, headers, envOverride: BREAK_GLASS });
    expect((await signIn({ origin: "http://localhost:3000" })).status).toBe(200);
    expect((await signIn({ origin: "https://evil.example" })).status).toBe(403);
  }, TIMEOUT);

  it("get_session_post_is_405_b179", async () => {
    // 1.7 の get-session は POST も経路に持つが、session.deferSessionRefresh が無いと読む前に 405 で断る(audit.ts の UNAUDITED_ROUTES の理由)。
    // 将来 deferSessionRefresh を入れると POST が通り(セッションの延長を書く)、ここで落ちて分類を見直せる
    const owner = await setupOwner();
    expect((await call("POST", "/auth/get-session", { token: owner.token, body: {} })).status).toBe(405);
    expect((await call("GET", "/auth/get-session", { token: owner.token })).status).toBe(200);
  }, TIMEOUT);

  it("session_expiry_and_update_age_b179", async () => {
    // 監査の項目 8: セッションの期限(expiresIn 7 日)・延長(updateAge 1 日)・cookie cache を使わないこと。既定は 1.4.21 と 1.7.15 で同じ。
    // あわせて、1.7 が書くセッションの日付の形(ISO 8601 の文字列)を見る(unproven-user.ts の有効なセッションの判定が文字列で比べる)
    const owner = await setupOwner();
    const ed = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const token = sessionTokenOf(ed.token);
    const row = () =>
      env.DB.prepare(`select "expiresAt" as e, typeof("expiresAt") as t, typeof("createdAt") as ct from session where token = ?`).bind(token).first<{ e: string; t: string; ct: string }>();
    const created = await row();
    expect(created?.t).toBe("text");
    expect(created?.ct).toBe("text");
    expect(new Date(created!.e).toISOString()).toBe(created!.e);
    const DAY = 86_400_000;
    // 作った直後の期限は 7 日後
    expect(Math.abs(new Date(created!.e).getTime() - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
    // updateAge(1 日)の内は延ばさない
    expect((await call("GET", "/me", { token: ed.token })).status).toBe(200);
    expect((await row())?.e).toBe(created!.e);
    // 作ってから 1 日を過ぎた形(期限の残りが 6 日を切る)にすると、次の要求で 7 日後まで延びる
    const aged = new Date(Date.now() + 6 * DAY - 60_000).toISOString();
    await env.DB.prepare(`update session set "expiresAt" = ? where token = ?`).bind(aged, token).run();
    const me = await call("GET", "/me", { token: ed.token });
    expect(me.status).toBe(200);
    expect(me.headers.getSetCookie().some((c) => c.includes("session_data"))).toBe(false); // cookie cache を使っていない
    const extended = await row();
    expect(new Date(extended!.e).getTime()).toBeGreaterThan(Date.now() + 7 * DAY - 60_000);
    // cookie cache を使っていないので、行を消したセッションは次の要求からすぐ 401
    await env.DB.prepare(`delete from session where token = ?`).bind(token).run();
    expect((await call("GET", "/me", { token: ed.token })).status).toBe(401);
    // 期限の切れたセッションは 401(別のログインのセッションで見る。Better Auth は期限切れの行をその場で消す)
    const again = (await googleSignIn(ed.email)).token!;
    await env.DB.prepare(`update session set "expiresAt" = ? where token = ?`).bind(new Date(Date.now() - 1000).toISOString(), sessionTokenOf(again)).run();
    expect((await call("GET", "/me", { token: again })).status).toBe(401);
  }, TIMEOUT);
});
