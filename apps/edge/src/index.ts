import { Hono, type Context } from "hono";
import { DecisionBodySchema, DliteRequestSchema, EventBodySchema, isAcceptableVisitorId, shortVisitorHash, visitorIdIssuedAt, type DecisionBody, type SiteSettings } from "@wtt/core";
import type { Env } from "./env";
import { handleCheck } from "./check";
import { corsHeaders, originAllowed, preflightHeaders } from "./cors";
import { canonicalCookieIds, chooseCookieVisitorId, resolveDliteIdentity, revokeCookies } from "./cookies";
import { evaluateDecision, readBodyWithin4kb } from "./decision";
import { handleEvent, isResultsEvent, type ResultsEventBody } from "./event";
import { rateLimitOk } from "./ratelimit";
import { handleGoalConversion, piggybackGoalEvent, piggybackPageviewGoals } from "./goal-conversion";
import { forgetResults, handleResultsEvent } from "./results";
import { loadActiveVersion, loadConfig, loadSettings, loadSiteIdByHost, SITE_ID_RE } from "./store";

export const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("wtt-edge", 200));

type EdgeContext = Context<{ Bindings: Env }>;

/**
 * Rate Limiting binding の 429(/v1/sites/* と D-lite の decision で同じ本文)。Retry-After は binding の period(10 秒)に合わせた再試行目安。
 * cors = true(/v1/sites/:sid/decision・/event)には `Access-Control-Allow-Origin: *` を付ける(plan12 K11・決定 63 の SDD 着手時の改め (二)):
 * 別オリジンの構成でも runtime が 429 を読めるように。KV(許可する Origin の一覧)を読む前の応答なので一覧とは比べず、検査の順は変えない。
 * runtime は資格情報を送らないので `*` で読め、本文は固定の文字列だけ
 */
function rateLimited(c: EdgeContext, cors: boolean): Response {
  return c.text("rate limited", 429, cors ? { "Retry-After": "10", "Access-Control-Allow-Origin": "*" } : { "Retry-After": "10" });
}

/** waitUntil を this ごと渡す(新しい Profile の予算の報告。plan12 K9) */
const waitUntilOf = (c: EdgeContext) => (p: Promise<unknown>): void => c.executionCtx.waitUntil(p);

/** 結果の参加・CV の受信。目標だけの CV(版 2。B139 §5.2)と、run 指定の CV(版 1。移行の間だけ)・参加を分ける。時刻は edge の受信時刻 */
function receiveResults(c: EdgeContext, siteId: string, settings: SiteSettings, body: ResultsEventBody, visitorId: string) {
  if (body.v === 2) return handleGoalConversion(c.env, c.executionCtx, siteId, settings, body, visitorId, Date.now());
  return handleResultsEvent(c.env, c.executionCtx, siteId, settings, body, visitorId, Date.now());
}

/** type:"goal" の結果の CV への便乗(B139 Q22 の 2)。Profile の記録とは別に waitUntil に回す */
const piggybackGoal = (c: EdgeContext, siteId: string, settings: SiteSettings, goalId: string, visitorId: string, cloudflareHost: boolean): void =>
  piggybackGoalEvent({ env: c.env, ctx: c.executionCtx, siteId, now: Date.now() }, settings, goalId, visitorId, cloudflareHost);

// spec §9.5 の適用順序: ① 形式検証 → ② レート制限 → ③ Origin 検証 → ④ 評価(needsProfile は DO、§7.4)
app.post("/v1/sites/:siteId/decision", async (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId || !SITE_ID_RE.test(siteId)) return c.text("not found", 404);
  const read = await readBodyWithin4kb(c.req.raw);
  if (!read.ok) return c.text("payload too large", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return c.text("bad request", 400);
  }
  const body = DecisionBodySchema.safeParse(parsed);
  if (!body.success) return c.text("bad request", 400);
  const visitorId = body.data.visitorId;
  if (!visitorId || !isAcceptableVisitorId(visitorId)) return c.text("bad request", 400);
  if (!(await rateLimitOk(c.env, c.req.header("CF-Connecting-IP")))) return rateLimited(c, true);
  const settings = await loadSettings(c.env, siteId);
  if (!settings) return c.text("not found", 404);
  // B139 §4.2: Mode B のサイトも受ける(外部ホストのページ用。Origin の完全一致は Mode A と同じ)
  const origin = c.req.header("Origin") ?? null;
  if (!originAllowed(settings, origin)) return c.text("forbidden", 403);
  const config = await loadConfig(c.env, siteId, body.data.v);
  const out = await evaluateDecision(c.env, siteId, settings, config, body.data, visitorId, body.data.firstVisitAt, waitUntilOf(c));
  if (out === null) return c.text("profile unavailable", 503, corsHeaders(origin)); // 503 も CORS 付き — runtime が status を読めるように(§10.7)
  return c.json(out, 200, corsHeaders(origin));
});

