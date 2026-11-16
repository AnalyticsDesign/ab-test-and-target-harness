// テスト用の偽の Cloudflare。fetch(url, init) の形で、lib/cf.mjs が呼ぶ宛先に応える。
// 応答の形は docs/dev/b130_api_shapes.md(B130 Task 3b の実機の記録)に合わせた。記録に無い所(使えないトークンで
// verify 以外を呼んだとき・ゾーン・ruleset・Workers・GraphQL の失敗の形・429 の本文・作成の本文の誤り)は、この
// ファイルで決めた既定で、実機では確かめていない(UNVERIFIED と書いた所)。テストで要るなら差し込みで上書きする。
//
// 使い方の要点:
//   const fake = createFakeCf({ accountId, zones, permissionGroups, now });
//   const parent = fake.addToken({ name, permissions: ["Account API Tokens Write"], not_before, expires_on });
//   const cf = createCf({ fetch: fake.fetch, sleep: fake.sleep, accountId, now: fake.now });
//   fake.rateLimitNext(2) / fake.dropNext("createToken") / fake.failListPage(2) / fake.failReach("workerScripts", 1) …
//   fake.requests(送った要求の履歴)・fake.count("deleteToken")

/**
 * 権限の一覧の既定。7 つは実機で見た ID(Cloudflare の全体で同じ)。
 * 紛らわしい名前の Account API Tokens Read・Workers Scripts Read の 2 つは、ID も含めて作り物(UNVERIFIED)
 */
