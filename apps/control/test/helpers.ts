import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { sql } from "kysely";
import { expect, vi } from "vitest";
import { kvKeys, SITE_REMOVED_SEQ, type StaticDeployer, type StaticDeployRequest, type StaticDeployResult, type StaticGeneration, type StaticRemoveRequest, type StaticSiteStatus } from "@wtt/core";
import app from "../src/index";
import { getDb, type ExperimentRow, type SiteRow } from "../src/db";
import type { Env } from "../src/env";
import { ErrorEnvelopeSchema } from "../src/openapi";

export const SETUP_TOKEN = "test-setup-token"; // vitest.config.ts の miniflare.bindings と一致

/** 決定 46 (2): テストでパスワード経路を開けるときの envOverride(16 文字以上) */
export const BREAK_GLASS = { AB_BREAK_GLASS_TOKEN: "test-break-glass-token-0123456789" } as const;

// Rate Limiting binding のウィンドウは period 秒ごとの壁時計固定枠(miniflare 実装)。
// 連続試行が境界をまたぐと数え直しになるので、残りが短ければ次の枠の頭まで待つ
export async function alignToWindow() {
  const PERIOD_MS = 10_000;
  const remaining = PERIOD_MS - (Date.now() % PERIOD_MS);
  if (remaining < 5_000) await new Promise((r) => setTimeout(r, remaining + 50));
}

/**
 * テストの env。wrangler.jsonc の services から vitest が作る DEPLOYER(本物の wtt-deployer を指す binding)は
 * 外す(出し直しは skipped)。偽物は必要なテストだけ envOverride(または `{ ...testEnv, DEPLOYER: fake }`)で入れる(7i)
 */
export const testEnv = { ...env, DEPLOYER: undefined } as unknown as Env;

export type CallOpts = { token?: string; body?: unknown; headers?: Record<string, string>; envOverride?: Partial<Env>; raw?: BodyInit };

/**
 * AUTH_RATE_LIMITER は IP 単位。レート制限そのものを検証するテスト以外が同じ枠(cf-connecting-ip 無し = "unknown")を
 * 食い合わないよう、明示指定が無ければ呼び出しごとに別 IP を割り当てる。198.18.0.0/15 はベンチマーク用の予約レンジ
 */
let ipSeq = 0;
export function nextTestIp(): string {
  const n = ipSeq++;
  return `198.18.${(n >> 8) & 0xff}.${n & 0xff}`;
}

