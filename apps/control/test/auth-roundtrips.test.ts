import { env } from "cloudflare:workers";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  BREAK_GLASS,
  BREAK_GLASS_PASSWORD,
  call,
  countingD1,
  joinWithPassword,
  json,
  mockGoogle,
  setupOwner,
  TEST_FLOW,
  uniqueEmail,
  type D1Counts,
} from "./helpers";
import type { Env } from "../src/env";

/**
 * B179 Task 5: ログイン・セッションの確かめ・API キーの確かめ 1 回ごとに、control(Better Auth を含む)が D1 へ出す往復の数を数え、
 * 今の数(better-auth 1.4.21)を上限として固定する。版上げ(1.7)で往復・書き込みが増えたら、ここで落ちて気づける。
 *
 * 目的: admin・control は Workers Free(CPU 1 回 10 ms)の上で複数の人が同時に使う。ログインとセッションの確かめは画面の要求ごとに
 * 走るので、1 往復の増加がそのまま全要求の D1 の往復と待ちになる(CLAUDE.md「性能と同時利用」)。
 *
 * 経路(PATHS): 1. Google のログイン(既存の人) 2. Google のログイン(招待された新しい人) 3. セッションの token での GET /me
 * 4. API キーでの GET /me(ワークスペースの鍵・すべてのワークスペースの鍵) 5. 非常口のパスワードの sign-in。
 * Google のログインは start → callback → 使い捨てコードの交換の 3 要求の合計(段ごとの数も記録する)。
 *
 * 数え方: test/helpers.ts の countingD1 で env.DB を包む(文の実行 1 回 = 1 往復、batch 1 回 = 1 往復)。
 * **同じ経路の 2 回目の要求で数える**: getAuth(src/auth.ts)は env.DB を鍵に Better Auth を cache するので、包んだ DB を
 * 1 つ作って 1 回目と 2 回目に同じものを渡す。1 回目は組み立ての直後の要求で、組み立て時の処理が混ざりうるので記録だけする。
 * 招待された新しい人は、2 回目も別の未登録のメール(と別の招待)で測る(同じメールだと既存の人の経路になる)。
 * API キーの期限切れの一括削除(apiKey プラグインの deleteAllExpiredApiKeys。isolate ごとに 10 秒に 1 回・await されない)は
 * SQL で見分けて定常の数から外し、別の test(expired_key_sweep_*)で時計を進めて 1 回分を数える(壁時計しだいで入る・入らないが
 * 揺れるので、定常の上限に入れると不安定になる)。要求の応答の後に出た往復(await されない処理)も別に数える。
 *
 * 上限(LIMITS)= 2 回目の実測そのもの(余裕なし。3 回走らせて揺れないことを確かめてある)。往復の数(trips)と書き込みの文の数
 * (writes)を経路ごとに表明する。1 増えたら落ちる。
 *
 * 上限を上げるときの手順(LIMITS の値を変える前に必ず):
 * 1. 先に減らせないかを確かめる: 増えた往復の SQL(失敗の表示に全文が出る)が、版上げで足された照会か、control の照会か。
 *    互いに依らない照会は batch にまとめられないか。Better Auth の設定(cookie cache・deferUpdates など)で消せないか
 * 2. それでも増えるなら、増える理由(どの経路で、どの SQL が、なぜ要るか)を、上げる値の横のコメントと commit の本文に書いてから上げる。
 *    実装の記録(docs/superpowers/plans/2026-11-02-b179-better-auth-1-7-implementation.md)の表も書き直す
 * 3. 規則と背景はリポジトリの CLAUDE.md の「性能と同時利用」を参照
 */

const TIMEOUT = 30_000;