export const DEFAULT_PERMISSION_GROUPS = Object.freeze([
  { id: "5bc3f8b21c554832afc660159ab75fa4", name: "Account API Tokens Write", scopes: ["com.cloudflare.api.account"] },
  { id: "fa4e0000000000000000000000000001", name: "Account API Tokens Read", scopes: ["com.cloudflare.api.account"] },
  { id: "c8fed203ed3043cba015a93ad1616f1f", name: "Zone Read", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "82e64a83756745bbbb1c9c2701bf816b", name: "DNS Read", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "9ff81cbbe65c400b97d92c3c1033cab6", name: "Cache Settings Write", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "fb6778dc191143babbfaa57993f1d275", name: "Zone WAF Write", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "e086da7e2179491d91ee5f35b3ca210a", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
  { id: "fa4e0000000000000000000000000002", name: "Workers Scripts Read", scopes: ["com.cloudflare.api.account"] },
  { id: "b89a480218d04ceb98b4fe57ca29dc1f", name: "Account Analytics Read", scopes: ["com.cloudflare.api.account"] },
].map((g) => Object.freeze({ ...g, description: `${g.name} (fake)`, category: "fake", is_selectable: true, scopes: Object.freeze([...g.scopes]) })));

const ACCOUNT = "com.cloudflare.api.account";
const ZONE = "com.cloudflare.api.account.zone";
const API_PREFIX = "/client/v4";
const DEFAULT_NOW = "2026-11-14T05:52:39.000Z";

// 実機の errors の形
const E = Object.freeze({
  invalidToken: { code: 1000, message: "Invalid API Token" },
  notFound: { code: 1003, message: "token not found" },
  unauthorized: { code: 9109, message: "Unauthorized to access requested resource" },
  authError: { code: 10000, message: "Authentication error" }, // UNVERIFIED(ゾーン・ruleset・Workers の権限の不足)
  noEntrypoint: { code: 10003, message: "could not find entrypoint ruleset" },
  noRoute: { code: 7003, message: "No route for that URI" }, // UNVERIFIED
  rateLimited: { code: 971, message: "Please wait and consider throttling your request speed" }, // UNVERIFIED
  badRequest: { code: 400, message: "Invalid request body" }, // UNVERIFIED(作成の本文の誤り)
  serverError: { code: 10001, message: "Internal server error (fake)" }, // UNVERIFIED
});

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = (result, extra = {}) => json(200, { success: true, errors: [], messages: [], result, ...extra });
const fail = (status, error) => json(status, { success: false, errors: [error], messages: [], result: null });

/** fetch が通信で失敗したときと同じ形の例外(Node の fetch は TypeError を投げる) */
const networkError = () => new TypeError("fetch failed");

const isoSeconds = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * @param {{
 *   accountId: string,
 *   zones?: { id: string, name: string, status?: string, accountId?: string, entrypoints?: string[] }[],
 *   permissionGroups?: readonly { id: string, name: string, scopes: readonly string[] }[],
 *   now?: (() => Date) | Date | string,
 *   listResultInfo?: "full"|"no_total_pages"|"none",
 *   scripts?: string[],
 * }} opts
 */
export function createFakeCf({
  accountId,
  zones = [],
  permissionGroups = DEFAULT_PERMISSION_GROUPS,
  now,
  listResultInfo = "full",
  scripts = [],
} = {}) {
  if (typeof accountId !== "string" || accountId === "") throw new Error("createFakeCf: accountId を渡す");
  const baseNow = typeof now === "function" ? now : (() => new Date(now ?? DEFAULT_NOW));
  let offset = 0;
  const clock = () => new Date(baseNow().getTime() + offset);

  const groupsById = new Map(permissionGroups.map((g) => [g.id, g]));
  const groupsByName = new Map(permissionGroups.map((g) => [g.name, g]));

  /** @type {Map<string, any>} id → トークン(消したものも deleted: true で残す) */
  const tokens = new Map();
  const byValue = new Map();
  const oauth = new Set();
  const zoneList = zones.map((z) => ({ status: "active", accountId, entrypoints: [], ...z, entrypoints: new Set(z.entrypoints ?? []) }));
  const scriptList = [...scripts];
  const history = [];
  const injections = [];
  const sleeps = [];
  let seq = 0;
  let serial = 0;

  const nextId = () => (++serial).toString(16).padStart(32, "0");
  const nextValue = () => `fakecf_value_${String(serial).padStart(4, "0")}_${Math.random().toString(36).slice(2, 10)}`;

  // ---- トークンの状態 ----

  /** 今の状態(保存した status に、期限を時計で当てる) */
  function liveStatus(t) {
    if (t.status !== "active") return t.status;
    if (t.expires_on && new Date(t.expires_on).getTime() <= clock().getTime()) return "expired";
    return "active";
  }
  const notYetValid = (t) => Boolean(t.not_before && new Date(t.not_before).getTime() > clock().getTime());

  /** verify 以外の宛先で使えるか(消えた・期限切れ・止めた・開始前は使えない) */
  const usable = (t) => Boolean(t && !t.deleted && liveStatus(t) === "active" && !notYetValid(t));

  /** permissions(名前)と zoneIds から実機の形の policies を作る */
  function policiesFrom({ permissions = [], zoneIds = [], resources }) {
    const byScope = new Map();
    for (const n of permissions) {
      const g = groupsByName.get(n);
      if (!g) throw new Error(`createFakeCf: 権限 ${n} が権限の一覧に無い`);
      const scope = g.scopes[0];
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope).push({ id: g.id, name: g.name });
    }
    let n = 0;
    return [...byScope].map(([scope, groups]) => ({
      id: `policy${++n}`,
      effect: "allow",
      resources: resources ?? (scope === ZONE
        ? Object.fromEntries(zoneIds.map((z) => [`${ZONE}.${z}`, "*"]))
        : { [`${ACCOUNT}.${accountId}`]: "*" }),
      permission_groups: groups,
    }));
  }

  /** トークンの権限 name が対象 key に効くか */
  function allows(t, name, key) {
    for (const p of t.policies ?? []) {
      if (p.effect !== "allow") continue;
      if (!p.permission_groups?.some((g) => (g.name ?? groupsById.get(g.id)?.name) === name)) continue;
      if (p.resources && (p.resources[key] === "*" || (key.startsWith(`${ZONE}.`) && p.resources[`${ZONE}.*`] === "*"))) return true;
    }
    return false;
  }
  const allowsAny = (t, names, key) => names.some((n) => allows(t, n, key));

  function store(t) {
    tokens.set(t.id, t);
    byValue.set(t.value, t);
    return t;
  }

  /** 一覧・詳細の 1 件(値は入れない) */
  function details(t) {
    const d = {
      id: t.id,
      name: t.name,
      status: liveStatus(t),
      issued_on: t.issued_on,
      modified_on: t.issued_on,
      last_used_on: null,
      policies: clone(t.policies),
      token_prefix: "cfat",
      token_suffix: t.value.slice(-4),
      creator_email_at_creation: "creator@example.com",
    };
    if (t.not_before) d.not_before = t.not_before;
    if (t.expires_on) d.expires_on = t.expires_on;
    return d;
  }

  const snapshot = (t) => (t ? { ...clone(t), status: liveStatus(t) } : null);

  // ---- 差し込み ----

  /**
   * 差し込みを足す。rule = { route?, method?, match?(entry), times = 1, action }。
   * action: { type: "rateLimit", retryAfter } / { type: "drop" }(サーバーの側では成立させ、呼び出しには例外)/
   * { type: "networkError" }(サーバーに届かない)/ { type: "respond", status, body?, text?, headers? }
   */
  function inject(rule) {
    injections.push({ times: 1, ...rule });
  }
  const sel = (r) => (typeof r === "string" ? { route: r } : (r ?? {}));
  function take(entry) {
    for (const rule of injections) {
      if (rule.times <= 0) continue;
      if (rule.route && rule.route !== entry.route) continue;
      if (rule.method && rule.method !== entry.method) continue;
      if (rule.match && !rule.match(entry)) continue;
      rule.times--;
      return rule.action;
    }
    return null;
  }

  // ---- 宛先 ----

  function route(method, path, query) {
    const m = (re) => path.match(re);
    let x;
    if (method === "GET" && (x = m(/^\/accounts\/([^/]+)\/tokens\/verify$/))) return { route: "verify", account: x[1] };
    if (method === "GET" && path === "/user/tokens/verify") return { route: "userVerify" };
    if (method === "GET" && (x = m(/^\/accounts\/([^/]+)\/tokens\/permission_groups$/))) return { route: "permissionGroups", account: x[1] };
    if (method === "GET" && (x = m(/^\/accounts\/([^/]+)\/tokens$/))) {
      const page = query.page === undefined ? 1 : Number(query.page);
      return { route: "listTokens", account: x[1], page };
    }
    if (method === "POST" && (x = m(/^\/accounts\/([^/]+)\/tokens$/))) return { route: "createToken", account: x[1] };
    if (method === "GET" && (x = m(/^\/accounts\/([^/]+)\/tokens\/([^/]+)$/))) return { route: "tokenDetails", account: x[1], id: x[2] };
    if (method === "DELETE" && (x = m(/^\/accounts\/([^/]+)\/tokens\/([^/]+)$/))) return { route: "deleteToken", account: x[1], id: x[2] };
    if (method === "GET" && path === "/zones") return { route: "zones" };
    if (method === "GET" && (x = m(/^\/zones\/([^/]+)\/rulesets\/phases\/([^/]+)\/entrypoint$/))) return { route: "ruleset", zoneId: x[1], phase: x[2] };
    if (method === "GET" && (x = m(/^\/accounts\/([^/]+)\/workers\/scripts$/))) return { route: "workerScripts", account: x[1] };
    if (method === "POST" && path === "/graphql") return { route: "graphql" };
    return { route: "unknown" };
  }

  /** 宛先ごとの処理。tok = Authorization の値のトークン(無ければ null)、isOauth = OAuth の値か */
  function handle(entry, { tok, isOauth, body }) {
    const accountKey = `${ACCOUNT}.${accountId}`;
    const sameAccount = entry.account === undefined || entry.account === accountId;
    const accountTok = tok && tok.kind === "account" && tok.accountId === accountId ? tok : null;

    switch (entry.route) {
      case "verify": {
        // 実機: Account API Token だけが答える。User API Token・知らない値・消した値は 401・1000
        if (!accountTok || accountTok.deleted || !sameAccount) return fail(401, E.invalidToken);
        const r = { id: accountTok.id, status: liveStatus(accountTok) };
        if (accountTok.not_before) r.not_before = accountTok.not_before;
        if (accountTok.expires_on) r.expires_on = accountTok.expires_on;
        return json(200, { success: true, errors: [], messages: [{ code: 10000, message: "This API Token is valid and active" }], result: r });
      }
      case "userVerify": {
        if (!tok || tok.kind !== "user" || tok.deleted) return fail(401, E.invalidToken);
        const r = { id: tok.id, status: liveStatus(tok) };
        if (tok.not_before) r.not_before = tok.not_before;
        if (tok.expires_on) r.expires_on = tok.expires_on;
        return ok(r);
      }
      case "graphql": {
        // 実機: 使用状況の権限が無くても、受け付けたトークンなら 200・errors なし。使えない値の形は UNVERIFIED
        const tag = typeof body?.query === "string" ? body.query.match(/accountTag:\s*"([^"]*)"/)?.[1] : undefined;
        if (!usable(tok) || isOauth) return json(200, { data: null, errors: [{ message: "authentication error (fake)", extensions: { code: "authz" } }] });
        if (tag !== accountId) return json(200, { data: null, errors: [{ message: "not authorized for that account (fake)", extensions: { code: "authz" } }] });
        return json(200, { data: { viewer: { accounts: [{ x: [] }] } }, errors: null });
      }
      case "unknown":
        return fail(404, E.noRoute);
      default:
        break;
    }

    // ここから下は verify 以外。使えない値は 401・1000(UNVERIFIED)
    if (entry.route === "zones") {
      if (isOauth) return zonesResponse(entry, () => true);
      if (!usable(tok)) return fail(401, E.invalidToken);
      return zonesResponse(entry, (z) => allows(tok, "Zone Read", `${ZONE}.${z.id}`));
    }
    if (!usable(tok)) return fail(401, E.invalidToken);

    if (entry.route === "ruleset") {
      const z = zoneList.find((zz) => zz.id === entry.zoneId);
      const need = entry.phase === "http_request_cache_settings" ? ["Cache Settings Write"] : ["Zone WAF Write"];
      if (!z || !allowsAny(tok, need, `${ZONE}.${z.id}`)) return fail(403, E.authError);
      if (!z.entrypoints.has(entry.phase)) return fail(404, E.noEntrypoint);
      return ok({ id: `ruleset-${z.id.slice(0, 8)}-${entry.phase}`, name: "default", kind: "zone", phase: entry.phase, rules: [] });
    }
    if (entry.route === "workerScripts") {
      if (!sameAccount || !allowsAny(tok, ["Workers Scripts Write", "Workers Scripts Read"], accountKey)) return fail(403, E.authError);
      return ok(scriptList.map((id) => ({ id })));
    }

    // トークンの宛先。権限の不足は 9109(実機: 子が自分を消そうとしたとき)
    const write = allows(tok, "Account API Tokens Write", accountKey);
    const read = write || allows(tok, "Account API Tokens Read", accountKey);
    if (!sameAccount) return fail(403, E.unauthorized);

    switch (entry.route) {
      case "permissionGroups":
        if (!read) return fail(403, E.unauthorized);
        // 実機: 全部を 1 回で返し、result_info は無い
        return ok(permissionGroups.map((g) => clone(g)));
      case "listTokens": {
        if (!read) return fail(403, E.unauthorized);
        const all = [...tokens.values()].filter((t) => !t.deleted && t.kind === "account" && t.accountId === accountId);
        const perPage = Math.max(1, Number(entry.query.per_page ?? 20) || 20);
        const page = Math.max(1, entry.page || 1);
        const slice = all.slice((page - 1) * perPage, page * perPage).map(details);
        if (listResultInfo === "none") return ok(slice);
        const info = { page, per_page: perPage, total_pages: Math.max(1, Math.ceil(all.length / perPage)), count: slice.length, total_count: all.length };
        if (listResultInfo === "no_total_pages") delete info.total_pages;
        return ok(slice, { result_info: info });
      }
      case "tokenDetails": {
        if (!read) return fail(403, E.unauthorized);
        const t = tokens.get(entry.id);
        if (!t || t.deleted || t.kind !== "account" || t.accountId !== accountId) return fail(404, E.notFound); // 別のアカウントのトークンは見えない
        return ok(details(t));
      }
      case "createToken": {
        if (!write) return fail(403, E.unauthorized);
        const made = createFromBody(body, tok);
        if (!made) return fail(400, E.badRequest);
        return ok({ ...details(made), value: made.value });
      }
      case "deleteToken": {
        if (!write) return fail(403, E.unauthorized);
        const t = tokens.get(entry.id);
        if (!t || t.deleted || t.kind !== "account" || t.accountId !== accountId) return fail(404, E.notFound); // 別のアカウントのトークンは見えない
        t.deleted = true;
        return ok({ id: t.id });
      }
      default:
        return fail(404, E.noRoute);
    }
  }

  function zonesResponse(entry, visible) {
    const name = entry.query.name;
    const hit = zoneList.filter((z) => (name === undefined || z.name === name) && visible(z));
    return ok(hit.map((z) => ({ id: z.id, name: z.name, status: z.status, account: { id: z.accountId, name: "Example account" } })), {
      result_info: { page: 1, per_page: 20, total_pages: 1, count: hit.length, total_count: hit.length },
    });
  }

  /** 作成の本文から作る。権限の ID から名前を戻して policies に入れる(実機の応答と同じ形)。形が違えば null */
  function createFromBody(body, creator) {
    if (!body || typeof body.name !== "string" || body.name === "" || !Array.isArray(body.policies) || body.policies.length === 0) return null;
    const policies = [];
    let n = 0;
    for (const p of body.policies) {
      if (!p || (p.effect !== "allow" && p.effect !== "deny") || !p.resources || typeof p.resources !== "object") return null;
      if (!Array.isArray(p.permission_groups) || p.permission_groups.length === 0) return null;
      const groups = [];
      for (const g of p.permission_groups) {
        const known = g && groupsById.get(g.id);
        if (!known) return null;
        groups.push({ id: known.id, name: known.name });
      }
      policies.push({ id: `policy${++n}`, effect: p.effect, resources: clone(p.resources), permission_groups: groups });
    }
    for (const k of ["not_before", "expires_on"]) {
      if (body[k] !== undefined && (typeof body[k] !== "string" || Number.isNaN(new Date(body[k]).getTime()))) return null;
    }
    const id = nextId();
    const t = {
      id,
      value: nextValue(),
      name: body.name,
      kind: "account",
      accountId,
      policies,
      not_before: body.not_before ?? null,
      expires_on: body.expires_on ?? null,
      status: "active",
      deleted: false,
      issued_on: isoSeconds(clock()),
      createdBy: creator?.id ?? null,
    };
    return store(t);
  }

  // ---- fetch ----

  async function fetch(url, init = {}) {
    const u = new URL(String(url));
    const method = String(init.method ?? "GET").toUpperCase();
    const path = u.pathname.startsWith(API_PREFIX) ? u.pathname.slice(API_PREFIX.length) : u.pathname;
    const query = Object.fromEntries(u.searchParams);
    const headers = new Headers(init.headers ?? {});
    const auth = headers.get("authorization") ?? "";
    const value = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const tok = value === null ? null : (byValue.get(value) ?? null);
    const isOauth = value !== null && oauth.has(value);
    let body;
    if (typeof init.body === "string" && init.body !== "") {
      try { body = JSON.parse(init.body); } catch { body = undefined; }
    }

    const r = route(method, path, query);
    const entry = {
      seq: ++seq,
      method,
      path,
      query,
      ...r,
      tokenId: tok ? tok.id : null,
      auth: isOauth ? "oauth" : tok ? tok.kind : value === null ? "none" : "unknown",
    };
    if (body !== undefined) entry.body = body;
    history.push(entry);

    const action = take(entry);
    if (action) {
      if (action.type === "networkError") throw networkError();
      if (action.type === "rateLimit") {
        const headersOut = action.retryAfter === null || action.retryAfter === undefined ? {} : { "retry-after": String(action.retryAfter) };
        return json(429, { success: false, errors: [E.rateLimited], messages: [], result: null }, headersOut);
      }
      if (action.type === "respond") {
        if (action.text !== undefined) return new Response(action.text, { status: action.status ?? 200, headers: action.headers ?? {} });
        return json(action.status ?? 200, action.body ?? { success: false, errors: [E.serverError], messages: [], result: null }, action.headers);
      }
      if (action.type === "drop") {
        handle(entry, { tok, isOauth, body }); // サーバーの側では成立させる
        throw networkError();
      }
      if (action.type === "truncate") {
        // サーバーの側では成立させ、状態コードと見出しは届くが、本文の読みが途中で切れる
        const real = handle(entry, { tok, isOauth, body });
        return { status: real.status, headers: real.headers, text: async () => { throw new TypeError("terminated"); } };
      }
      throw new Error(`createFakeCf: 差し込みの type が違う: ${String(action.type)}`);
    }
    return handle(entry, { tok, isOauth, body });
  }

  // ---- テストから使う口 ----

  return {
    fetch,
    /** 偽物の時計。createCf の now に渡す */
    now: clock,
    /** 時計を ms だけ進める */
    advance(ms) { offset += ms; },
    /** 待った時間を残し、時計を進める sleep。createCf の sleep に渡してよい */
    async sleep(ms) { sleeps.push(ms); offset += ms; },
    get sleeps() { return [...sleeps]; },

    /**
     * トークンを置く(人が画面で作った親・記録に無い同名・User API Token など)。
     * permissions は権限の名前。zoneIds はゾーン単位の権限の対象。policies を渡せば、そのまま使う(名前の無い権限は ID から補う)
     * @returns 置いたトークンの写し(value・id を含む)
     */
    addToken({ name, permissions = [], zoneIds = [], resources, policies, not_before = null, expires_on = null, status = "active", kind = "account", account = accountId, value, id } = {}) {
      if (typeof name !== "string") throw new Error("createFakeCf.addToken: name を渡す");
      const id2 = id ?? nextId();
      const ps = policies
        ? clone(policies).map((p, i) => ({ id: p.id ?? `policy${i + 1}`, ...p, permission_groups: (p.permission_groups ?? []).map((g) => ({ id: g.id ?? groupsByName.get(g.name)?.id, name: g.name ?? groupsById.get(g.id)?.name })) }))
        : policiesFrom({ permissions, zoneIds, resources });
      const t = store({
        id: id2,
        value: value ?? nextValue(),
        name,
        kind,
        accountId: account,
        policies: ps,
        not_before,
        expires_on,
        status,
        deleted: false,
        issued_on: isoSeconds(clock()),
        createdBy: null,
      });
      return snapshot(t);
    },
    /** 人が一覧で消したのと同じ(要求の履歴には残らない) */
    removeToken(id) {
      const t = tokens.get(id);
      if (t) t.deleted = true;
    },
    /** 保存した status を変える("active"・"disabled" など) */
    setStatus(id, status) {
      const t = tokens.get(id);
      if (!t) throw new Error(`createFakeCf.setStatus: ID ${id} のトークンが無い`);
      t.status = status;
    },
    /** 生きているトークン 1 本(消えていれば null) */
    token(id) {
      const t = tokens.get(id);
      return t && !t.deleted ? snapshot(t) : null;
    },
    /** 消したトークン(無ければ null) */
    deletedToken(id) {
      const t = tokens.get(id);
      return t && t.deleted ? snapshot(t) : null;
    },
    /** 値からトークンを引く(消えたものも含む) */
    tokenByValue(v) {
      return snapshot(byValue.get(v) ?? null);
    },
    /** 生きているトークンの一覧(置いた順) */
    tokens() {
      return [...tokens.values()].filter((t) => !t.deleted).map(snapshot);
    },
    /** OAuth の値を足す(/zones だけで使える)。値を返す */
    addOauth(v) {
      const val = v ?? `fakecf_oauth_${++serial}`;
      oauth.add(val);
      return val;
    },
    /** ゾーンを足す */
    addZone(z) {
      zoneList.push({ status: "active", accountId, ...z, entrypoints: new Set(z.entrypoints ?? []) });
    },
    /** ゾーンに phase の entrypoint を作る(無いゾーンの GET は 10003) */
    addEntrypoint(zoneId, phase) {
      const z = zoneList.find((zz) => zz.id === zoneId);
      if (!z) throw new Error(`createFakeCf.addEntrypoint: ゾーン ${zoneId} が無い`);
      z.entrypoints.add(phase);
    },

    inject,
    /** 次の要求(sel で絞れる)を 429 にする。retryAfter は retry-after の値(null で見出しを付けない) */
    rateLimitNext(retryAfter = 2, { times = 1, ...s } = {}) {
      inject({ ...sel(s), times, action: { type: "rateLimit", retryAfter } });
    },
    /** 次の sel の要求の応答を落とす(サーバーの側では成立し、呼び出しには例外) */
    dropNext(s, { times = 1 } = {}) {
      inject({ ...sel(s), times, action: { type: "drop" } });
    },
    /** 次の sel の要求をサーバーの側で成立させ、状態コードは返すが本文の読みを失敗させる(本文が途中で切れた) */
    truncateNext(s, { times = 1 } = {}) {
      inject({ ...sel(s), times, action: { type: "truncate" } });
    },
    /** 次の sel の要求を、サーバーに届けずに通信の失敗にする */
    networkErrorNext(s, { times = 1 } = {}) {
      inject({ ...sel(s), times, action: { type: "networkError" } });
    },
    /** 次の sel の要求に response({ status, body?, text?, headers? })で応える */
    failNext(s, response = { status: 500 }, { times = 1 } = {}) {
      inject({ ...sel(s), times, action: { type: "respond", ...response } });
    },
    /** トークンの一覧の n ページ目を失敗させる(既定は 500) */
    failListPage(n, response = { status: 500 }, { times = 1 } = {}) {
      inject({ route: "listTokens", match: (e) => e.page === n, times, action: { type: "respond", ...response } });
    },
    /**
     * 届き先(ruleset・workerScripts・graphql)を times 回だけ失敗させる。
     * 既定の失敗: ruleset・workerScripts は 403・10000、graphql は 200 で errors
     */
    failReach(r, times = 1, response) {
      const def = r === "graphql"
        ? { status: 200, body: { data: null, errors: [{ message: "authentication error (fake)", extensions: { code: "authz" } }] } }
        : { status: 403, body: { success: false, errors: [E.authError], messages: [], result: null } };
      inject({ route: r, times, action: { type: "respond", ...(response ?? def) } });
    },

    /** 送った要求の履歴(順)。値は入れない。各要素 = { seq, method, path, query, route, tokenId, auth, page?, id?, zoneId?, phase?, body? } */
    get requests() { return history.map((e) => ({ ...e })); },
    /** 履歴の数。引数は route の名前か { method?, route?, path?, match? } */
    count(s = {}) {
      const f = sel(s);
      return history.filter((e) =>
        (!f.route || e.route === f.route) && (!f.method || e.method === f.method) && (!f.path || e.path === f.path) && (!f.match || f.match(e))).length;
    },
    clearRequests() { history.length = 0; },
  };
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