/** spec §9.5: preflight は decision / event 共通(Origin 完全一致。B139 §4.2 で Mode B も受ける) */
async function preflight(c: EdgeContext): Promise<Response> {
  const siteId = c.req.param("siteId");
  if (!siteId || !SITE_ID_RE.test(siteId)) return c.text("not found", 404);
  const settings = await loadSettings(c.env, siteId);
  const origin = c.req.header("Origin") ?? null;
  if (!settings || !originAllowed(settings, origin)) return c.text("forbidden", 403);
  return c.body(null, 204, preflightHeaders(origin)); // originAllowed は型ガード(origin is string)
}
app.options("/v1/sites/:siteId/decision", preflight);
app.options("/v1/sites/:siteId/event", preflight);

// spec §9.2 / §9.5: event はブラウザ直接経路(Mode A。B139 §4.2 で Mode B も)。順序は decision と同じ: 形式 → レート制限 → Origin → KV → DO
app.post("/v1/sites/:siteId/event", async (c) => {
  const siteId = c.req.param("siteId");
  if (!siteId || !SITE_ID_RE.test(siteId)) return c.text("not found", 404);
  const read = await readBodyWithin4kb(c.req.raw);
  if (!read.ok) return c.text("payload too large", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return c.text("bad request", 400);
  }
  const body = EventBodySchema.safeParse(parsed);
  if (!body.success) return c.text("bad request", 400);
  const visitorId = body.data.visitorId;
  if (!visitorId || !isAcceptableVisitorId(visitorId)) return c.text("bad request", 400); // mode_a_event_requires_visitor_id
  if (!(await rateLimitOk(c.env, c.req.header("CF-Connecting-IP")))) return rateLimited(c, true);
  const settings = await loadSettings(c.env, siteId);
  if (!settings) return c.text("not found", 404);
  const origin = c.req.header("Origin") ?? null;
  if (!originAllowed(settings, origin)) return c.text("forbidden", 403);
  // 結果の参加・CV(D9 ② 設計書 §6.4)は常に 200 + 本文の result(訪問者の画面に影響させない)。時刻は edge の受信時刻
  if (isResultsEvent(body.data)) {
    const out = await receiveResults(c, siteId, settings, body.data, visitorId);
    return c.json(out, 200, corsHeaders(origin));
  }
  // B139 Q22 の 2: goal は結果の CV も記録する(Mode A と Cloudflare 外のドメインなので、ページの表示の目標も含める)
  if (body.data.type === "goal") piggybackGoal(c, siteId, settings, body.data.goalId, visitorId, false);
  const outcome = await handleEvent(c.env, siteId, settings, body.data, visitorId, waitUntilOf(c));
  if (outcome === "failed") return c.text("profile unavailable", 503, corsHeaders(origin)); // 503 も CORS 付き — runtime が status を読めるように(§10.7)
  return c.body(null, 204, corsHeaders(origin));
});