export async function call(method: string, path: string, opts: CallOpts = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", nextTestIp());
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://control.test${path}`, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) }),
    { ...testEnv, ...opts.envOverride },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let seq = 0;
export function uniqueEmail(prefix = "user"): string {
  return `${prefix}${++seq}-${Date.now()}@example.com`;
}

/** 初回セットアップ: OWNER と Workspace を作る(テスト単位のストレージ隔離なので毎テスト呼べる)。OWNER は Google に link 済みで返る */
export async function setupOwner(): Promise<{ token: string; workspaceId: string; userId: string; email: string }> {
  const email = uniqueEmail("owner");
  const res = await call("POST", "/setup", {
    headers: { "x-setup-token": SETUP_TOKEN },
    body: { email, name: "Owner", workspaceName: "Workspace A" },
  });
  expect(res.status).toBe(201);
  const data = await json<{ workspaceId: string; userId: string }>(res);
  const { token } = await googleSignIn(email);
  expect(token).toBeTruthy();
  return { ...data, token: token!, email };
}

/**
 * 招待 → 受諾までを 1 往復で済ませるヘルパ(Task 2 以降のテストが Role 別の Bearer を作るのに使う)。
 * 戻り値の `memberId` は ADMIN 操作(PATCH / DELETE /workspaces/:wid/members/:memberId)の対象に使う
 */
export async function inviteAndJoin(
  ownerToken: string,
  workspaceId: string,
  role: "admin" | "editor" | "viewer",
  email = uniqueEmail(role),
): Promise<{ token: string; userId: string; email: string; memberId: string }> {
  const inv = await call("POST", `/workspaces/${workspaceId}/invitations`, { token: ownerToken, body: { email, role } });
  expect(inv.status).toBe(201);
  const { id } = await json<{ id: string }>(inv);
  const { token } = await googleSignIn(email, { name: role });
  expect(token).toBeTruthy();
  const acc = await call("POST", `/invitations/${id}/accept`, { token: token! });
  expect(acc.status).toBe(200);
  const data = { token: token!, userId: (await json<{ userId: string }>(acc)).userId };
  const members = await json<Array<{ memberId: string; email: string }>>(
    await call("GET", `/workspaces/${workspaceId}/members`, { token: ownerToken }),
  );
  const memberId = members.find((m) => m.email === email)!.memberId;
  return { ...data, email, memberId };
}

/** 決定 34: 全エラー応答が封筒 { error, message } を持つ */
/**
 * review r2 finding 3: それまでは `error` / `message` の型しか見ておらず、`/openapi.json` が宣言する
 * `ErrorEnvelopeSchema`(path は配列。openapi.ts 参照)と実際の応答本文が一度も突き合わされていなかった
 * — その結果 `invalid_analytics` / `invalid_settings` が path に文字列を積んで契約に違反していても
 * どのテストも検知できなかった(finding 2 の実体)。ここで実際の封筒を契約の zod schema でパースし、
 * 配列でない path が来たら二度と見逃さないようにする
 */
export async function expectEnvelope(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.error).toBe("string");
  expect(typeof body.message).toBe("string");
  ErrorEnvelopeSchema.parse(body);
  return body;
}

/** 失敗注入された statement の目印(`batch` は run/first/all を呼ばないので、SQL ではなくこの印で見分ける) */
const FAILING_STMT = Symbol.for("wtt.failingD1Statement");

/** `insert into "<table>"` で始まる SQL だけを throw させる D1 ラッパ(setup の原子性テスト用 / Task 3 の site_hosts batch 用) */
export function failingD1Insert(db: D1Database, table: string): D1Database {
  const boom = async () => { throw new Error(`injected d1 insert failure for ${table}`); };
  // kysely-d1 は prepare().bind(...).all() の順に呼ぶ。bind() は新しい statement を返すため、
  // 包み直さないと proxy を抜けて本物の statement が実行されてしまう
  const failing = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(s, p) {
        if (p === FAILING_STMT) return true;
        if (p === "run" || p === "first" || p === "all" || p === "raw") return boom;
        if (p === "bind") return (...args: unknown[]) => failing(s.bind(...args));
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sqlText: string) => {
          const stmt = target.prepare(sqlText);
          if (!new RegExp(`^\\s*insert into "?${table}"?`, "i").test(sqlText)) return stmt;
          return failing(stmt);
        };
      }
      // `batch` は statement の中身を直接読むので run/first/all の proxy を素通りしてしまう(実測)。
      // 対象テーブルへの insert が 1 つでも混ざっていれば batch 全体を失敗させる(D1 の batch は 1 トランザクション)
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          if (stmts.some((s) => (s as unknown as Record<symbol, unknown>)[FAILING_STMT] === true)) return boom();
          return target.batch(stmts);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

/**
 * 任意の SQL(select 含む)にマッチする D1 statement を先頭から `times` 回だけ throw させる汎用ラッパ。
 * `failingD1Insert` は insert 固定だが、こちらは SQL を正規表現で選ぶ。`batch` は statement の中身を直接読んで
 * run/first/all の proxy を素通りするため、`failingD1Insert` と同じく印(FAILING_STMT)で見分け、印のある statement が混ざる batch 全体を失敗させる
 * (D10 Task 5: setup の完了の書き込みが batch になった)
 * (Task 8: `reconcileActive` の初回 select だけを狙い撃ちして GET /sites/:sid の red-check に使う)
 */