/** 2 回目の要求の上限(better-auth 1.4.21 の実測。B179 Task 6 で 1.7.15 の鍵の 2 経路だけ上げた。期限切れの鍵の一括削除を除く) */
const LIMITS = {
  // start 0(state は暗号化 Cookie)+ callback 7(account・user の読み・account の token の書き換え・所属の確かめ・session の作成・
  // 使い捨てコードの期限切れの削除と発行)+ 交換 1(delete … returning)。書き込み 5
  googleExisting: { trips: 8, writes: 5 },
  // callback 11: account の照会(空振り)・メールで user の照会(空振り)・招待の確かめ(user.create.before)・user と account の作成・
  // 所属の確かめ(member・user のメール・招待。session.create.before の hasAccess)・session の作成・使い捨てコードの削除と発行 + 交換 1。書き込み 6
  googleInvited: { trips: 12, writes: 6 },
  // session・user の読み(Better Auth)+ システム管理者かの確かめ(GET /me)。書き込みなし
  sessionMe: { trips: 3, writes: 0 },
  // 鍵の読み・鍵の行の書き戻し 2 回(update "apikey"。await される)・user の読み(Better Auth)+ 鍵の情報・member のロール(control)。
  // B179 Task 6 で 5 → 6・書き込み 1 → 2: @better-auth/api-key 1.7.15 の claimUsageInDatabase は行を丸ごと書き戻さず、
  // consumeRateLimit の `update "apikey" set "lastRequest"`(rateLimit.enabled: false でも走る)の後に `update "apikey" set "updatedAt"` を出す。
  // 2 文はプラグインの中で直列に await され、設定で消せない(storage: "database" の固定の道。deferUpdates は期限切れ・使い切った鍵の削除にだけ効き、この 2 文は常に await される)
  workspaceKeyMe: { trips: 6, writes: 2 },
  // member のロールの代わりに、システム管理者かの確かめ(GET /me の instance_admins)。B179 Task 6 で上と同じ理由で 5 → 6・書き込み 1 → 2
  fullKeyMe: { trips: 6, writes: 2 },
  // user・account の読み・所属の確かめ・session の作成(Better Auth)+ パスワードの記録の確かめ・auth.password_login の記録(control のフック)
  passwordSignIn: { trips: 6, writes: 2 },
} as const;

/** apiKey プラグインの期限切れの鍵の一括削除(adapter の deleteMany が出す形。1.4.21 は `… and "expiresAt" <> ?`、1.7.15 は `… and "expiresAt" is not null`。どちらも当たる) */
const SWEEP = /^delete from "apikey" where .*"expiresAt" </i;
/** better-auth の adapter が出す照会の形(包んだ DB を Better Auth が本当に使っていることの確かめ。1.4.21 の adapter の形) */
const BETTER_AUTH_SQL = /^select "primary"\.\* from|^(insert into|update|delete from) "(user|session|account|apikey|verification)"/i;

type Tally = {
  /** 往復の数(一括削除を除く) */
  trips: number;
  /** そのうち、出た時点でほかの往復が終わっていなかったもの(並列) */
  parallel: number;
  /** SQL の文の数(batch の中を含む) */
  statements: number;
  batches: number;
  /** 書き込みの文の数(insert / update / delete) */
  writes: number;
  /** meta の合計(first / raw の往復は meta が無いので数えない。その数は noMeta) */
  rowsRead: number;
  rowsWritten: number;
  noMeta: number;
  /** 期限切れの鍵の一括削除の往復の数(await されない) */
  sweep: number;
  /** 要求の応答が返った後に出た往復の数(await されない処理) */
  late: number;
  sql: string[];
};

const tally = (c: D1Counts, atReturn: number): Tally => {
  const steady = c.trips.filter((t) => !t.sql.some((q) => SWEEP.test(q)));
  return {
    trips: steady.length,
    parallel: steady.filter((t) => t.parallel).length,
    statements: steady.reduce((a, t) => a + t.sql.length, 0),
    batches: steady.filter((t) => t.kind === "batch").length,
    writes: steady.reduce((a, t) => a + t.writes, 0),
    rowsRead: steady.reduce((a, t) => a + (t.rowsRead ?? 0), 0),
    rowsWritten: steady.reduce((a, t) => a + (t.rowsWritten ?? 0), 0),
    noMeta: steady.filter((t) => t.rowsRead === null).length,
    sweep: c.trips.length - steady.length,
    late: c.trips.length - atReturn,
    sql: c.trips.map((t) => `${t.parallel ? "[parallel] " : ""}${t.kind === "batch" ? `batch(${t.sql.join(" ;; ")})` : t.sql[0]}`),
  };
};

const sum = (xs: Tally[]): Tally => ({
  trips: xs.reduce((a, x) => a + x.trips, 0),
  parallel: xs.reduce((a, x) => a + x.parallel, 0),
  statements: xs.reduce((a, x) => a + x.statements, 0),
  batches: xs.reduce((a, x) => a + x.batches, 0),
  writes: xs.reduce((a, x) => a + x.writes, 0),
  rowsRead: xs.reduce((a, x) => a + x.rowsRead, 0),
  rowsWritten: xs.reduce((a, x) => a + x.rowsWritten, 0),
  noMeta: xs.reduce((a, x) => a + x.noMeta, 0),
  sweep: xs.reduce((a, x) => a + x.sweep, 0),
  late: xs.reduce((a, x) => a + x.late, 0),
  sql: xs.flatMap((x) => x.sql),
});

type Counting = ReturnType<typeof countingD1>;