// B158(G05): D-lite の POST /__ab/* の門。同じ登録ドメインの兄弟ホストのページが訪問者のブラウザから text/plain で送ると
// Cookie 付きで届くため、json 以外は 415、ブラウザが別オリジンから送ったもの(Sec-Fetch-Site が same-origin 以外)は 403。
// Sec-Fetch-Site が無いもの(ブラウザ以外・古いブラウザ)は通す。KV・本文を読む前に断り、Set-Cookie は出さない。
// POST にだけ掛ける(B139 で足す GET の確認の経路を門の外に置くため)
app.post("/__ab/*", async (c, next) => {
  const mediaType = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "application/json") return c.text("unsupported media type", 415);
  // 大文字・前後の空白は吸収して比べる(admin の originVerdict とそろえる)
  const fetchSite = c.req.header("Sec-Fetch-Site")?.trim().toLowerCase();
  if (fetchSite !== undefined && fetchSite !== "same-origin") return c.text("forbidden", 403);
  await next();
});

// B139 §4.2: 導入の確認。GET は B158 の門(POST のみ)の外。Cookie・サイト設定には触れない(check.ts)
const check = (c: EdgeContext) => handleCheck(c.env);
app.get("/__ab/ping", check);
app.get("/__ab/decision", check);
app.get("/__ab/event", check);

// spec §9.2 / §9.6: D-lite の event。Cookie が Identity。Cookie 無し・不正は DO に触れず 204(Cookie は発行しない、§15.1)
app.post("/__ab/event", async (c) => {
  const host = new URL(c.req.url).hostname;
  const siteId = await loadSiteIdByHost(c.env, host);
  if (!siteId || !SITE_ID_RE.test(siteId)) return c.text("not found", 404);
  const settings = await loadSettings(c.env, siteId);
  if (!settings) return c.text("not found", 404);
  if (settings.mode !== "B" || !settings.hosts.some((h) => h.toLowerCase() === host)) return c.text("not found", 404);
  const read = await readBodyWithin4kb(c.req.raw);
  if (!read.ok) return c.text("payload too large", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return c.text("bad request", 400);
  }
  const body = EventBodySchema.safeParse(parsed);
  if (!body.success) return c.text("bad request", 400);
  if (body.data.type === "forget") return c.body(null, 204); // spec §9.2: forget はブラウザ直接経路のみ。D-lite の撤回は Cookie 削除だけで DO 非接触(§16)
  // body.visitorId は無視(Cookie が正)。値の選び方は decision と同じ(B139 §3.4)。説明のつかない 2 種類以上(fresh)は記録しない
  const chosen = chooseCookieVisitorId(c.req.header("Cookie") ?? null, settings);
  if (chosen.fresh || chosen.id === null) return c.body(null, 204);
  const existing = chosen.id;
  if (isResultsEvent(body.data)) {
    // 同一オリジンの経路なので CORS は付けない(Mode A と同じ判定・同じ応答の形)
    return c.json(await receiveResults(c, siteId, settings, body.data, existing), 200);
  }
  // B139 Q22 の 2: goal は結果の CV も記録する。ページの表示の目標は /__ab/decision で記録するので除く
  if (body.data.type === "goal") piggybackGoal(c, siteId, settings, body.data.goalId, existing, true);
  const outcome = await handleEvent(c.env, siteId, settings, body.data, existing, waitUntilOf(c));
  if (outcome === "failed") return c.text("profile unavailable", 503);
  return c.body(null, 204);
});