export function failingD1Query(db: D1Database, sqlPattern: RegExp, times = 1): D1Database {
  let failed = 0;
  const boom = async () => { throw new Error(`injected d1 query failure for ${sqlPattern}`); };
  const failing = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(s, p) {
        if (p === FAILING_STMT) return true;
        if (p === "run" || p === "first" || p === "all" || p === "raw") return boom;
        if (p === "bind") return (...args: unknown[]) => failing(s.bind(...args));
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sqlText: string) => {
          const stmt = target.prepare(sqlText);
          if (!sqlPattern.test(sqlText) || failed >= times) return stmt;
          failed++;
          return failing(stmt);
        };
      }
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          if (stmts.some((s) => (s as unknown as Record<symbol, unknown>)[FAILING_STMT] === true)) return boom();
          return target.batch(stmts);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

/**
 * `batch` の直前に `hook` を 1 回だけ実行してから本物の batch に委ねる D1 ラッパ。それ以外の呼び出しは素通し。
 * (D10 最終レビュー finding 2: setup の完了を書く直前に、別のリクエストが stale の lock を取り直した状態を作る)
 */
export function beforeD1Batch(db: D1Database, hook: () => Promise<unknown>): D1Database {
  let ran = false;
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          if (!ran) {
            ran = true;
            await hook();
          }
          return target.batch(stmts);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

/** Site を 1 つ作る(Task 3 以降のテストが Site 配下のルートを叩くのに使う) */
export async function createSite(token: string, workspaceId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { name: "Site", domain: "www.example.com", ...overrides } });
  expect(res.status).toBe(201);
  return json(res);
}

/** KV の失敗注入(Task 6 の publish.test.ts でも使う)。pattern に一致するキーの put(または get)で `times` 回だけ throw し、それ以降は本物に委譲する */
export function failingKv(pattern: RegExp, op: "put" | "get" = "put", times = Infinity): KVNamespace {
  let failed = 0;
  return new Proxy(env.CONFIG_KV, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === op)
        return async (key: string, ...rest: unknown[]) => {
          if (pattern.test(key) && failed < times) {
            failed++;
            throw new Error(`injected kv ${op} failure for ${key}`);
          }
          // 本物に委譲する。`this` を失うと workerd の binding が動かないので apply で target に束ねる
          return (target[op] as (...a: unknown[]) => unknown).apply(target, [key, ...rest]);
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as KVNamespace;
}

/** Experiment を 1 つ作る(Task 5 以降のテストが Variant / Change のルートを叩くのに使う)。既定 Variant a / b 付きで返る */
export async function createExperiment(token: string, siteId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await call("POST", `/sites/${siteId}/experiments`, {
    token,
    body: { id: `exp_${randomSuffix()}`, name: "Hero", urlMatch: { op: "contains", value: "/" }, ...overrides },
  });
  expect(res.status).toBe(201);
  return json(res);
}
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** 最小の正常系 Change(core の ChangeSchema の形) */
export const TEXT_CHANGE = (id = "c_text") => ({ id, type: "TEXT", selector: ".hero-title", payload: { text: "Hello" } });

/** Task 7 の /status が入るまでの直接更新(テスト専用)。status 変更の自動 Publish は通らない */
export async function runDirect(sid: string, eid: string, status = "running"): Promise<void> {
  await sql`update experiments set status = ${status}, updated_at = ${Date.now()} where site_id = ${sid} and id = ${eid}`.execute(getDb(env));
}

/** POST /sites/:sid/publish(失敗も 200 + ok:false で返るので status を見る用途にも使う) */
export const publishRes = (token: string, sid: string, envOverride?: Partial<Env>): Promise<Response> =>
  call("POST", `/sites/${sid}/publish`, { token, envOverride });

/** running な Experiment(TEXT Change 1 件)を持つ Site。publish.test.ts / unpublished.test.ts が使う */
export async function siteWithRunning(): Promise<{ owner: Awaited<ReturnType<typeof setupOwner>>; sid: string; eid: string }> {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_hero" });
  await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
  await runDirect(sid, eid);
  return { owner, sid, eid };
}

/** KV の active レコード(= 配信中の version の文字列) */
export const active = (sid: string): Promise<string | null> => env.CONFIG_KV.get(kvKeys.active(sid));

/** D1 の sites 行(active_version / active_kv_stale の記帳を直接見る用) */
export async function siteRow(sid: string): Promise<SiteRow> {
  return getDb(env).selectFrom("sites").selectAll().where("id", "=", sid).executeTakeFirstOrThrow();
}

/** D1 の experiments 行(started_at / stopped_at など experimentJson に出ない列を直接見る用。Task 7 の status テストが使う) */
export async function experimentRow(sid: string, eid: string): Promise<ExperimentRow> {
  return getDb(env).selectFrom("experiments").selectAll().where("site_id", "=", sid).where("id", "=", eid).executeTakeFirstOrThrow();
}

/** admin が Cookie に入れる flow ID の代わり(routes/oauth.ts の FLOW_RE に合う形) */
export const TEST_FLOW = "test-flow-0123456789abcdef";

/** Google の token endpoint だけを差し替える。id_token は Better Auth が decode するだけ(署名検証しない)なので無署名で足りる */
export function mockGoogle(profile: { email: string; sub?: string; name?: string; emailVerified?: boolean }) {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const idToken = [
    b64({ alg: "RS256", typ: "JWT", kid: "test" }),
    b64({
      iss: "https://accounts.google.com",
      sub: profile.sub ?? `g-${profile.email}`,
      email: profile.email,
      email_verified: profile.emailVerified ?? true,
      name: profile.name ?? "Google User", // btoa は ASCII のみ
    }),
    "sig",
  ].join(".");
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "test-access-token", id_token: idToken, token_type: "Bearer", expires_in: 3600, scope: "openid email profile" });
    }
    return real(input as RequestInfo, init);
  });
}

