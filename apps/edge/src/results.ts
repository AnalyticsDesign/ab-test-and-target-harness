import {
  RESULTS_ROWS,
  nextUtcMidnight,
  pickVariant,
  type CompiledConfig,
  type ConversionBody,
  type ParticipantBody,
  type ResultOutcome,
  type ResultsEventResponse,
  type SiteSettings,
} from "@wtt/core";
import type { Env } from "./env";
import { budgetStub } from "./results-budget";
import { healthBuffer } from "./results-health";
import { leaseHolder, type LeaseTicket } from "./results-lease";
import { loadActiveVersion, loadConfig } from "./store";

/**
 * 結果の参加・CV の受信(D9 ② Task 6・設計書 §6.4・K8・K10・K11)。目標だけの CV(B139 §5)は goal-conversion.ts。
 *
 * 判定はすべて D1 に書く前に行う。順は:
 * 1. active な config と `results`(無ければ一時的な ignored)
 * 2. participant: run → 実験 → パターン → 割り当て(pickVariant)の照合
 * 3. 収集の締め切り(`settings.resultsCollectUntil`。CV はその run だけ外す)
 * 4. conversion: goal → `results.runs` に無い run を外す
 * 5. `RESULTS_DB`・`RESULTS_VISITOR_KEY` が無い(鍵が使えない)→ 書かずに failed を数える(fail-closed)
 * 6. 予算の枠(LeaseHolder.take)。停止中は stopped、予算の DO に届かなければ failed を数える(K10。停止期間には数えない)
 * 7. 設計書 §6.4 の SQL を 1 回の batch。`meta.rows_written` で枠を精算する。D1 の日次上限のエラーはその場で停止にする
 *
 * 送られた参加・CV の受信では、take → batch → settle を応答の前に済ませる(waitUntil に回すのは失敗の記録の送信と d1_limit の停止だけ)。
 * 便乗の CV(B139 §5.2 の Q22。/__ab/decision と type:"goal")だけは、配信の応答を待たせないよう take → batch → settle を
 * まとめて waitUntil の中で最後まで行う。LeaseHolder は受け取り中の Promise を要求の間で共有するが、返らない呼び出しは
 * results-lease.ts の 5 秒の切り離し(INFLIGHT_TIMEOUT_MS)で外すので、waitUntil が打ち切られても後の要求は止まらない。
 * 打ち切られた batch の枠は精算されずに使ったまま残る(安全側)。
 *
 * 失敗を数える(HealthBuffer.count)のは、config の `results.runs` で確かめた run だけ(送られた任意の runId で
 * isolate のメモリを増やさない)。Site ID は呼び出し側が SITE_ID_RE と settings の存在で確かめている
 */

/** 設計書 §6.4 の書き込みの SQL(results-schema.test.ts も同じ形の文で振る舞いを固定している) */
export const RESULTS_SQL = {
  /** participant(初回)。同じパターンの重複は何も書かない。違うパターンは混在の印と時刻を 1 回だけ書く */
  participant: `INSERT INTO participants (run_id, visitor_key, site_id, variant_id, exposed_at, device, applied, mixed)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
ON CONFLICT (run_id, visitor_key) DO UPDATE SET mixed = 1, mixed_at = excluded.exposed_at
  WHERE participants.variant_id <> excluded.variant_id AND participants.mixed = 0`,
  /** participant(recovered)。初回に失敗した人だけを回復にする */
  recovered: `UPDATE participants SET applied = 'recovered', recovered_at = ?3
 WHERE run_id = ?1 AND visitor_key = ?2 AND applied = 'failed'`,
  /** participant(failed_later)。適用できていた人だけを失敗にする(その後の回復は recovered の更新で戻る) */
  failedLater: `UPDATE participants SET applied = 'failed', failed_at = ?3
 WHERE run_id = ?1 AND visitor_key = ?2 AND applied = 'ok'`,
  /** conversion(runIds の数だけ)。参加者の行がある run にだけ入る(参加していないテストへの CV を書かない) */
  conversion: `INSERT INTO conversions (run_id, goal_id, visitor_key, converted_at)
SELECT run_id, ?2, visitor_key, ?4 FROM participants WHERE run_id = ?1 AND visitor_key = ?3
ON CONFLICT (run_id, goal_id, visitor_key) DO NOTHING`,
} as const;

/** HMAC の鍵の最小の長さ(base64 を復号したバイト数。Global Constraints) */
const MIN_KEY_BYTES = 32;
/** D1 の日次の上限超過のエラーの文(「…exceeded D1's free tier daily row write limit…」。設計書 §6.9) */
const D1_DAILY_LIMIT_RE = /daily row write limit/i;

