import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { sql } from "kysely";
import { expect, vi } from "vitest";
import {
  compareGeneration,
  kvKeys,
  nextUtcMidnight,
  SITE_REMOVED_SEQ,
  staticInputDigest,
  utcDay,
  type StaticBatchDeployRequest,
  type StaticDeployer,
  type StaticDeployHistoryEntry,
  type StaticDeployRequest,
  type StaticDeployResult,
  type StaticGeneration,
  type StaticInstanceStatus,
  type StaticRemoveRequest,
  type StaticSiteStatus,
} from "@wtt/core";
import { app } from "../src/index";
import { edgeOrigin } from "../src/capabilities";
import { siteToSettings } from "../src/site-settings";
import { installHashOf } from "../src/domain-probe";
import { createWorkspace, grantInstanceAdmin } from "../src/instance-admins";
import { getDb, type ExperimentRow, type SiteRow } from "../src/db";
import type { BudgetStatus, Env, LeaseResult, ReadReservation, ResultsBudgetRpc, ResultsHealthRpc, StopPeriod, StopReason } from "../src/env";
import { ErrorEnvelopeSchema } from "../src/openapi";
import { actorFromUser, auditStatement, type UserActor } from "../src/audit";

export const SETUP_TOKEN = "test-setup-token"; // vitest.config.ts の miniflare.bindings と一致

/** 決定 46 (2): テストでパスワード経路を開けるときの envOverride(16 文字以上) */
export const BREAK_GLASS = { AB_BREAK_GLASS_TOKEN: "test-break-glass-token-0123456789" } as const;

/** `wrangler.jsonc` の `AUTH_RATE_LIMITER`(`simple.limit`)と同じ値。上限の回数を数えるテストはこれを使い、数値を直書きしない(7q) */
export const AUTH_RATE_LIMIT = 30;

// Rate Limiting binding のウィンドウは period 秒ごとの壁時計固定枠(miniflare 実装)。
// 連続試行が境界をまたぐと数え直しになるので、残りが短ければ次の枠の頭まで待つ。
// `fresh: true` は残りにかかわらず次の窓の頭まで待つ(上限の回数を数えるテスト用。
// 窓の途中から始めると、AUTH_RATE_LIMIT + 1 回の送信の途中で窓が変わり数え直しになりうる)
export async function alignToWindow(opts: { fresh?: boolean } = {}) {
  const PERIOD_MS = 10_000;
  const remaining = PERIOD_MS - (Date.now() % PERIOD_MS);
  if (opts.fresh || remaining < 5_000) await new Promise((r) => setTimeout(r, remaining + 50));
}

/**
 * テストの env。wrangler.jsonc の services から vitest が作る DEPLOYER(本物の wtt-deployer を指す binding)は
 * 外す(出し直しは skipped)。偽物は必要なテストだけ envOverride(または `{ ...testEnv, DEPLOYER: fake }`)で入れる(7i)。
 * 計測用 D1(RESULTS_DB)も既定で外す(D9 ② の本番の control と同じ「無い」状態。plan ② の K21)。有りにするのは `testEnvWith({ resultsStore: true })` か envOverride の RESULTS_STORE
 */
export function testEnvWith(opts: { resultsStore?: boolean } = {}): Env {
  return { ...env, DEPLOYER: undefined, RESULTS_DB: opts.resultsStore ? env.RESULTS_DB : undefined } as unknown as Env;
}
export const testEnv = testEnvWith();

/**
 * D9 ②: 計測用 D1 がある導入にする envOverride(`call(…, { envOverride: RESULTS_STORE })`)。
 * D9 ③(K5): 出どころは wrangler.jsonc の RESULTS_DB の binding だけ(vitest.config.ts は上書きしない。test/apply-migrations.ts が表を当てる)
 */
export const RESULTS_STORE: Partial<Env> = { RESULTS_DB: env.RESULTS_DB };

/**
 * D9 ③(K5・K12・K13): 偽の予算の DO(edge の apps/edge/src/results-budget.ts の意味を写す。日付は 1 日分だけ持つ)。
 * - lease: 停止中なら ok: false。残りが求めた行数より少なければ残りだけ。残りをすべて配ったら write_budget の停止を次の UTC 0 時まで立てる。
 *   `grantAtMost` は 1 回に配る上限(status を読んだ後に edge が枠を使った、のような部分の枠を作る)
 * - reserveRead: 解けていない予約(60 秒以内・未精算)があれば busy、残りが足りなければ budget。予約した時点で見込みを使ったものとして数える
 * - settleRead: 実際の行数で精算(同じ token の 2 回目・知らない token は何もしない)
 * - status / stopPeriods: 今の状態。`stopPeriods` で決まった期間を足せる
 * calls = 呼ばれた順の記録。log を渡すと同じ記録を `<method>:<args>` の文字列でも足す(D1 の呼び出しと順を比べるテスト用)
 */