/**
 * 1 要求を数える。数を 0 に戻してから送り、応答の後に出ている往復(await されない処理)が終わるまで待ってから読む
 * (残った往復を次の要求の数に混ぜないため)
 */
async function measure(counting: Counting, send: () => Promise<Response>): Promise<{ res: Response; tally: Tally }> {
  await counting.idle();
  counting.reset();
  const res = await send();
  const atReturn = counting.counts().trips.length;
  // await されない処理が D1 へ出るまでの猶予(fire-and-forget の照会は応答より後に出ることがある)
  await new Promise((r) => setTimeout(r, 20));
  await counting.idle();
  return { res, tally: tally(counting.counts(), atReturn) };
}

/** Google のログインを start → callback → 交換の 3 要求とも包んだ DB で通し、段ごとの数を返す */
async function googleLogin(counting: Counting, email: string): Promise<{ token: string | null; steps: Record<"start" | "callback" | "exchange", Tally>; total: Tally }> {
  const envOverride: Partial<Env> = { DB: counting.db };
  const spy = mockGoogle({ email, name: "Google User" });
  try {
    const q = new URLSearchParams({ flow: TEST_FLOW });
    const start = await measure(counting, () => call("GET", `/auth/google/start?${q}`, { envOverride }));
    expect(start.res.status).toBe(302);
    const state = new URL(start.res.headers.get("location")!).searchParams.get("state")!;
    const cookie = start.res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const callback = await measure(counting, () =>
      call("GET", `/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`, { headers: { cookie }, envOverride }),
    );
    expect(callback.res.status).toBe(302);
    const code = new URL(callback.res.headers.get("location")!).searchParams.get("code");
    expect(code, callback.res.headers.get("location") ?? "").toBeTruthy();
    const exchange = await measure(counting, () => call("POST", "/auth/handoff/exchange", { body: { code }, envOverride }));
    expect(exchange.res.status).toBe(200);
    const { token } = await json<{ token: string }>(exchange.res);
    const steps = { start: start.tally, callback: callback.tally, exchange: exchange.tally };
    return { token, steps, total: sum(Object.values(steps)) };
  } finally {
    spy.mockRestore();
  }
}

const invite = async (owner: { token: string; workspaceId: string }, email: string) => {
  const res = await call("POST", `/workspaces/${owner.workspaceId}/invitations`, { token: owner.token, body: { email, role: "editor" } });
  expect(res.status).toBe(201);
};

const issueKey = async (token: string, workspaceId: string | null) => {
  const res = await call("POST", "/me/api-keys", { token, body: { name: "agent key", workspaceId } });
  expect(res.status).toBe(201);
  return json<{ id: string; key: string }>(res);
};

/** 実装の記録に写す数(1 回目・2 回目)。表明の失敗の表示にも SQL の全文を出す */
const record: Record<string, { first: Omit<Tally, "sql">; second: Omit<Tally, "sql">; steps?: Record<string, Omit<Tally, "sql">> }> = {};
const strip = ({ sql: _sql, ...rest }: Tally) => rest;