// 応答の runs で同じオブジェクトを共有するので凍らせる(どこかで書き換えると別の応答にも効いてしまう)
export const IGNORED: ResultOutcome = Object.freeze({ result: "ignored" }); // 一時的(config が古いことがある。次のページで送り直す)
export const IGNORED_FINAL: ResultOutcome = Object.freeze({ result: "ignored", retry: false }); // 変わらない理由。送り直さない
export const FAILED: ResultOutcome = Object.freeze({ result: "failed" });
const STORED: ResultOutcome = Object.freeze({ result: "stored" });
export const stopped = (until: number): ResultOutcome => ({ result: "stopped", until });

// ---- 訪問者の鍵(HMAC)

/**
 * isolate に保持する HMAC の鍵。secret の文字列ごとに持つので、secret を入れ替えた isolate は読み直す。
 * 使えない鍵(空・base64 でない・32 バイト未満)は null を持つ(毎回の復号をしない)
 */
let cachedKey: { secret: string | undefined; key: Promise<CryptoKey | null> } | null = null;
/** 鍵が無い・使えないことのログは isolate ごとに 1 回(送信のたびに出さない) */
let keyProblemLogged = false;

function logKeyProblem(message: string): void {
  if (keyProblemLogged) return;
  keyProblemLogged = true;
  console.error(`wtt-edge: ${message}; results are not written`);
}

async function importVisitorKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (secret === undefined) {
    logKeyProblem("RESULTS_VISITOR_KEY is not set");
    return null;
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0));
  } catch {
    logKeyProblem("RESULTS_VISITOR_KEY is not valid base64");
    return null;
  }
  if (raw.length < MIN_KEY_BYTES) {
    logKeyProblem(`RESULTS_VISITOR_KEY decodes to ${raw.length} bytes (at least ${MIN_KEY_BYTES} are required)`);
    return null;
  }
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  } catch (e) {
    logKeyProblem(`RESULTS_VISITOR_KEY could not be imported (${String(e)})`);
    return null;
  }
}

/**
 * `visitor_key = HMAC-SHA-256(RESULTS_VISITOR_KEY, siteId + ":" + visitorId)` の先頭 16 バイト(設計書 §6.4)。
 * D1 に訪問者 ID そのものを置かないため。鍵が無い・使えなければ null(呼び出し側は書かない。HMAC を省いて書かない)
 */