export type FakeBudgetOpts = {
  writeBudget?: number; writeUsed?: number; readBudget?: number; readUsed?: number; leaseRows?: number;
  stoppedUntil?: number | null; stopPeriods?: StopPeriod[]; grantAtMost?: number; log?: string[];
};
export type FakeBudgetCall = { method: "lease" | "reserveRead" | "settleRead" | "status" | "stopPeriods" | "stop"; args: unknown[]; result?: unknown };
export function fakeResultsBudget(opts: FakeBudgetOpts = {}) {
  const state = {
    writeBudget: opts.writeBudget ?? 70_000,
    writeUsed: opts.writeUsed ?? 0,
    readBudget: opts.readBudget ?? 3_000_000,
    readUsed: opts.readUsed ?? 0,
    leaseRows: opts.leaseRows ?? 200,
    stoppedUntil: opts.stoppedUntil ?? null,
    stops: [...(opts.stopPeriods ?? [])] as StopPeriod[],
  };
  const reservations = new Map<string, { day: string; rows: number; expiresAt: number; settled: boolean }>();
  const calls: FakeBudgetCall[] = [];
  const names: string[] = [];
  let tokenSeq = 0;
  const record = <T>(method: FakeBudgetCall["method"], args: unknown[], result: T): T => {
    calls.push({ method, args, result });
    opts.log?.push(`${method}:${JSON.stringify(args)}->${JSON.stringify(result)}`);
    return result;
  };
  const activeStop = (now: number): number | null => (state.stoppedUntil !== null && state.stoppedUntil > now ? state.stoppedUntil : null);
  const openStop = (reason: StopReason, until: number, now: number) => {
    const end = Math.min(until, nextUtcMidnight(now));
    if (end <= now) return;
    state.stops.push({ reason, from: now, to: end });
    state.stoppedUntil = Math.max(state.stoppedUntil ?? 0, end);
  };
  const stub: Pick<ResultsBudgetRpc, "stop" | "lease" | "reserveRead" | "settleRead" | "status" | "stopPeriods"> = {
    async stop(reason, until, now) {
      openStop(reason, until, now);
      record("stop", [reason, until, now], undefined);
    },
    async lease(day, rows, now): Promise<LeaseResult> {
      if (!Number.isSafeInteger(rows) || rows < 1) throw new TypeError(`invalid rows: ${rows}`);
      const stopped = activeStop(now);
      if (stopped !== null) return record("lease", [day, rows, now], { ok: false, stoppedUntil: stopped });
      const remaining = state.writeBudget - state.writeUsed;
      if (remaining <= 0) {
        openStop("write_budget", nextUtcMidnight(now), now);
        return record("lease", [day, rows, now], { ok: false, stoppedUntil: activeStop(now) ?? nextUtcMidnight(now) });
      }
      const given = Math.min(rows, remaining, opts.grantAtMost ?? Infinity);
      state.writeUsed += given;
      if (given === remaining) openStop("write_budget", nextUtcMidnight(now), now);
      return record("lease", [day, rows, now], { ok: true, day, rows: given });
    },
    async reserveRead(day, rows, now): Promise<ReadReservation> {
      if (!Number.isSafeInteger(rows) || rows < 1) throw new TypeError(`invalid rows: ${rows}`);
      const busy = [...reservations.values()].some((r) => !r.settled && r.expiresAt > now);
      if (busy) return record("reserveRead", [day, rows, now], { ok: false, reason: "busy" });
      if (state.readBudget - state.readUsed < rows) return record("reserveRead", [day, rows, now], { ok: false, reason: "budget" });
      const token = `tok_${++tokenSeq}`;
      const expiresAt = now + 60_000;
      state.readUsed += rows;
      reservations.set(token, { day, rows, expiresAt, settled: false });
      return record("reserveRead", [day, rows, now], { ok: true, token, expiresAt });
    },
    async settleRead(token, actualRows) {
      if (!Number.isSafeInteger(actualRows) || actualRows < 0) throw new TypeError(`invalid rows: ${actualRows}`);
      const r = reservations.get(token);
      if (r && !r.settled) {
        r.settled = true;
        state.readUsed = Math.max(0, state.readUsed + actualRows - r.rows);
      }
      record("settleRead", [token, actualRows], undefined);
    },
    async status(now): Promise<BudgetStatus> {
      const open = [...reservations.values()].filter((r) => !r.settled && r.expiresAt > now).sort((a, b) => b.expiresAt - a.expiresAt)[0];
      return record("status", [now], {
        day: utcDay(now),
        writeBudget: state.writeBudget,
        writeUsed: state.writeUsed,
        readBudget: state.readBudget,
        readUsed: state.readUsed,
        leaseRows: state.leaseRows,
        stoppedUntil: activeStop(now),
        readReservation: open ? { day: open.day, rows: open.rows, expiresAt: open.expiresAt } : null,
      });
    },
    async stopPeriods(from, to): Promise<StopPeriod[]> {
      const periods = state.stops.filter((s) => s.to > from && s.from < to).sort((a, b) => a.from - b.from);
      return record("stopPeriods", [from, to], periods);
    },
  };
  const ns = {
    idFromName: (name: string) => {
      names.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get: () => stub,
  } as unknown as DurableObjectNamespace<ResultsBudgetRpc>;
  return { ns, calls, names, state, stub };
}

/** D9 ③(K5): 偽の収集の失敗の記録の DO。failed = run ごとの [{ hour, failed }]。read は edge と同じく半開区間 [fromHour, toHour) の時の昇順 */
export function fakeResultsHealth(failed: Record<string, Array<{ hour: number; failed: number }>> = {}) {
  const calls: Array<{ siteId: string; runId: string; fromHour: number; toHour: number }> = [];
  let lastName = "";
  const ns = {
    idFromName: (name: string) => {
      lastName = name;
      return { name } as unknown as DurableObjectId;
    },
    get: (id: { name: string }) => {
      const siteId = id?.name ?? lastName;
      const stub = {
        async read(runId: string, fromHour: number, toHour: number) {
          calls.push({ siteId, runId, fromHour, toHour });
          return (failed[runId] ?? []).filter((r) => r.hour >= fromHour && r.hour < toHour).sort((a, b) => a.hour - b.hour);
        },
      };
      return stub as unknown as ResultsHealthRpc;
    },
  } as unknown as DurableObjectNamespace<ResultsHealthRpc>;
  return { ns, calls };
}

/** 計測用 D1 の visitor_key(16 バイト)。数を渡すと決まった値を作る */
export function visitorKey(n: number): Uint8Array {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, n >>> 0);
  v.setUint32(12, Math.imul(n, 2654435761) >>> 0);
  return b;
}
export type SeedParticipant = {
  runId: string; siteId: string; visitor: number | Uint8Array; variantId?: string; exposedAt?: number; device?: "desktop" | "mobile" | "tablet";
  applied?: "ok" | "failed" | "recovered"; mixed?: 0 | 1; mixedAt?: number | null; recoveredAt?: number | null; failedAt?: number | null;
};
export type SeedConversion = { runId: string; goalId: string; visitor: number | Uint8Array; convertedAt?: number };
/** D9 ③(K5): 計測用 D1(env.RESULTS_DB)に個票を入れる。列は edge の results-migrations/ の形。500 文ずつの batch */
export async function seedResults(rows: { participants?: SeedParticipant[]; conversions?: SeedConversion[] }): Promise<void> {
  const db = env.RESULTS_DB!;
  const key = (v: number | Uint8Array) => (typeof v === "number" ? visitorKey(v) : v);
  const stmts: D1PreparedStatement[] = [];
  for (const p of rows.participants ?? [])
    stmts.push(
      db
        .prepare(
          "INSERT INTO participants (run_id, visitor_key, site_id, variant_id, exposed_at, device, applied, mixed, mixed_at, recovered_at, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(p.runId, key(p.visitor), p.siteId, p.variantId ?? "a", p.exposedAt ?? 1, p.device ?? "desktop", p.applied ?? "ok", p.mixed ?? 0, p.mixedAt ?? null, p.recoveredAt ?? null, p.failedAt ?? null),
    );
  for (const c of rows.conversions ?? [])
    stmts.push(db.prepare("INSERT INTO conversions (run_id, goal_id, visitor_key, converted_at) VALUES (?, ?, ?, ?)").bind(c.runId, c.goalId, key(c.visitor), c.convertedAt ?? 2));
  for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500));
}

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

/**
 * B129 Task 7: publishSite を直接呼ぶテストの操作した人(公開の記録の actor。published_by は userId)。
 * 経路は google(setupOwner の OWNER は Google のログイン)。控えのメール・名前は持たない
 */
export const userActor = (userId: string): UserActor => ({ via: "google", userId, email: null, name: null, apiKeyId: null, apiKeyName: null });