/** 2 回目の数を上限と比べる。Better Auth の照会が数に入っている(包んだ DB を Better Auth が使った)ことも確かめる */
function expectWithin(label: keyof typeof LIMITS, second: Tally, opts: { betterAuth: boolean }) {
  const all = `${label}:\n${second.sql.join("\n")}`;
  if (opts.betterAuth) expect(second.sql.some((q) => BETTER_AUTH_SQL.test(q.replace(/^\[parallel\] /, "").replace(/^batch\(/, ""))), all).toBe(true);
  expect(second.trips, all).toBeGreaterThan(0);
  expect(second.trips, all).toBeLessThanOrEqual(LIMITS[label].trips);
  expect(second.writes, all).toBeLessThanOrEqual(LIMITS[label].writes);
  // 定常の経路に一括削除・応答の後の往復が無いことは数として記録する(上限には入れない)
}

let sweepRecord: unknown = null;

// 実装の記録(## Task 5)に写す数
afterAll(() => {
  console.log("b179 task 5 round trips", JSON.stringify({ ...record, expiredKeySweep: sweepRecord }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("D1 round trips per login, session and key check (B179 Task 5)", () => {
  it("google_login_existing_user_round_trips_b179", async () => {
    const owner = await setupOwner();
    const counting = countingD1(env.DB);
    // setupOwner の人(Google に link 済み)が 2 回ログインする
    const first = await googleLogin(counting, owner.email);
    const second = await googleLogin(counting, owner.email);
    expect(first.token && second.token).toBeTruthy();
    record.googleExisting = { first: strip(first.total), second: strip(second.total), steps: Object.fromEntries(Object.entries(second.steps).map(([k, v]) => [k, strip(v)])) };
    expectWithin("googleExisting", second.total, { betterAuth: true });
  }, TIMEOUT);

  it("google_login_invited_new_user_round_trips_b179", async () => {
    const owner = await setupOwner();
    const counting = countingD1(env.DB);
    // 招待は包まない DB で出す(数えるのはログインだけ)。2 回目も別の未登録のメールと別の招待
    const a = uniqueEmail("invited");
    const b = uniqueEmail("invited");
    await invite(owner, a);
    await invite(owner, b);
    const first = await googleLogin(counting, a);
    const second = await googleLogin(counting, b);
    expect(first.token && second.token).toBeTruthy();
    record.googleInvited = { first: strip(first.total), second: strip(second.total), steps: Object.fromEntries(Object.entries(second.steps).map(([k, v]) => [k, strip(v)])) };
    expectWithin("googleInvited", second.total, { betterAuth: true });
  }, TIMEOUT);

  it("session_me_round_trips_b179", async () => {
    const owner = await setupOwner();
    const counting = countingD1(env.DB);
    const envOverride: Partial<Env> = { DB: counting.db };
    const first = await measure(counting, () => call("GET", "/me", { token: owner.token, envOverride }));
    const second = await measure(counting, () => call("GET", "/me", { token: owner.token, envOverride }));
    expect([first.res.status, second.res.status]).toEqual([200, 200]);
    record.sessionMe = { first: strip(first.tally), second: strip(second.tally) };
    expectWithin("sessionMe", second.tally, { betterAuth: true });
  }, TIMEOUT);

  it("api_key_me_round_trips_b179", async () => {
    const owner = await setupOwner();
    const ws = await issueKey(owner.token, owner.workspaceId);
    const full = await issueKey(owner.token, null);
    for (const [label, key] of [["workspaceKeyMe", ws.key], ["fullKeyMe", full.key]] as const) {
      const counting = countingD1(env.DB);
      const envOverride: Partial<Env> = { DB: counting.db };
      const first = await measure(counting, () => call("GET", "/me", { token: key, envOverride }));
      const second = await measure(counting, () => call("GET", "/me", { token: key, envOverride }));
      expect([first.res.status, second.res.status], label).toEqual([200, 200]);
      record[label] = { first: strip(first.tally), second: strip(second.tally) };
      expectWithin(label, second.tally, { betterAuth: true });
    }
  }, TIMEOUT);

  it("password_sign_in_round_trips_b179", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    const counting = countingD1(env.DB);
    const envOverride: Partial<Env> = { ...BREAK_GLASS, DB: counting.db };
    const signIn = () =>
      call("POST", "/auth/sign-in/email", { body: { email: pw.email, password: BREAK_GLASS_PASSWORD }, headers: { origin: "http://localhost:3000" }, envOverride });
    const first = await measure(counting, signIn);
    const second = await measure(counting, signIn);
    expect([first.res.status, second.res.status]).toEqual([200, 200]);
    record.passwordSignIn = { first: strip(first.tally), second: strip(second.tally) };
    expectWithin("passwordSignIn", second.tally, { betterAuth: true });
  }, TIMEOUT);

  /**
   * 期限切れの鍵の一括削除の 1 回分。apiKey プラグインは最後に走らせた時刻を module の変数に持ち、10 秒たっていれば鍵の要求のたびに
   * await せずに走らせる。時計(Date だけ)を 11 秒進めて、次の鍵の要求で必ず 1 回走る状態にして数える
   */
  it("expired_key_sweep_round_trips_b179", async () => {
    const owner = await setupOwner();
    const ws = await issueKey(owner.token, owner.workspaceId);
    const counting = countingD1(env.DB);
    const envOverride: Partial<Env> = { DB: counting.db };
    await measure(counting, () => call("GET", "/me", { token: ws.key, envOverride }));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11_000 });
    const swept = await measure(counting, () => call("GET", "/me", { token: ws.key, envOverride }));
    vi.useRealTimers();
    expect(swept.res.status).toBe(200);
    const sweepTrips = counting.counts().trips.filter((t) => t.sql.some((q) => SWEEP.test(q)));
    expect(sweepTrips, swept.tally.sql.join("\n")).toHaveLength(1);
    const t = sweepTrips[0]!;
    sweepRecord = { request: strip(swept.tally), sweep: { sql: t.sql, writes: t.writes, parallel: t.parallel, rowsRead: t.rowsRead, rowsWritten: t.rowsWritten } };
  }, TIMEOUT);
});