/** start → callback までを通し、callback の応答をそのまま返す(受け渡しの性質を見るテスト用) */
export async function googleCallback(
  email: string,
  opts: { next?: string; name?: string; sub?: string; emailVerified?: boolean; envOverride?: Partial<Env> } = {},
): Promise<Response> {
  const spy = mockGoogle({ email, name: opts.name, sub: opts.sub, emailVerified: opts.emailVerified });
  try {
    const { state, cookie } = await googleStart(opts.next);
    // Cookie は start が出したものをすべて持ち帰る(Better Auth の state Cookie と、control の state 結びつけ Cookie)
    const cb = await call("GET", `/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie },
      ...(opts.envOverride ? { envOverride: opts.envOverride } : {}),
    });
    expect(cb.status).toBe(302);
    return cb;
  } finally {
    spy.mockRestore();
  }
}

/** Google ログインの入口を叩き、Google へ送られる state と、control が張った Cookie を返す */
export async function googleStart(next?: string): Promise<{ state: string; cookie: string }> {
  const q = new URLSearchParams({ flow: TEST_FLOW });
  if (next) q.set("next", next);
  const start = await call("GET", `/auth/google/start?${q}`);
  expect(start.status).toBe(302);
  return {
    state: new URL(start.headers.get("location")!).searchParams.get("state")!,
    cookie: start.headers.getSetCookie().map((v) => v.split(";")[0]).join("; "),
  };
}

/**
 * Google ログインを最後まで通す(start → callback → 使い捨てコードの交換)。
 * 成功なら Bearer に使えるセッショントークン、失敗なら token: null と admin の /login?error=… の location を返す
 */
export async function googleSignIn(
  email: string,
  opts: { next?: string; name?: string; sub?: string; emailVerified?: boolean } = {},
): Promise<{ token: string | null; location: string }> {
  const cb = await googleCallback(email, opts);
  const location = cb.headers.get("location")!;
  const code = new URL(location).searchParams.get("code");
  if (!code) return { token: null, location };
  const exchanged = await call("POST", "/auth/handoff/exchange", { body: { code } });
  expect(exchanged.status).toBe(200);
  return { token: (await json<{ token: string }>(exchanged)).token, location };
}

/** POST /setup の Request(セットアップトークン付き) */
export function setupReq(email = "owner@example.com"): Request {
  return new Request("http://control.test/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-token": SETUP_TOKEN, "cf-connecting-ip": nextTestIp() },
    body: JSON.stringify({ email, name: "Owner", workspaceName: "Workspace A" }),
  });
}

/**
 * 偽のデプロイ専用の Worker(7i)。受けた依頼を控え、応答は mode で決める。
 * setTombstone(epoch) = その epoch 以下の依頼には、削除の墓標を受け付けて配り終えたと答える(削除の途中で止まって墓標だけが残った状態。本物と同じく古い世代は捨てる)。
 * setTombstone(epoch, deployedGen) = 墓標は受け付けただけで配り終えていない(accepted = 墓標 / deployed = deployedGen。CF API の失敗で alarm の再試行待ち)。state は pending
 * onRemove(fn) = removeSite の応答の前に fn を呼ぶ(削除の途中に別の操作を差し込む)。fn が結果を返したら、それを応答にする
 */
export function fakeDeployer(mode: "deploy" | "pending" | "throw" | "hang" = "deploy") {
  const deploys: StaticDeployRequest[] = [];
  const removes: StaticRemoveRequest[] = [];
  let status: StaticSiteStatus = { accepted: null, deployed: null, deployedAt: null, history: [], historyFrom: null, pending: false, lastError: null };
  let tombstone: number | null = null;
  let tombstoneDeployed: StaticGeneration | null | undefined; // undefined = 配り終えた墓標 / それ以外 = 受け付けただけで deployed がこの世代
  let removeHook: ((req: StaticRemoveRequest) => Promise<StaticDeployResult | void>) | null = null;
  const answer = async (gen: StaticGeneration): Promise<StaticDeployResult> => {
    if (mode === "throw") throw new Error("binding down");
    if (mode === "hang") return new Promise(() => {});
    if (mode === "pending") return { state: "pending", accepted: gen, deployed: null, deployedAt: null, error: "HTTP 503" };
    if (tombstone !== null && gen.epoch <= tombstone) {
      const t = { epoch: tombstone, seq: SITE_REMOVED_SEQ };
      if (tombstoneDeployed !== undefined) return { state: "pending", accepted: t, deployed: tombstoneDeployed, deployedAt: null, error: "HTTP 503" };
      return { state: "deployed", accepted: t, deployed: t, deployedAt: new Date().toISOString() };
    }
    const at = new Date().toISOString();
    const history = [{ generation: gen, deployedAt: at }, ...status.history];
    status = { accepted: gen, deployed: gen, deployedAt: at, history, historyFrom: null, pending: false, lastError: null };
    return { state: "deployed", accepted: gen, deployed: gen, deployedAt: at };
  };
  const d: StaticDeployer & {
    deploys: typeof deploys;
    removes: typeof removes;
    setStatus(s: StaticSiteStatus): void;
    setTombstone(epoch: number, deployedGen?: StaticGeneration | null): void;
    onRemove(fn: (req: StaticRemoveRequest) => Promise<StaticDeployResult | void>): void;
  } = {
    deploys, removes,
    setStatus(s) { status = s; },
    setTombstone(epoch, deployedGen) { tombstone = epoch; tombstoneDeployed = deployedGen; },
    onRemove(fn) { removeHook = fn; },
    async redeploySite(req) { deploys.push(req); return answer(req.generation); },
    async removeSite(req) {
      removes.push(req);
      const r = removeHook ? await removeHook(req) : undefined;
      return r ?? answer(req.generation);
    },
    async siteStatus() { return status; },
  };
  return d;
}

/** 状態の問い合わせの応答(世代 g が at に配られている) */
export const statusOf = (g: StaticGeneration, at = "2026-10-05T00:00:00.000Z"): StaticSiteStatus => ({ accepted: g, deployed: g, deployedAt: at, history: [{ generation: g, deployedAt: at }], historyFrom: null, pending: false, lastError: null });