/**
 * テストの準備を軽くする直書き(2026-11-03、テストの見直し): user・Google の account・session を D1 に直接入れる。
 * 以前の setupOwner は POST /setup → Google ログインの偽の流れ(start → callback → 交換)の 4 往復で、
 * /setup の中の sign-up がパスワードの hash(scrypt)を計算し、ほぼ全テスト(639 回)がここから始まるので control のテストの
 * 所要時間の大半を占めていた。/setup・Google ログイン・招待の受諾の経路そのものは auth.test.ts・oauth.test.ts・
 * workspaces.test.ts が HTTP で見る(ここを直書きにしても経路の検査は減らない)。
 * 行の形は本物の経路が作るものに揃える: emailVerified = 1、Google の account(accountId は mockGoogle の sub と同じ)、
 * session.loginMethod = 'google'、有効期限 7 日(Better Auth の既定)
 */
export async function seedUser(email: string, name: string): Promise<string> {
  const userId = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (?1, ?2, ?3, 1, ?4, ?4)`).bind(userId, name, email, now),
    env.DB.prepare(`insert into account (id, "accountId", "providerId", "userId", scope, "createdAt", "updatedAt") values (?1, ?2, 'google', ?3, 'openid email profile', ?4, ?4)`).bind(
      crypto.randomUUID().replace(/-/g, ""),
      `g-${email}`,
      userId,
      now,
    ),
  ]);
  return userId;
}

/**
 * その人のセッションを D1 に直接入れて、Bearer を返す。
 * 返す値は署名の無い token そのもの(bearer プラグインが自分で署名して Cookie に写す。`sessionTokenOf` を通しても同じ値)
 */
export async function seedSession(userId: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const now = Date.now();
  await env.DB.prepare(
    `insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId", "loginMethod")
     values (?1, ?2, ?3, ?4, ?4, '127.0.0.1', 'vitest', ?5, 'google')`,
  )
    .bind(crypto.randomUUID().replace(/-/g, ""), new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(), token, new Date(now).toISOString(), userId)
    .run();
  return token;
}

/**
 * 初回セットアップ: OWNER と Workspace を作る(テスト単位のストレージ隔離なので毎テスト呼べる)。OWNER は Google に link 済みで返る。
 * POST /setup と同じ順(システム管理者に登録 → ワークスペース作成 → lock を完了)を、同じ関数(instance-admins.ts)で直接呼ぶ。
 * /setup の HTTP の経路(トークン・lock・補償)は auth.test.ts が見る
 */
export async function setupOwner(): Promise<{ token: string; workspaceId: string; userId: string; email: string }> {
  const email = uniqueEmail("owner");
  const userId = await seedUser(email, "Owner");
  await grantInstanceAdmin(testEnv, userId, null);
  const workspaceId = await createWorkspace(testEnv, "Workspace A");
  // 以後の POST /setup を閉じる(本物の /setup と同じ完了の行)。素の insert にして、行がもうある(前のテストの残り・
  // 同じテストでの 2 回目の呼び出し・先に /setup を通した)ときは、上書きせずにここで落とす。
  // B129: 本物の /setup は完了の batch で setup.complete を 1 行記録するので、同じ batch でその行も入れる(行の形を本物に揃える)
  await env.DB.batch([
    env.DB.prepare("insert into setup_lock (id, created_at, completed) values (1, ?1, 1)").bind(Date.now()),
    auditStatement(env.DB, actorFromUser({ id: userId, email, name: "Owner" }, "setup"), {
      action: "setup.complete",
      workspaceId,
      target: { type: "workspace", id: workspaceId, label: "Workspace A" },
    }),
  ]);
  const token = await seedSession(userId);
  return { token, workspaceId, userId, email };
}

/**
 * 招待 → 受諾までを 1 往復で済ませるヘルパ(Task 2 以降のテストが Role 別の Bearer を作るのに使う)。
 * 戻り値の `memberId` は ADMIN 操作(PATCH / DELETE /workspaces/:wid/members/:memberId)の対象に使う。
 * Google ログインの偽の流れは 1 回 50 ms ほどで(setupOwner が重かったのは /setup のパスワードの hash)、直書きにしない
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

/**
 * `insert into "<table>"` で始まる SQL だけを throw させる D1 ラッパ(setup の原子性テスト用 / Task 3 の site_hosts batch 用)。
 * message = 投げる例外の文言(既定は注入の印だけ。制約の違反を装うときは D1 の文言を渡す。例: site_hosts の主キーの違反)
 */
/** site_hosts の主キーの違反(同時の保存でホスト名の取り合いに負けた)の D1 の文言 */
export const SITE_HOSTS_PK_VIOLATION = "D1_ERROR: UNIQUE constraint failed: site_hosts.host: SQLITE_CONSTRAINT (injected)";

export function failingD1Insert(db: D1Database, table: string, message = `injected d1 insert failure for ${table}`): D1Database {
  const boom = async () => { throw new Error(message); };
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

/**
 * B129(plan Task 3): `sqlPattern` に合う文を含む最初の batch の直前に、`hook` を 1 回だけ走らせる D1 ラッパ。
 * 1 つの要求が batch を何回も使うとき(初期設定: 昇格・ワークスペースの作成・完了)に、狙った batch の前に別の要求の書き込みを差し込む。
 * batch は文の中身を直接読むので、prepare の SQL を控えておき、包まない本物の文で見分ける(bind は新しい文を返すので控えを移す)。
 * `ran()` = 差し込みが実際に走ったか
 */
export function beforeD1BatchMatching(db: D1Database, sqlPattern: RegExp, hook: () => Promise<unknown>): { db: D1Database; ran(): boolean } {
  let ran = false;
  const sqlOf = new WeakMap<object, string>();
  const remember = (stmt: D1PreparedStatement, sqlText: string): D1PreparedStatement => {
    sqlOf.set(stmt, sqlText);
    const bind = stmt.bind.bind(stmt);
    return Object.assign(stmt, { bind: (...args: unknown[]) => remember(bind(...args), sqlText) });
  };
  const wrapped = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") return (sqlText: string) => remember(target.prepare(sqlText), sqlText);
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          if (!ran && stmts.some((s) => sqlPattern.test(sqlOf.get(s) ?? ""))) {
            ran = true;
            await hook();
          }
          return target.batch(stmts);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db: wrapped, ran: () => ran };
}

/**
 * B112: `sql` が `sqlPattern` に合う最初の文の実行(all / first / run / raw)の直前に、`hook` を 1 回だけ走らせる D1 ラッパ。
 * 判定の照会とその後の処理のあいだに別の要求(セッションの削除など)が割り込んだ状態を作る。
 * `bind` で包み直しても効く(`pausingD1Insert` と同じ包み方。kysely-d1 は prepare().bind().all() で流す)。
 * `ran()` = 差し込みが実際に走ったか(パターンが当たらずに素通りしたテストを、偶然の成功にしないため)
 */
export function beforeD1Query(db: D1Database, sqlPattern: RegExp, hook: () => Promise<unknown>): { db: D1Database; ran(): boolean } {
  let used = false;
  let ran = false;
  const hooked = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(s, p) {
        if (p === "run" || p === "first" || p === "all" || p === "raw") {
          const f = Reflect.get(s, p) as (...a: unknown[]) => Promise<unknown>;
          return async (...args: unknown[]) => {
            if (!ran) {
              ran = true;
              await hook();
            }
            return f.apply(s, args);
          };
        }
        if (p === "bind") return (...args: unknown[]) => hooked(s.bind(...args));
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
  const wrapped = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sqlText: string) => {
          const stmt = target.prepare(sqlText);
          if (used || !sqlPattern.test(sqlText)) return stmt;
          used = true;
          return hooked(stmt);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db: wrapped, ran: () => ran };
}

/**
 * plan12 K13: `insert into "<table>"` の最初の 1 回を、テストが離すまで止める D1 ラッパ(並行した要求の順を作る)。
 * - at: "before" = 本物の insert を出す前で止める / "after" = insert が終わった後、呼び出し元(Better Auth の adapter)へ返す前で止める
 * - reached = 止まった所に着いたら解ける。release() で先へ進める
 * Better Auth の内部には触れない。getAuth は env.DB ごとに組み立てるので、envOverride の DB にこれを渡すと、
 * この D1 を使う Better Auth が別に作られる(adapter の create → kysely-d1 の prepare().bind().all() がここを通る)
 */
export function pausingD1Insert(db: D1Database, table: string, at: "before" | "after"): { db: D1Database; reached: Promise<void>; release(): void } {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const gate = new Promise<void>((r) => (release = r));
  let used = false;
  const pausing = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(s, p) {
        if (p === "run" || p === "first" || p === "all" || p === "raw") {
          const f = Reflect.get(s, p) as (...a: unknown[]) => Promise<unknown>;
          return async (...args: unknown[]) => {
            if (at === "before") {
              reach();
              await gate;
              return f.apply(s, args);
            }
            const out = await f.apply(s, args);
            reach();
            await gate;
            return out;
          };
        }
        if (p === "bind") return (...args: unknown[]) => pausing(s.bind(...args));
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
  const wrapped = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sqlText: string) => {
          const stmt = target.prepare(sqlText);
          if (used || !new RegExp(`^\\s*insert into "?${table}"?\\s`, "i").test(sqlText)) return stmt;
          used = true;
          return pausing(stmt);
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { db: wrapped, reached, release };
}

/**
 * B129(plan Task 2): D1 の往復を数える D1 ラッパ。文 1 つの実行(all / first / run / raw)と、batch(1 回 = 1 往復)を別々に数え、
 * 実行した SQL を順に控える(batch の中の文は `batchSql` に入れる)。往復の上限を数字で固定するテスト
 * (`require_session_adds_no_d1_query`・B129 の各 Task の `*_round_trips_unchanged` など)が使う。
 * getAuth は env.DB ごとに組み立てるので、envOverride の DB にこれを渡すと Better Auth の照会も数えられる。
 * `reset()` で数を 0 に戻す(準備の往復を数えから外す)
 *
 * B179 Task 5: 往復ごとの記録(`trips`)も持つ。各往復が出た時点で他の往復が終わっていなかったか(`parallel`)、
 * 書き込みか(SQL が insert / update / delete / replace で始まる。batch は文ごとに数える)、終わった後の `meta.rows_read` /
 * `meta.rows_written`(`first` / `raw` は meta を返さないので null。batch は文の合計)。`idle()` は出ている往復が
 * すべて終わるまで待つ(await されない処理の往復を次の要求の数に混ぜないため)
 */
export type D1Trip = {
  kind: "query" | "batch";
  sql: string[];
  /** 書き込みの文の数(batch の中を含む) */
  writes: number;
  /** 出た時点で、ほかの往復が終わっていなかった(Promise.all などで同時に出た・await されない処理と重なった) */
  parallel: boolean;
  /** null = meta が無い(first / raw)か、まだ終わっていない */
  rowsRead: number | null;
  rowsWritten: number | null;
  done: boolean;
};
export type D1Counts = { queries: number; batches: number; sql: string[]; batchSql: string[][]; trips: D1Trip[] };
const WRITE_SQL = /^\s*(insert|update|delete|replace)\b/i;
export function countingD1(db: D1Database): { db: D1Database; counts(): D1Counts; reset(): void; idle(): Promise<void> } {
  let state: D1Counts = { queries: 0, batches: 0, sql: [], batchSql: [], trips: [] };
  const inFlight = new Set<Promise<unknown>>();
  type Meta = { rows_read?: number; rows_written?: number } | undefined;
  /** 往復を記録し、終わったら meta を写す。元の promise をそのまま返す(失敗も元のまま呼び出し元へ。控えの側は両方の枝で受けて未処理の reject を作らない) */
  const track = <T>(trip: D1Trip, p: Promise<T>, metasOf: (r: T) => Meta[]): Promise<T> => {
    trip.parallel = inFlight.size > 0;
    state.trips.push(trip);
    inFlight.add(p);
    const settle = () => {
      trip.done = true;
      inFlight.delete(p);
    };
    p.then(
      (r) => {
        const metas = metasOf(r);
        if (metas.length > 0 && metas.every((m) => m !== undefined)) {
          trip.rowsRead = metas.reduce((a, m) => a + Number(m?.rows_read ?? 0), 0);
          trip.rowsWritten = metas.reduce((a, m) => a + Number(m?.rows_written ?? 0), 0);
        }
        settle();
      },
      settle,
    );
    return p;
  };
  const newTrip = (kind: D1Trip["kind"], sql: string[]): D1Trip => ({
    kind,
    sql,
    writes: sql.filter((q) => WRITE_SQL.test(q)).length,
    parallel: false,
    rowsRead: null,
    rowsWritten: null,
    done: false,
  });
  /** 包んだ文 → 本物の文(batch には本物を渡す。batch は文の中身を直接読むため) */
  const real = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();
  const counted = (stmt: D1PreparedStatement, sqlText: string): D1PreparedStatement => {
    const wrapped = new Proxy(stmt, {
      get(s, p) {
        if (p === "run" || p === "first" || p === "all" || p === "raw") {
          const f = Reflect.get(s, p) as (...a: unknown[]) => Promise<unknown>;
          return (...args: unknown[]) => {
            state.queries++;
            state.sql.push(sqlText);
            const withMeta = p === "run" || p === "all";
            return track(newTrip("query", [sqlText]), f.apply(s, args), (r) => (withMeta ? [(r as { meta?: Meta })?.meta] : []));
          };
        }
        if (p === "bind") return (...args: unknown[]) => counted(s.bind(...args), sqlText);
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
    real.set(wrapped, stmt);
    sqlOf.set(wrapped, sqlText);
    return wrapped;
  };
  const wrapped = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") return (sqlText: string) => counted(target.prepare(sqlText), sqlText);
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          state.batches++;
          const sqls = stmts.map((s) => sqlOf.get(s) ?? "?");
          state.batchSql.push(sqls);
          return track(newTrip("batch", sqls), target.batch(stmts.map((s) => real.get(s) ?? s)), (rs) => rs.map((r) => r?.meta as Meta));
        };
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return {
    db: wrapped,
    counts: () => ({
      queries: state.queries,
      batches: state.batches,
      sql: [...state.sql],
      batchSql: state.batchSql.map((b) => [...b]),
      trips: state.trips.map((t) => ({ ...t, sql: [...t.sql] })),
    }),
    reset: () => {
      state = { queries: 0, batches: 0, sql: [], batchSql: [], trips: [] };
    },
    idle: async () => {
      // 終わった往復の後始末が次の往復を出すことがあるので、空になるまで繰り返す
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

/** createSite の既定のドメインの連番 */
let siteDomainSeq = 0;
/**
 * Site を 1 つ作る(Task 3 以降のテストが Site 配下のルートを叩くのに使う)。
 * 既定のドメインは呼ぶたびに登録ドメインそのものが違う形(`www.example-<連番>.com`)にする(B139: 同じ登録ドメインのサイトは訪問者 ID の Cookie の共有の衝突を
 * 避けるために作成で自動の調整を受ける。衝突を確かめるテストは domain と Cookie 名を明示する)。
 * `domain: "x"` は `domains: ["x"]` として送る(B148)。複数の行は `domains` で渡す
 */
export async function createSite(token: string, workspaceId: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  // B148: API は domains だけを受ける。テストの書きやすさのため `domain` は 1 行の domains に読み替える
  const { domain, ...rest } = overrides;
  const domains = domain !== undefined ? [domain] : [`www.example-${++siteDomainSeq}.com`];
  const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { name: "Site", domains, ...rest } });
  expect(res.status).toBe(201);
  return json(res);
}

/**
 * B148 Task 2: Cloudflare 経由の判定(Task 4)を通さずに、D1 の一覧の行の判定を edge にする(一覧に無い値は後ろに足す)。
 * 旧い 3 列・site_hosts・KV はそのまま(次の domains を含む保存が、同じ値の行の判定を保って導き直す)。返すのは一覧の値の並び
 */
export async function seedEdgeDomains(sid: string, values: string[]): Promise<string[]> {
  const rows = JSON.parse((await siteRow(sid)).domains_json) as Array<{ value: string; verdict: string; checkedAt: number | null; triedAt: number | null }>;
  for (const v of values) {
    const at = rows.find((r) => r.value === v);
    if (at) at.verdict = "edge";
    else rows.push({ value: v, verdict: "edge", checkedAt: null, triedAt: null });
  }
  await env.DB.prepare("update sites set domains_json = ? where id = ?").bind(JSON.stringify(rows), sid).run();
  return rows.map((r) => r.value);
}

/**
 * B148 Task 2: Mode B のサイトの一覧を `values` にし、そのうち `edge` の値を Cloudflare 経由として保存する(seedEdgeDomains の後に通常の PATCH)。
 * site_hosts と KV のホストのキーは通常の保存の経路で書かれる
 */
export async function setEdgeDomains(token: string, sid: string, edge: string[], values: string[] = edge): Promise<void> {
  // B148 Task 4: Mode B の保存は判定する。edge に入れない値は偽の edge で 404(outside)にする(このテストの間は続く)
  for (const v of values) if (!edge.includes(v)) fakeEdgePing.set(v, () => new Response("not found", { status: 404 }));
  await env.DB.prepare("update sites set domains_json = '[]' where id = ?").bind(sid).run();
  await seedEdgeDomains(sid, edge);
  const res = await call("PATCH", `/sites/${sid}`, { token, body: { domains: values } });
  expect(res.status).toBe(200);
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
    body: { id: `exp_${randomSuffix()}`, name: "Hero", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] }, ...overrides },
  });
  expect(res.status).toBe(201);
  return json(res);
}
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * D9 ③ Task 5(K8): 結果を記録するサイトでテストを開始する前に、目標を作り(同じサイトに既にあれば使い回す)、
 * 評価計画の判定に使う目標に選ぶ。結果を記録する開始は、判定に使う目標が無いと 422 evaluation_plan_incomplete になる
 */
export async function choosePrimaryGoal(token: string, siteId: string, eid: string, goalId = "g_primary"): Promise<void> {
  const goal = await call("POST", `/sites/${siteId}/goals`, { token, body: { id: goalId, name: "判定に使う目標", type: "CUSTOM", config: {} } });
  expect([201, 409]).toContain(goal.status); // 409 = 同じサイトの別のテストで作成済み(id_taken)
  const plan = await call("PUT", `/sites/${siteId}/experiments/${eid}/evaluation-plan`, { token, body: { plan: { primaryGoalId: goalId } } });
  expect(plan.status).toBe(200);
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

/**
 * B148 Task 3: テストの既定の fetch を偽の edge にする(判定の GET が外へ出ないように)。`/__ab/ping` だけを受け、
 * edge の check.ts と同じく KV の `meta:install` の SHA-256 を返す(印が無ければ 503)。ほかの URL は元の fetch に渡す。
 * ドメインごとに応答を変えるテストは fakeEdgePing.set(host, () => Response) で差し替える(毎テストの前に空にする)。
 * vi.spyOn ではなく直接差し替えるのは、restoreAllMocks で外れないようにするため(test/apply-migrations.ts が入れる)
 */
export const fakeEdgePing = new Map<string, () => Response | Promise<Response>>();
let fakeEdgeInstalled = false;
export function installFakeEdge(): void {
  if (fakeEdgeInstalled) return;
  fakeEdgeInstalled = true;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/__ab/ping") return real(input, init);
    const override = fakeEdgePing.get(url.hostname);
    if (override) return override();
    return fakeEdgeResponse();
  }) as typeof fetch;
}

/** 偽の edge の既定の応答(この導入の edge が答えた形)。差し替えた応答の中で「待ってから edge と答える」ときにも使う */
export async function fakeEdgeResponse(): Promise<Response> {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const marker = await env.CONFIG_KV.get(kvKeys.installMarker);
  if (marker === null || marker === "") return new Response(JSON.stringify({ error: "install marker unavailable" }), { status: 503, headers });
  return new Response(JSON.stringify({ edge: "wtt", install: await installHashOf(marker) }), { status: 200, headers });
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

/** B112: 非常口のパスワードで登録・ログインするテスト用の共通パスワード(break-glass 系のテストが共有する) */
export const BREAK_GLASS_PASSWORD = "password-for-sweep-1";

/**
 * B112: Bearer(`set-auth-token` など。署名つきの Cookie 値 `<token>.<signature>` で、URL エンコードされていることもある)から
 * session 表の token 列の値を取り出す。Bearer の値そのものは token 列と一致しないので、session の行を引くときは必ずこれを通す
 */
export function sessionTokenOf(bearer: string): string {
  return decodeURIComponent(bearer).split(".")[0]!;
}

/**
 * 非常口を開いて、招待からパスワードで登録する(`/sign-up/email`)。
 * 登録で張られたセッションの Bearer も返す(招待の受諾のレスポンスの token)
 */
export async function joinWithPassword(owner: { token: string; workspaceId: string }, role: "editor" | "viewer" = "editor"): Promise<{ email: string; userId: string; token: string }> {
  const email = uniqueEmail("pw");
  const inv = await json<{ id: string }>(await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role } }));
  const acc = await call("POST", `/invitations/${inv.id}/accept`, { body: { name: "Pw", password: BREAK_GLASS_PASSWORD }, envOverride: BREAK_GLASS });
  expect(acc.status).toBe(200);
  const { userId, token } = await json<{ userId: string; token: string }>(acc);
  return { email, userId, token };
}

/**
 * B179: Google で招待を受けた人(Google が確かめたメール)に、非常口の再設定リンクでパスワードの記録を足す。
 * 「パスワードの記録を持ち、Google でもログインできる人」を 1.7 で作れる道(1.7 は未確認のパスワードの人を Google に結びつけないので、
 * joinWithPassword の人は Google でログインできない)。再設定はそれまでのセッションを切るので、返すのは名前とメールと ID だけ
 */
export async function joinWithGoogleAndPassword(
  owner: { token: string; workspaceId: string },
  role: "editor" | "viewer" = "editor",
): Promise<{ email: string; userId: string; memberId: string }> {
  const m = await inviteAndJoin(owner.token, owner.workspaceId, role);
  const link = await call("POST", `/workspaces/${owner.workspaceId}/members/${m.memberId}/reset-link`, { token: owner.token, envOverride: BREAK_GLASS });
  expect(link.status).toBe(200);
  const token = new URL((await json<{ url: string }>(link)).url).searchParams.get("token");
  const reset = await call("POST", "/auth/reset-password", { body: { newPassword: BREAK_GLASS_PASSWORD, token }, envOverride: BREAK_GLASS });
  expect(reset.status).toBe(200);
  return { email: m.email, userId: m.userId, memberId: m.memberId };
}

/** 非常口を開いてパスワードでログインする(`/sign-in/email`)。セッションの Bearer を返す */
export async function signInWithPassword(email: string): Promise<string> {
  const res = await call("POST", "/auth/sign-in/email", { body: { email, password: BREAK_GLASS_PASSWORD }, headers: { origin: "http://localhost:3000" }, envOverride: BREAK_GLASS });
  expect(res.status).toBe(200);
  return res.headers.get("set-auth-token")!;
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
 * 偽のデプロイ専用の Worker(7i・7o)。受けた依頼を控え、応答は mode と Site ごとの状態で決める。
 * Site ごとに { accepted, deployed, removed, digest, 入力, history } を持ち、本物の DO と同じ規則で動く:
 * 受け付け済みより新しい世代だけを受け付け、同じか古い世代の依頼は捨てて今の accepted を返す(同じ世代の別の中身も捨てる。7o K23)。
 * mode = "deploy" は依頼のたびに配置する(本物の同期の flush と同じく、受け付けていて配っていない Site をすべて配る)/
 * "pending" は受け付けるだけで配らない(CF API の失敗の形)/ "throw" は RPC が落ちる / "hang" は応答が返らない。
 * digest は受け付けた入力の `staticInputDigest`。digest の無い状態(setSite の古い形)は、本物と同じく保存済みの入力から補う。
 * 配置で履歴の先頭に { generation, deployedAt, digest } を足す(7o K24)。
 * setStatus(s) = siteStatus の応答を s で上書きする(以後ずっと。優先順は setStatus > 墓標 > Site ごとの状態)。
 * setTombstone(epoch) = その epoch 以下の依頼には、削除の墓標を受け付けて配り終えたと答える(削除の途中で止まって墓標だけが残った状態。本物と同じく古い世代は捨てる)。
 * setTombstone(epoch, deployedGen) = 墓標は受け付けただけで配り終えていない(accepted = 墓標 / deployed = deployedGen。CF API の失敗で alarm の再試行待ち)。state は pending
 * onRemove(fn) = removeSite の応答の前に fn を呼ぶ(削除の途中に別の操作を差し込む)。fn が結果を返したら、それを応答にする
 * setSite(siteId, …) = Site の状態を直接置く(DO が D1 より先行した状態・同じ世代で中身が違う状態・digest の無い古い記録の形)。
 * setMeta(…) = instanceStatus の失敗の記録。flush() = alarm の配置(受け付けていて配っていない Site をすべて配る)。setMode(m) = mode を替える。
 * redeploySites は本物と同じく受け付けるだけで配らない(配るのは flush)。batches に依頼を控える。
 * closure で書き、this を使わない(`{ ...fake, siteStatus }` と展開して使うテストがあるため)
 */
type FakeDeployerMode = "deploy" | "pending" | "throw" | "hang";
export type FakeStaticInput = { config: unknown; settings: unknown; apiBase: string | null };
type FakeStaticSite = {
  accepted: StaticGeneration | null;
  deployed: StaticGeneration | null;
  deployedAt: string | null;
  removed: boolean;
  acceptedDigest?: string;
  deployedDigest?: string;
  input?: FakeStaticInput;
  history: StaticDeployHistoryEntry[];
  historyFrom: string | null;
};
export function fakeDeployer(initialMode: FakeDeployerMode = "deploy") {
  let mode = initialMode;
  const deploys: StaticDeployRequest[] = [];
  const removes: StaticRemoveRequest[] = [];
  const batches: StaticBatchDeployRequest[] = [];
  const sites = new Map<string, FakeStaticSite>();
  let override: StaticSiteStatus | null = null;
  let tombstone: number | null = null;
  let tombstoneDeployed: StaticGeneration | null | undefined; // undefined = 配り終えた墓標 / それ以外 = 受け付けただけで deployed がこの世代
  let removeHook: ((req: StaticRemoveRequest) => Promise<StaticDeployResult | void>) | null = null;
  let meta: { failures: number; lastError: string | null; lastDeployedAt: string | null } = { failures: 0, lastError: null, lastDeployedAt: null };

  const emptySite = (): FakeStaticSite => ({ accepted: null, deployed: null, deployedAt: null, removed: false, history: [], historyFrom: null });
  const siteOf = (siteId: string): FakeStaticSite => {
    let s = sites.get(siteId);
    if (!s) sites.set(siteId, (s = emptySite()));
    return s;
  };
  /** 墓標(setTombstone)が Site の受け付け済みの世代より新しければ、その墓標 */
  const tombOf = (s: FakeStaticSite): StaticGeneration | null => {
    if (tombstone === null) return null;
    const t = { epoch: tombstone, seq: SITE_REMOVED_SEQ };
    return s.accepted && compareGeneration(s.accepted, t) > 0 ? null : t;
  };
  /** 受け付けた入力の digest。無ければ保存済みの入力から補う(本物の DO と同じ。削除には無い) */
  const acceptedDigestOf = async (s: FakeStaticSite): Promise<string | undefined> =>
    s.acceptedDigest ?? (s.input && !s.removed ? await staticInputDigest(s.input) : undefined);
  /** 本物の digestsOf と同じ: deployedDigest は、配った世代が受け付けた世代と同じなら受け付けた digest、違えば配った記録の digest */
  const digestsOf = async (s: FakeStaticSite): Promise<{ acceptedDigest?: string; deployedDigest?: string }> => {
    const a = s.accepted ? await acceptedDigestOf(s) : undefined;
    const d = s.deployed && s.accepted && compareGeneration(s.deployed, s.accepted) === 0 ? a : s.deployedDigest;
    return { ...(a !== undefined ? { acceptedDigest: a } : {}), ...(d !== undefined ? { deployedDigest: d } : {}) };
  };
  /** 受け付け済み(墓標を含む)より新しい世代だけを受け付ける。input = null は削除。digest を作れない入力(形の不正)は throw */
  const accept = async (siteId: string, gen: StaticGeneration, input: FakeStaticInput | null): Promise<boolean> => {
    const s = siteOf(siteId);
    const cur = tombOf(s) ?? s.accepted;
    if (cur && compareGeneration(gen, cur) <= 0) return false;
    const digest = input ? await staticInputDigest(input) : undefined;
    s.accepted = gen;
    s.removed = input === null;
    s.input = input ?? undefined;
    s.acceptedDigest = digest;
    return true;
  };
  /** 配置(本物の flush と同じく、受け付けていて配っていない Site をすべて配り、履歴の先頭に足す) */
  const flush = async (): Promise<void> => {
    const at = new Date().toISOString();
    for (const s of sites.values()) {
      if (!s.accepted || (s.deployed && compareGeneration(s.deployed, s.accepted) === 0)) continue;
      const digest = s.removed ? undefined : await acceptedDigestOf(s);
      s.history = [{ generation: s.accepted, deployedAt: at, ...(digest !== undefined ? { digest } : {}) }, ...s.history];
      s.deployed = s.accepted;
      s.deployedAt = at;
      s.deployedDigest = digest;
    }
    meta = { failures: 0, lastError: null, lastDeployedAt: at };
  };
  /** 本物の resultFor と同じ形。墓標が新しければ墓標を答える */
  const resultFor = async (siteId: string, gen: StaticGeneration, error?: string): Promise<StaticDeployResult> => {
    const s = siteOf(siteId);
    const t = tombOf(s);
    if (t) {
      if (tombstoneDeployed !== undefined) return { state: "pending", accepted: t, deployed: tombstoneDeployed, deployedAt: null, error: "HTTP 503" };
      return { state: "deployed", accepted: t, deployed: t, deployedAt: new Date().toISOString() };
    }
    const r = { accepted: s.accepted, deployed: s.deployed, deployedAt: s.deployedAt, ...(await digestsOf(s)) };
    if (s.deployed && compareGeneration(s.deployed, gen) >= 0) return { state: "deployed", ...r };
    return { state: "pending", ...r, ...(error !== undefined ? { error } : {}) };
  };
  /** throw / hang の mode なら RPC と同じく落ちる・返らない */
  const reachable = async (): Promise<void> => {
    if (mode === "throw") throw new Error("binding down");
    if (mode === "hang") await new Promise(() => {});
  };
  /** 受け付けの後の配置。deploy なら配り、pending なら配置の失敗を記録してエラーの文を返す */
  const afterAccept = async (): Promise<string | undefined> => {
    if (mode === "deploy") {
      await flush();
      return undefined;
    }
    meta = { ...meta, failures: meta.failures + 1, lastError: "HTTP 503" };
    return "HTTP 503";
  };

  const d: StaticDeployer & {
    deploys: typeof deploys;
    removes: typeof removes;
    batches: typeof batches;
    setStatus(s: StaticSiteStatus): void;
    setTombstone(epoch: number, deployedGen?: StaticGeneration | null): void;
    onRemove(fn: (req: StaticRemoveRequest) => Promise<StaticDeployResult | void>): void;
    setSite(
      siteId: string,
      v: {
        accepted: StaticGeneration | null;
        deployed: StaticGeneration | null;
        removed?: boolean;
        acceptedDigest?: string;
        deployedDigest?: string;
        input?: FakeStaticInput;
        history?: StaticDeployHistoryEntry[];
        historyFrom?: string | null;
        deployedAt?: string | null;
      },
    ): void;
    setMeta(v: { failures?: number; lastError?: string | null; lastDeployedAt?: string | null }): void;
    setMode(m: FakeDeployerMode): void;
    flush(): Promise<void>;
  } = {
    deploys, removes, batches,
    setStatus(s) { override = s; },
    setTombstone(epoch, deployedGen) { tombstone = epoch; tombstoneDeployed = deployedGen; },
    onRemove(fn) { removeHook = fn; },
    setSite(siteId, v) {
      sites.set(siteId, {
        accepted: v.accepted,
        deployed: v.deployed,
        deployedAt: v.deployedAt !== undefined ? v.deployedAt : v.deployed ? new Date().toISOString() : null,
        removed: v.removed ?? false,
        ...(v.acceptedDigest !== undefined ? { acceptedDigest: v.acceptedDigest } : {}),
        ...(v.deployedDigest !== undefined ? { deployedDigest: v.deployedDigest } : {}),
        ...(v.input !== undefined ? { input: v.input } : {}),
        history: v.history ?? [],
        historyFrom: v.historyFrom ?? null,
      });
    },
    setMeta(v) { meta = { ...meta, ...v }; },
    setMode(m) { mode = m; },
    flush,
    async redeploySite(req) {
      deploys.push(req);
      await reachable();
      try {
        await accept(req.siteId, req.generation, { config: req.config, settings: req.settings, apiBase: req.apiBase });
      } catch {
        return { ...(await resultFor(req.siteId, req.generation)), state: "rejected", error: "invalid_payload" };
      }
      return resultFor(req.siteId, req.generation, await afterAccept());
    },
    async removeSite(req) {
      removes.push(req);
      const r = removeHook ? await removeHook(req) : undefined;
      if (r) return r;
      await reachable();
      await accept(req.siteId, req.generation, null);
      return resultFor(req.siteId, req.generation, await afterAccept());
    },
    async siteStatus(siteId) {
      if (override) return override;
      const s = sites.get(siteId) ?? emptySite();
      const t = tombOf(s);
      if (t) {
        const deployed = tombstoneDeployed === undefined ? t : tombstoneDeployed;
        return { accepted: t, deployed, deployedAt: deployed ? s.deployedAt : null, history: [...s.history], historyFrom: s.historyFrom, pending: tombstoneDeployed !== undefined, lastError: meta.lastError };
      }
      const pending = s.accepted !== null && (s.deployed === null || compareGeneration(s.deployed, s.accepted) < 0);
      return { accepted: s.accepted, deployed: s.deployed, deployedAt: s.deployedAt, history: [...s.history], historyFrom: s.historyFrom, pending, lastError: meta.lastError, ...(await digestsOf(s)) };
    },
    async redeploySites(req) {
      batches.push(req);
      await reachable();
      const out: Array<{ siteId: string; accepted: StaticGeneration | null; error?: "invalid_payload" }> = [];
      for (const e of req.sites) {
        let ok = true;
        try {
          await accept(e.siteId, e.generation, "remove" in e ? null : { config: e.config, settings: e.settings, apiBase: e.apiBase });
        } catch {
          ok = false;
        }
        const s = siteOf(e.siteId);
        out.push({ siteId: e.siteId, accepted: tombOf(s) ?? s.accepted, ...(ok ? {} : { error: "invalid_payload" as const }) });
      }
      return { state: "accepted", sites: out };
    },
    async instanceStatus() {
      await reachable();
      const list: StaticInstanceStatus["sites"] = [];
      for (const [siteId, s] of sites) {
        const t = tombOf(s);
        if (t) {
          list.push({ siteId, accepted: t, deployed: tombstoneDeployed === undefined ? t : tombstoneDeployed, removed: true });
          continue;
        }
        if (!s.accepted) continue;
        list.push({ siteId, accepted: s.accepted, deployed: s.deployed, removed: s.removed, ...(await digestsOf(s)) });
      }
      return { sites: list, ...meta };
    },
  };
  return d;
}

/**
 * 公開中のサイト src を、D1 の中で n 個に写す(sites と publishes の行。ID は prefix + 連番)。
 * 列は表の定義から読む(全列を手で並べない)。config の中のサイト ID も写した ID に置き換える
 */
export async function cloneSites(src: string, n: number, prefix: string): Promise<string[]> {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
  const colsOf = async (table: string) => (await env.DB.prepare(`select name from pragma_table_info('${table}')`).all<{ name: string }>()).results.map((r) => r.name);
  const siteCols = await colsOf("sites");
  await env.DB.prepare(`insert into sites (${siteCols.join(", ")}) select ${siteCols.map((c) => (c === "id" ? "j.value" : `s.${c}`)).join(", ")} from sites s, json_each(?) j where s.id = ?`)
    .bind(JSON.stringify(ids), src)
    .run();
  const pubCols = await colsOf("publishes");
  const pubSel = pubCols.map((c) =>
    c === "id" ? "'pub_' || j.value || '_' || p.version" : c === "site_id" ? "j.value" : c === "config_json" ? "replace(p.config_json, ?, j.value)" : `p.${c}`,
  );
  await env.DB.prepare(`insert into publishes (${pubCols.join(", ")}) select ${pubSel.join(", ")} from publishes p, json_each(?) j where p.site_id = ?`)
    .bind(src, JSON.stringify(ids), src)
    .run();
  return ids;
}
/** 公開中の版の config_json の後ろに空白を足して、長さを bytes にする(JSON としては同じ中身。7o の頁のバイト数の上限のテスト) */
export async function padConfig(sid: string, bytes: number): Promise<void> {
  const row = await siteRow(sid);
  await env.DB.prepare("update publishes set config_json = config_json || replace(hex(zeroblob(? - length(config_json))), '00', ' ') where site_id = ? and version = ?")
    .bind(bytes, sid, row.active_version)
    .run();
}
/** 状態の問い合わせの応答(世代 g が at に配られている) */
export const statusOf = (g: StaticGeneration, at = "2026-10-05T00:00:00.000Z"): StaticSiteStatus => ({ accepted: g, deployed: g, deployedAt: at, history: [{ generation: g, deployedAt: at }], historyFrom: null, pending: false, lastError: null });

/**
 * 7o K23: D1 の今の行から、control が配信ファイルの出し直しに送る入力(公開中の版の config・siteToSettings(行)・edgeOrigin(env))。
 * envLike は control に渡す env と同じものにする(apiBase が digest に入る)
 */
export async function staticInputOf(siteId: string, envLike: Env = testEnv): Promise<FakeStaticInput> {
  const row = await siteRow(siteId);
  const pub = await getDb(env)
    .selectFrom("publishes")
    .select("config_json")
    .where("site_id", "=", siteId)
    .where("version", "=", row.active_version!)
    .executeTakeFirstOrThrow();
  return { config: JSON.parse(pub.config_json!), settings: siteToSettings(row), apiBase: edgeOrigin(envLike) };
}
/** 入力の bootstrap に焼く設定だけを変えた、別の中身の入力(同じ世代で中身が違う状態を作る) */
export function otherStaticInput(input: FakeStaticInput): FakeStaticInput {
  const settings = input.settings as { decisionTimeoutMs: number };
  return { ...input, settings: { ...settings, decisionTimeoutMs: settings.decisionTimeoutMs + 100 } };
}

/**
 * B68 Task 3: D1 に画像の行を直接入れる(IMAGE の保存の確かめの種)。`url` を渡せばその公開 URL のまま入れる。
 * name_key はサイトの中で UNIQUE なので、名前は ID にする。消す途中(`purgeMarkedAt`)は `deletedAt` も付けて渡す
 */
export async function seedAssetRow(
  sid: string,
  o: { id: string; url?: string; deletedAt?: number | null; purgeMarkedAt?: number | null },
): Promise<string> {
  const url = o.url ?? `${env.AB_ASSET_PUBLIC_BASE}/sites/${sid}/images/${o.id}.png`;
  await env.DB.prepare(
    `insert into assets (id, site_id, name, name_key, r2_key, public_url, mime, size, thumb_state, created_by, created_at, deleted_at, purge_marked_at, updated_at)
     values (?1, ?2, ?1, ?1, ?3, ?4, 'image/png', 1, 'skipped', 'u', 1, ?5, ?6, 1)`,
  )
    .bind(o.id, sid, `sites/${sid}/images/${o.id}.png`, url, o.deletedAt ?? null, o.purgeMarkedAt ?? null)
    .run();
  return url;
}

/** B68 Task 3: `prepare` に渡った SQL を記録する D1 ラッパ(往復の数・読んだ表を見る)。batch の中の文も prepare を通るので記録される */
export function recordingD1(db: D1Database): { DB: D1Database; sqls: string[] } {
  const sqls: string[] = [];
  const DB = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "prepare") return (q: string) => (sqls.push(q), target.prepare(q));
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { DB, sqls };
}