// spec §9.6: D-lite Proxy Mode。同一ゾーンの Workers Route で受けるため CORS は付けない(§9.6)。
// レート制限(Rate Limiting binding)は decision にだけ掛け、同意の撤回はその前に処理する(plan12 K14 (e)・決定 63 (13)(e))
app.post("/__ab/decision", async (c) => {
  const host = new URL(c.req.url).hostname;
  const siteId = await loadSiteIdByHost(c.env, host);
  if (!siteId) return c.text("not found", 404);
  if (!SITE_ID_RE.test(siteId)) return c.text("not found", 404); // host mapping 汚染への防御(r2 CX-Medium-8)
  const settings = await loadSettings(c.env, siteId);
  if (!settings) return c.text("not found", 404);
  // spec §4: D-lite は mode = B + Proxy Mode。mode 不一致や hosts 外のホストは fail-closed(設定ミスで Identity を発行しない)
  if (settings.mode !== "B" || !settings.hosts.some((h) => h.toLowerCase() === host)) return c.text("not found", 404);
  const read = await readBodyWithin4kb(c.req.raw);
  if (!read.ok) return c.text("payload too large", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return c.text("bad request", 400);
  }
  const req = DliteRequestSchema.safeParse(parsed);
  if (!req.success) return c.text("bad request", 400);
  const cookieHeader = c.req.header("Cookie") ?? null;
  if ("kind" in req.data && req.data.kind === "consent") {
    // spec §16: revoke は Set-Cookie(Max-Age=0)を返す。Profile の DO へは転送しない。
    // 計測用 D1 の行は、forgetOnRevoke が false でなく正本の Cookie があるときに消す(D9 ② K13)。Cookie を消す前に ID を読む。
    // forgetResults は失敗してもログだけで throw しない(Cookie の削除は必ず返す)。
    // B139 Q31: 同じ名前で届いた形の正しい値すべて(最大 4)について消す(どれが本人の ID か見分けられないため)
    if (settings.forgetOnRevoke !== false) {
      for (const id of canonicalCookieIds(cookieHeader, settings)) await forgetResults(c.env, siteId, id);
    }
    const res = c.body(null, 204);
    for (const sc of revokeCookies(cookieHeader, settings, host, Math.floor(Date.now() / 1000))) res.headers.append("Set-Cookie", sc);
    return res;
  }
  // 撤回を 429 にしない(Cookie が消えず、訪問者が撤回できたと思い込むため)。decision は Identity の発行の前に止める(Set-Cookie を出さない)
  if (!(await rateLimitOk(c.env, c.req.header("CF-Connecting-IP")))) return rateLimited(c, false);
  const body = req.data as DecisionBody; // body.visitorId は D-lite では無視(spec §9.1。Cookie が正)
  // 決定 49 §7.2: _ab_uuid の導出の salt は Site で不変。未 Publish(active が無い)なら出さない。
  // body.v の config が active と同じ版なら、同じ config を 2 度読まずに使い回す(違う版のときだけ active を読む)
  const config = await loadConfig(c.env, siteId, body.v);
  const activeVersion = await loadActiveVersion(c.env, siteId);
  const saltConfig = activeVersion === null ? null : activeVersion === body.v ? config : await loadConfig(c.env, siteId, activeVersion);
  const { visitorId, setCookies } = await resolveDliteIdentity(cookieHeader, settings, saltConfig?.siteSalt ?? null, host, Math.floor(Date.now() / 1000));
  // 決定 49 §7.3: D-lite は正本 Cookie が HttpOnly でブラウザから読めないので、初回の訪問は edge が ID(UUIDv7)から読む
  const out = await evaluateDecision(c.env, siteId, settings, config, body, visitorId, visitorIdIssuedAt(visitorId), waitUntilOf(c));
  // B139 Q22 の 1: ページの表示の目標の CV を edge が記録する(タグは送らない)。判定は active の config(saltConfig)で行い、
  // 記録は waitUntil に回す(応答の status・本文・Cookie は待たず、結果も載せない。Profile の 503 でも記録する)
  piggybackPageviewGoals({ env: c.env, ctx: c.executionCtx, siteId, now: Date.now() }, settings, saltConfig, body.url, visitorId);
  // DO 障害(503)でも Identity の発行・Max-Age 延長は続ける(r1 CL-High-1)。落とすと DO 障害中は毎 PV 新しい ID → 新しい DO を叩く増幅になる
  // 設計書 §6.2: D-lite の runtime は ID(HttpOnly の Cookie)を読めないので、送信済みの印と比べる短いハッシュを edge が返す
  if (out !== null) {
    const vh = await shortVisitorHash(visitorId);
    if (vh !== null) out.vh = vh;
  }
  const res = out === null ? c.text("profile unavailable", 503) : c.json(out, 200);
  for (const sc of setCookies) res.headers.append("Set-Cookie", sc);
  return res;
});

// Durable Object は Worker のモジュールから export されている必要がある(wrangler.jsonc の class_name と一致)
export { VisitorProfile } from "./profile";
export { ResultsBudget } from "./results-budget";
export { ResultsHealth } from "./results-health";
export { NewProfileBudget } from "./new-profile-budget";

export default app;
