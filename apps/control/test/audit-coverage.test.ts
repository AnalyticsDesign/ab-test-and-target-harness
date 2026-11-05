import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AUDITED_ROUTES, PENDING_ROUTES, UNAUDITED_ROUTES } from "../src/audit";
import { getAuth } from "../src/auth";
import { AUTH_ALLOW } from "../src/auth-paths";
import { app } from "../src/index";

/**
 * B129 plan Task 5(spec §3.1・§12): すべての書き込みの経路(POST・PUT・PATCH・DELETE)が、記録しない(UNAUDITED_ROUTES)か、
 * 記録する・まだ記録していない(AUDITED_ROUTES・PENDING_ROUTES。Task 6・7 で移し終えて PENDING_ROUTES は空)のどちらか一方だけに入る。
 * AUDITED_ROUTES と PENDING_ROUTES の両方に入るのは、一部の action だけを記録した途中の経路で、同じ action を両方に書かない(Task 6)。
 *
 * 経路は 3 か所から集める:
 * 1. `/openapi.json` の paths(契約の経路。openapi.test.ts がルータの掃引で漏れを見ている)
 * 2. Hono のルータ(`app.routes`)の、メソッドが決まった経路(OpenAPI に載せ忘れた経路も拾う)
 * 3. Better Auth のパススルー(`app.all("/auth/*")`)は、通す path(AUTH_ALLOW)ごとに Better Auth の endpoint のメソッドで展開する
 * ルータのメソッド ALL の経路は、下の MIDDLEWARE_ALL(認証などの middleware)と `/auth/*` のほかにあれば落とす(新しい catch-all は分類を決める)
 */

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** ルータのメソッド ALL のうち middleware だけの経路(要求を処理しない。app.use の登録) */
const MIDDLEWARE_ALL = new Set(["/*", "/instance-admins", "/instance-admins/*", "/me/api-keys", "/me/api-keys/*"]);
const AUTH_PASSTHROUGH = "/auth/*";

type Doc = { paths: Record<string, Record<string, unknown>> };

/** OpenAPI の `{param}` を Hono の `:param` にそろえる */
const honoPath = (p: string) => p.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");

/** Better Auth の endpoint の path(basePath の /auth を含まない)→ メソッド */
function authEndpointMethods(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const ep of Object.values(getAuth(env).api) as Array<{ path?: string; options?: { method?: string | string[] } }>) {
    if (typeof ep?.path !== "string" || !ep.options?.method) continue;
    const ms = Array.isArray(ep.options.method) ? ep.options.method : [ep.options.method];
    out.set(ep.path, [...(out.get(ep.path) ?? []), ...ms.map((m) => m.toUpperCase())]);
  }
  return out;
}

async function writeRoutes(): Promise<{ openapi: Set<string>; router: Set<string>; auth: Set<string>; unknownAll: string[] }> {
  const res = await app.request("/openapi.json", {}, env);
  expect(res.status).toBe(200);
  const doc = (await res.json()) as Doc;
  const openapi = new Set<string>();
  for (const [p, ops] of Object.entries(doc.paths)) for (const m of Object.keys(ops)) if (WRITE.has(m.toUpperCase())) openapi.add(`${m.toUpperCase()} ${honoPath(p)}`);

  const router = new Set<string>();
  const unknownAll: string[] = [];
  let passthrough = false;
  for (const r of app.routes) {
    if (r.method === "ALL") {
      if (r.path === AUTH_PASSTHROUGH) passthrough = true;
      else if (!MIDDLEWARE_ALL.has(r.path)) unknownAll.push(r.path);
      continue;
    }
    if (WRITE.has(r.method)) router.add(`${r.method} ${r.path}`);
  }

  const auth = new Set<string>();
  if (passthrough) {
    const methods = authEndpointMethods();
    for (const p of AUTH_ALLOW) {
      const ms = methods.get(p.slice("/auth".length));
      expect(ms, `${p}: Better Auth の endpoint が見つからない`).toBeDefined();
      for (const m of ms!) if (WRITE.has(m)) auth.add(`${m} ${p}`);
    }
  }
  return { openapi, router, auth, unknownAll };
}

describe("audit coverage (B129 plan Task 5)", () => {
  it("every_write_route_is_classified", async () => {
    const { openapi, router, auth, unknownAll } = await writeRoutes();
    expect(openapi.size).toBeGreaterThan(30); // 掃引になっている(OpenAPI から拾えている)
    expect(auth.has("POST /auth/sign-in/email")).toBe(true); // Better Auth の展開が効いている
    expect(unknownAll, "メソッド ALL の新しい経路: 書き込みなら分類を決め、middleware なら MIDDLEWARE_ALL に足す").toEqual([]);
    // ルータにあって OpenAPI に無い書き込みの経路(Better Auth のパススルーは除く)は、openapi.test.ts が別に落とす。ここでも分類の対象にする
    const all = new Set([...openapi, ...router, ...auth]);

    const lists = { AUDITED_ROUTES: Object.keys(AUDITED_ROUTES), UNAUDITED_ROUTES: Object.keys(UNAUDITED_ROUTES), PENDING_ROUTES: Object.keys(PENDING_ROUTES) };
    const problems: string[] = [];
    for (const route of [...all].sort()) {
      const inLists = Object.entries(lists).filter(([, keys]) => keys.includes(route)).map(([name]) => name);
      // 記録する経路の一部の action がまだのとき(AUDITED と PENDING の両方)は許す。同じ action を両方に書かない
      const partial = inLists.length === 2 && inLists.includes("AUDITED_ROUTES") && inLists.includes("PENDING_ROUTES");
      if (partial) {
        const done = new Set(AUDITED_ROUTES[route]!.map((x) => x.action));
        const both = PENDING_ROUTES[route]!.actions.filter((a) => done.has(a));
        if (both.length > 0) problems.push(`${route}: 同じ action が AUDITED_ROUTES と PENDING_ROUTES の両方にある(${both.join("・")})`);
      } else if (inLists.length !== 1) problems.push(`${route}: ${inLists.length === 0 ? "どの一覧にも無い" : `複数の一覧にある(${inLists.join("・")})`}`);
    }
    // 一覧にあって経路が無い(消した・名前を変えた経路)も落とす
    for (const [name, keys] of Object.entries(lists)) for (const k of keys) if (!all.has(k)) problems.push(`${name} の ${k}: その書き込みの経路が無い`);
    expect(problems).toEqual([]);
  });

  it("pending_routes_are_empty (Task 7)", () => {
    // Task 6・7 で記録を足し終えた。新しい書き込みの経路は、記録するかを決めて AUDITED_ROUTES か UNAUDITED_ROUTES に入れる
    expect(PENDING_ROUTES).toEqual({});
  });

  it("every_audited_route_has_its_test", () => {
    const sources = Object.entries(env.TEST_AUDIT_TESTS);
    expect(sources.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [route, checks] of Object.entries(AUDITED_ROUTES)) {
      expect(checks.length, `${route}: テストの名前が無い`).toBeGreaterThan(0);
      for (const { action, test } of checks) {
        // `it("<名前>"` または `it("<名前> (…)"` の形(テスト名の後ろに決定の番号などの括弧書きを足してよい)
        const re = new RegExp(`\\bit\\(\\s*["'\`]${test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:["'\`]| \\()`);
        if (!sources.some(([, src]) => re.test(src))) missing.push(`${route} ${action}: ${test}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
