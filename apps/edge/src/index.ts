import { Hono, type Context } from "hono";
import { DecisionBodySchema, DliteRequestSchema, EventBodySchema, isAcceptableVisitorId, isCanonicalModeAId, visitorIdIssuedAt, type DecisionBody } from "@wtt/core";
import type { Env } from "./env";
import { corsHeaders, originAllowed, preflightHeaders } from "./cors";
import { parseCookies, resolveDliteIdentity, revokeCookies } from "./cookies";
import { evaluateDecision, readBodyWithin4kb } from "./decision";
import { handleEvent } from "./event";
import { rateLimitOk } from "./ratelimit";
import { loadActiveVersion, loadConfig, loadSettings, loadSiteIdByHost, SITE_ID_RE } from "./store";

export const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("wtt-edge", 200));

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
  if (!(await rateLimitOk(c.env, c.req.header("CF-Connecting-IP")))) {
    return c.text("rate limited", 429, { "Retry-After": "10" }); // §9.5 の 20req/10s に合わせた再試行目安
  }
  const settings = await loadSettings(c.env, siteId);
  if (!settings) return c.text("not found", 404);
  if (settings.mode !== "A") return c.text("not found", 404); // spec §7.1: ブラウザ直接経路は Mode A のみ
  const origin = c.req.header("Origin") ?? null;
  if (!originAllowed(settings, origin)) return c.text("forbidden", 403);
  const config = await loadConfig(c.env, siteId, body.data.v);
  const out = await evaluateDecision(c.env, siteId, settings, config, body.data, visitorId, body.data.firstVisitAt);
  if (out === null) return c.text("profile unavailable", 503, corsHeaders(origin)); // 503 も CORS 付き — runtime が status を読めるように(§10.7)
  return c.json(out, 200, corsHeaders(origin));
});

/** spec §9.5: preflight は decision / event 共通(Mode A のみ、Origin 完全一致) */
async function preflight(c: Context<{ Bindings: Env }>): Promise<Response> {
  const siteId = c.req.param("siteId");
  if (!siteId || !SITE_ID_RE.test(siteId)) return c.text("not found", 404);
  const settings = await loadSettings(c.env, siteId);
  if (settings && settings.mode !== "A") return c.text("not found", 404); // spec §7.1: ブラウザ直接経路は Mode A のみ
  const origin = c.req.header("Origin") ?? null;
  if (!settings || !originAllowed(settings, origin)) return c.text("forbidden", 403);
  return c.body(null, 204, preflightHeaders(origin)); // originAllowed は型ガード(origin is string)
}
app.options("/v1/sites/:siteId/decision", preflight);
app.options("/v1/sites/:siteId/event", preflight);

// spec §9.2 / §9.5: event はブラウザ直接経路(Mode A)。順序は decision と同じ: 形式 → レート制限 → Origin → KV → DO
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
  if (!(await rateLimitOk(c.env, c.req.header("CF-Connecting-IP")))) {
    return c.text("rate limited", 429, { "Retry-After": "10" });
  }
  const settings = await loadSettings(c.env, siteId);
  if (!settings) return c.text("not found", 404);
  if (settings.mode !== "A") return c.text("not found", 404);
  const origin = c.req.header("Origin") ?? null;
  if (!originAllowed(settings, origin)) return c.text("forbidden", 403);
  const outcome = await handleEvent(c.env, siteId, settings, body.data, visitorId);
  if (outcome === "failed") return c.text("profile unavailable", 503, corsHeaders(origin)); // 503 も CORS 付き — runtime が status を読めるように(§10.7)
  return c.body(null, 204, corsHeaders(origin));
});

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
  const existing = parseCookies(c.req.header("Cookie") ?? null)[settings.visitorCookieName];
  if (existing === undefined || !isCanonicalModeAId(existing)) return c.body(null, 204); // body.visitorId は無視(Cookie が正)
  const outcome = await handleEvent(c.env, siteId, settings, body.data, existing);
  if (outcome === "failed") return c.text("profile unavailable", 503);
  return c.body(null, 204);
});

// spec §9.6: D-lite Proxy Mode。同一ゾーンの Workers Route で受けるため CORS もレート制限も適用しない(§9.6)
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
    // spec §16: revoke は Set-Cookie(Max-Age=0)を返すだけ。DO へは転送しない
    const res = c.body(null, 204);
    for (const sc of revokeCookies(cookieHeader, settings)) res.headers.append("Set-Cookie", sc);
    return res;
  }
  const body = req.data as DecisionBody; // body.visitorId は D-lite では無視(spec §9.1。Cookie が正)
  // 決定 49 §7.2: _ab_uuid の導出の salt は Site で不変。未 Publish(active が無い)なら出さない。
  // body.v の config が active と同じ版なら、同じ config を 2 度読まずに使い回す(違う版のときだけ active を読む)
  const config = await loadConfig(c.env, siteId, body.v);
  const activeVersion = await loadActiveVersion(c.env, siteId);
  const saltConfig = activeVersion === null ? null : activeVersion === body.v ? config : await loadConfig(c.env, siteId, activeVersion);
  const { visitorId, setCookies } = await resolveDliteIdentity(cookieHeader, settings, saltConfig?.siteSalt ?? null);
  // 決定 49 §7.3: D-lite は正本 Cookie が HttpOnly でブラウザから読めないので、初回の訪問は edge が ID(UUIDv7)から読む
  const out = await evaluateDecision(c.env, siteId, settings, config, body, visitorId, visitorIdIssuedAt(visitorId));
  // DO 障害(503)でも Identity の発行・Max-Age 延長は続ける(r1 CL-High-1)。落とすと DO 障害中は毎 PV 新しい ID → 新しい DO を叩く増幅になる
  const res = out === null ? c.text("profile unavailable", 503) : c.json(out, 200);
  for (const sc of setCookies) res.headers.append("Set-Cookie", sc);
  return res;
});

// Durable Object は Worker のモジュールから export されている必要がある(wrangler.jsonc の class_name と一致)
export { VisitorProfile } from "./profile";

export default app;