export async function visitorKey(env: Env, siteId: string, visitorId: string): Promise<Uint8Array | null> {
  const secret = env.RESULTS_VISITOR_KEY;
  if (!cachedKey || cachedKey.secret !== secret) cachedKey = { secret, key: importVisitorKey(secret) };
  const key = await cachedKey.key;
  if (!key) return null;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${siteId}:${visitorId}`));
  return new Uint8Array(mac).slice(0, 16);
}

/** forget の SQL(設計書 §6.4)。`visitor_key` は Site を含めて作るので、conversions は visitor_key だけで Site ごとに分かれる */
const FORGET_SQL = {
  participants: "DELETE FROM participants WHERE site_id = ?1 AND visitor_key = ?2",
  conversions: "DELETE FROM conversions WHERE visitor_key = ?1",
} as const;

/**
 * 撤回で計測用 D1 のその訪問者の行を消す(Mode A の forget・D-lite の撤回。設計書 §6.4・K13)。
 * 数行なので予算の枠は使わない。`RESULTS_DB` か鍵が無ければ何もしない(行が無いはず)。
 * 失敗はログだけで throw しない: 呼び出し側の応答(Profile の削除の結果)と、Profile の削除を飛ばさないため。
 * 呼び出し側は `settings.forgetOnRevoke !== false` のときだけ呼ぶ
 */
export async function forgetResults(env: Env, siteId: string, visitorId: string): Promise<void> {
  try {
    const db = env.RESULTS_DB;
    if (!db) return;
    const key = await visitorKey(env, siteId, visitorId);
    if (!key) return;
    await db.batch([db.prepare(FORGET_SQL.participants).bind(siteId, key), db.prepare(FORGET_SQL.conversions).bind(key)]);
  } catch (e) {
    console.error("wtt-edge: results forget failed", e);
  }
}

// ---- 受信

/** 使うのは waitUntil だけ(Hono の c.executionCtx と workers-types の ExecutionContext の両方を受ける) */
export type WaitUntil = Pick<ExecutionContext, "waitUntil">;
/** 受信 1 回の文脈(目標だけの CV の goal-conversion.ts も使う) */
export type Ctx = { env: Env; ctx: WaitUntil; siteId: string; now: number };

/** run 指定の CV(版 1)と参加の受信。目標だけの CV(版 2)は goal-conversion.ts の recordGoalConversion */
export async function handleResultsEvent(
  env: Env,
  ctx: WaitUntil,
  siteId: string,
  settings: SiteSettings,
  body: ParticipantBody | ConversionBody,
  visitorId: string,
  now: number,
): Promise<ResultsEventResponse> {
  const c: Ctx = { env, ctx, siteId, now };
  const out = body.type === "participant" ? await receiveParticipant(c, settings, body, visitorId) : await receiveConversion(c, settings, body, visitorId);
  // 数えた失敗は 1 分に 1 回まで DO に送る(応答は待たせない)
  const flush = healthBuffer().flushIfDue(env, now);
  if (flush) ctx.waitUntil(flush);
  return out;
}

/** active な compiled config の `results` があるものだけ(無ければ null = 一時的な ignored) */
export async function activeResultsConfig(env: Env, siteId: string): Promise<(CompiledConfig & { results: NonNullable<CompiledConfig["results"]> }) | null> {
  const version = await loadActiveVersion(env, siteId);
  const config = version === null ? null : await loadConfig(env, siteId, version);
  return config?.results ? (config as CompiledConfig & { results: NonNullable<CompiledConfig["results"]> }) : null;
}

/** その run の収集の締め切りを過ぎたか(締め切りちょうども受けない。設計書 §5.3) */
export const pastCollectUntil = (settings: SiteSettings, runId: string, now: number): boolean => {
  const until = settings.resultsCollectUntil?.[runId];
  return until !== undefined && until <= now;
};

async function receiveParticipant(c: Ctx, settings: SiteSettings, body: ParticipantBody, visitorId: string): Promise<ResultsEventResponse> {
  let config: Awaited<ReturnType<typeof activeResultsConfig>>;
  try {
    config = await activeResultsConfig(c.env, c.siteId);
  } catch (e) {
    // KV が読めない。書いていないが D1 の失敗ではないので数えない(runtime は次のページで送り直す)
    console.error("wtt-edge: results config read failed", e);
    return FAILED;
  }
  if (!config) return IGNORED;
  // runId から実験を逆に引く(runs は experimentId → runId)
  const experimentId = Object.keys(config.results.runs).find((id) => config.results.runs[id] === body.runId);
  if (experimentId === undefined) return IGNORED;
  const exp = config.experiments.find((e) => e.id === experimentId);
  if (!exp) return IGNORED; // 一時停止中(experiments[] に載らない)。再開すれば受ける
  if (!exp.variants.some((v) => v.id === body.variantId)) return IGNORED_FINAL;
  // 訪問者 ID から計算した割り当てと違う送信は書かない(テストは開始後に重み・パターンを変えられないので、正しい送信は必ず一致する)
  if (pickVariant(exp, visitorId) !== body.variantId) return IGNORED_FINAL;
  if (pastCollectUntil(settings, body.runId, c.now)) return IGNORED_FINAL;

  const runIds = [body.runId];
  const key = await keyOrNull(c, visitorId);
  const db = c.env.RESULTS_DB;
  if (!db || !key) return failAll(c, runIds).overall;
  return (await write(c, db, [participantStatement(db, c, body, key)], runIds, RESULTS_ROWS.participant)).overall;
}

/** applied で文を分ける(初回 = 挿入、回復・後から失敗 = 既にある行の更新。どれも 1 文) */
function participantStatement(db: D1Database, c: Ctx, body: ParticipantBody, key: Uint8Array): D1PreparedStatement {
  // 初回(ok / failed)だけが device を持つ(スキーマが applied で分けている)
  if ("device" in body) return db.prepare(RESULTS_SQL.participant).bind(body.runId, key, c.siteId, body.variantId, c.now, body.device, body.applied);
  return db.prepare(body.applied === "recovered" ? RESULTS_SQL.recovered : RESULTS_SQL.failedLater).bind(body.runId, key, c.now);
}

async function receiveConversion(c: Ctx, settings: SiteSettings, body: ConversionBody, visitorId: string): Promise<ResultsEventResponse> {
  // 同じ runId が重なって届いても 1 回だけ数える(枠の見込みと応答の runs を合わせる)
  const requested = [...new Set(body.runIds)];
  const runs: Record<string, ResultOutcome> = {};
  const setAll = (o: ResultOutcome): ResultsEventResponse => {
    for (const r of requested) runs[r] = o;
    return combine(runs);
  };
  let config: Awaited<ReturnType<typeof activeResultsConfig>>;
  try {
    config = await activeResultsConfig(c.env, c.siteId);
  } catch (e) {
    console.error("wtt-edge: results config read failed", e);
    return setAll(FAILED);
  }
  if (!config) return setAll(IGNORED);
  if (!config.goals.some((g) => g.id === body.goalId)) return setAll(IGNORED_FINAL);
  const known = new Set(Object.values(config.results.runs));
  const eligible: string[] = [];
  for (const runId of requested) {
    // 締め切りを先に見る(締め切りを過ぎた run は、config から外れていても送り直させない)
    if (pastCollectUntil(settings, runId, c.now)) runs[runId] = IGNORED_FINAL;
    else if (!known.has(runId)) runs[runId] = IGNORED; // config が古いことがある(一時的)
    else eligible.push(runId);
  }
  if (eligible.length === 0) return combine(runs);

  const key = await keyOrNull(c, visitorId);
  const db = c.env.RESULTS_DB;
  const res = !db || !key
    ? failAll(c, eligible)
    : await write(c, db, eligible.map((runId) => db.prepare(RESULTS_SQL.conversion).bind(runId, body.goalId, key, c.now)), eligible, RESULTS_ROWS.conversionPerRun * eligible.length);
  for (const runId of eligible) runs[runId] = res.outcome;
  return combine(runs);
}

/** 鍵の計算で例外が出たときも書かない(failed として数える) */
export async function keyOrNull(c: Ctx, visitorId: string): Promise<Uint8Array | null> {
  try {
    return await visitorKey(c.env, c.siteId, visitorId);
  } catch (e) {
    console.error("wtt-edge: results visitor key failed", e);
    return null;
  }
}

type WriteResult = { outcome: ResultOutcome; overall: ResultsEventResponse };
const single = (o: ResultOutcome): WriteResult => ({ outcome: o, overall: o });

/** 書かずに failed を数える(run ごとに 1 件。設計書 §6.7) */
export function failAll(c: Ctx, runIds: string[]): WriteResult {
  const health = healthBuffer();
  for (const runId of runIds) health.count(c.siteId, runId, c.now);
  return single(FAILED);
}

/** 枠を受け取り、1 回の batch で書き、`meta.rows_written` で精算する */
export async function write(c: Ctx, db: D1Database, stmts: D1PreparedStatement[], runIds: string[], estimate: number): Promise<WriteResult> {
  const holder = leaseHolder(c.env);
  const lease = await holder.take(estimate, c.now);
  if (lease.kind === "stopped") return single(stopped(lease.until));
  if (lease.kind === "unreachable") return failAll(c, runIds); // K10: 停止ではなく失敗(停止期間には数えない)
  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (e) {
    // 書けたかどうか分からないので精算しない(枠は使ったまま = 安全側)
    if (isD1DailyLimit(e)) {
      // 最後の砦(設計書 §6.9): 手元の枠を捨て、導入全体を次の UTC 0 時まで止める。停止の記録は応答を待たせない
      const until = nextUtcMidnight(c.now);
      holder.discard();
      c.ctx.waitUntil(
        (async () => budgetStub(c.env).stop("d1_limit", until, c.now))().catch((err) => console.error("wtt-edge: results d1_limit stop failed", err)),
      );
      console.error("wtt-edge: results D1 daily limit reached; collection stopped until", new Date(until).toISOString());
      return single(stopped(until));
    }
    console.error("wtt-edge: results write failed", e);
    return failAll(c, runIds);
  }
  holder.settle(lease.ticket, rowsWritten(results, lease.ticket));
  return single(STORED);
}

/**
 * batch の `meta.rows_written` の合計。壊れた値(数でない・負・小数)が混じれば見込みの行数として扱う
 * (settle は不正な値で throw する。見込みのままなら手元の枠に何も戻さない = 安全側)
 */
function rowsWritten(results: D1Result[], ticket: LeaseTicket): number {
  let sum = 0;
  for (const r of results) {
    const n = r?.meta?.rows_written;
    if (!Number.isSafeInteger(n) || (n as number) < 0) return ticket.rows;
    sum += n as number;
  }
  return Number.isSafeInteger(sum) ? sum : ticket.rows;
}

function isD1DailyLimit(e: unknown): boolean {
  const texts = [e instanceof Error ? e.message : String(e)];
  const cause = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  if (cause !== undefined) texts.push(cause instanceof Error ? cause.message : String(cause));
  return texts.some((t) => D1_DAILY_LIMIT_RE.test(t));
}

/** 強さの順(K8): どれかが stored なら stored。そうでなければ failed > stopped > ignored */
const STRENGTH: Record<ResultOutcome["result"], number> = { stored: 3, failed: 2, stopped: 1, ignored: 0 };

/**
 * CV の全体の結果(K8)。`until` は stopped の run から写す(1 回の take なので同じ値)。
 * 全体が ignored のときは、すべての run が送り直さない ignored のときだけ `retry: false`
 */
function combine(runs: Record<string, ResultOutcome>): ResultsEventResponse {
  const list = Object.values(runs);
  const best = list.reduce<ResultOutcome["result"]>((a, o) => (STRENGTH[o.result] > STRENGTH[a] ? o.result : a), "ignored");
  const overall: ResultsEventResponse = { result: best };
  if (best === "stopped") overall.until = list.find((o) => o.result === "stopped")!.until;
  if (best === "ignored" && list.length > 0 && list.every((o) => o.retry === false)) overall.retry = false;
  overall.runs = runs;
  return overall;
}
