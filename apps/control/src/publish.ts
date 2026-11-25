import { activeGuard, experimentEditId, transitionUpdatedAt, collectionLogStatement, interimCacheDeleteStatement, publishActiveStatement, publishedStatusStatement, snapshotMatches, snapshotOf, type CompileExperimentRow, type StatusAfter, type StatusSnapshot } from "./publish-snapshot";
import { TRANSITIONS } from "./experiment-status";
import type { EvaluationPlan } from "@wtt/stats";
import { sql, type Expression, type ExpressionBuilder, type RawBuilder, type SqlBool } from "kysely";
import {
  analyticsWarnings,
  bakeBootstrap,
  BOOTSTRAP_LIMITS,
  compile,
  CompileError,
  kvKeys,
  LEGACY_TARGETING_HINT,
  parseCompiledConfig,
  type AnalyticsWarning,
  type CompiledConfig,
  type ExperimentKind,
  type ResultsConfig,
  type StaticGeneration,
} from "@wtt/core";
import { RUNTIME_HASH, RUNTIME_SOURCE } from "@wtt/runtime/source";
import { configRecordUpdate, guardAssets, type AssetProblem } from "./asset-guard";
import { auditStatement, type AuditDetail, type AuditStatementOpts, type UserActor } from "./audit";
import { edgeOrigin } from "./capabilities";
import { ASSET_GUARD_HINTS, publishOutcomeUnknown } from "./errors";
import { headExpiryStatement } from "./publish-expiry";
import { sqlStatement, toStatement, type Db, type VariantRow, type ChangeRow, type GoalRow, type ExperimentRow, type AudienceRow, type SiteRow, type Tables } from "./db";
import type { Env } from "./env";
import { orderForCompile, overlapWarnings } from "./experiment-order";
import { newId } from "./ids";
import { siteToSettings } from "./site-settings";
import { RECONCILE_DEFER_MS } from "./cron/run-state";
import { CronFrozen } from "./cron/runner";
import { NOT_FROZEN_SQL } from "./write-freeze";
import { assetDeliveredRefsInsert, confirmDeliveries, deliveredDefinitionInsert, deliveredDefinitionsFor, plansForDelivery, prepareDeliveredDefinitions, setDeliveredGeneration, type PreparedDelivery } from "./results/delivered";
import { apiGuard } from "./results/guard";
import { requestStaticDeploy, type StaticDeployOutcome, type StaticDeployState } from "./static-delivery";

export const RECENT_ACTIVE_MS = 5 * 60_000; // spec §9.4: 5 分以内に active だった版
const MARK_CHUNK = 50; // kv_deleted の印を 1 文で付ける版の数の上限(D1 のバインド変数は 1 文 100 個まで)

export const DELIVERY_DELAY_WARNING: AnalyticsWarning = {
  path: "delivery",
  message: "配信への反映が遅れています。通常 15 分以内に自動で反映します",
};

// 失敗形のフィールド名は §13.5 の封筒に揃える(error = 機械可読コード、message = 文)
export type PublishResult =
  | { ok: true; version: number; needsProfile: boolean; superseded: boolean; staticDeploy: StaticDeployState; staticGeneration?: StaticGeneration | null; warnings: AnalyticsWarning[] }
  | { ok: false; version: number | null; error: string; message: string; hint?: string; assetProblems?: AssetProblem[] };

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** gzip した大きさ(Workers の CompressionStream。決定 50 の警告用) */
async function gzipSize(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

/**
 * spec §6.3 / §13.6 手順 1: Site の running Experiment を core の CompileInput に組み立てる。
 * `experiments` は呼び出し側が読んだ Site の全 Experiment 行(publishSite は published_status の写しと同じ 1 回の SELECT を渡す —
 * 写しと compile 入力を別々に読むと、その間に割り込んだ status 変更で「配信中の config には無い状態」を写してしまう。rulings §4 CX-High-3)
 */
/** 既定は spec §13.6 手順 1 の「running の全 Experiment」。エージェント面(§13.10)は下書きや 1 件だけを対象にするので絞り込みを渡す */
export type CompileInputScope = { statuses?: ReadonlyArray<ExperimentRow["status"]>; experimentIds?: ReadonlyArray<string> };

/** `buildCompileInput` の戻り値(compile の入力の保存する形)。重なりの警告(`overlapWarnings`)もこの experiments を受ける */
export type StoredChangeInput = { id: string; type: string; selector?: string; payload: unknown };
export type StoredExperimentInput = {
  id: string; name: string; kind: ExperimentKind; urlMatch: unknown; targeting?: unknown;
  trafficPercentage: number; persistAssignment: boolean; analytics?: unknown;
  variants: Array<{ id: string; name: string; weight: number; analytics?: unknown; changes: StoredChangeInput[] }>;
};
export type StoredCompileInput = {
  siteId: string; siteSalt: string; version: number; timezone: string; retentionDays: number;
  goals: Array<{ id: string; name: string; type: string; config: unknown; analytics?: unknown }>;
  audiences: Record<string, unknown>;
  experiments: StoredExperimentInput[];
};

/** 公開の版番号を除き、同じ入力をキーの挿入順に依存しない値にする。配列の順は配信の優先順なので保つ。 */
export async function compileInputDigest(input: StoredCompileInput): Promise<string> {
  const { version: _version, ...content } = input;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return sha256Hex(JSON.stringify(canonical(content)));
}

export async function buildCompileInput(
  db: Db,
  site: SiteRow,
  version: number,
  experiments?: ExperimentRow[],
  scope: CompileInputScope = {},
): Promise<StoredCompileInput> {
  const all = experiments ?? (await db.selectFrom("experiments").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute());
  const variants = await db.selectFrom("variants").selectAll().where("site_id", "=", site.id).orderBy("position").execute();
  const changes = await db.selectFrom("changes").selectAll().where("site_id", "=", site.id).orderBy("position").execute();
  const goals = await db.selectFrom("goals").selectAll().where("site_id", "=", site.id).orderBy("id").execute();
  const audiences = await db.selectFrom("audiences").select(["id", "definition_json"]).where("site_id", "=", site.id).orderBy("id").execute();
  return buildCompileInputFromRows(version, { site, experiments: all, variants, changes, goals, audiences }, scope);
}

export type CompileRows = {
  site: SiteRow;
  experiments: CompileExperimentRow[]; variants: VariantRow[]; changes: ChangeRow[]; goals: GoalRow[];
  audiences: AudienceRow[];
};

export const COMPILE_ROW_STATEMENTS = 6;

/** 同じ時点のサイト設定と compile 入力を batch で読む。 */
export function compileRowStatements(env: Env, db: Db, siteId: string, transitionId?: string): D1PreparedStatement[] {
  const experiments = db.selectFrom("experiments").selectAll().where("site_id", "=", siteId).orderBy("created_at");
  // 遷移する 1 行だけ、配信内容の編集印を同じ読みの中で取る。
  const experimentRows = transitionId === undefined
    ? experiments
    : experiments.select(sql<number | null>`case when experiments.id = ${transitionId} then ${experimentEditId()} end`.as("last_edit_id"));
  return [
    toStatement(env, db.selectFrom("sites").selectAll().where("id", "=", siteId)),
    toStatement(env, experimentRows),
    toStatement(env, db.selectFrom("variants").selectAll().where("site_id", "=", siteId).orderBy("position")),
    toStatement(env, db.selectFrom("changes").selectAll().where("site_id", "=", siteId).orderBy("position")),
    toStatement(env, db.selectFrom("goals").selectAll().where("site_id", "=", siteId).orderBy("id")),
    toStatement(env, db.selectFrom("audiences").selectAll().where("site_id", "=", siteId).orderBy("id")),
  ] satisfies D1PreparedStatement[] & { length: typeof COMPILE_ROW_STATEMENTS };
}

export function parseCompileRows(results: D1Result[]): CompileRows {
  const [sites, experiments, variants, changes, goals, audiences] = results;
  const site = sites!.results[0] as SiteRow | undefined;
  if (!site) throw new Error("Site disappeared before reading compile input");
  return {
    site, experiments: experiments!.results as CompileExperimentRow[], variants: variants!.results as VariantRow[],
    changes: changes!.results as ChangeRow[], goals: goals!.results as GoalRow[], audiences: audiences!.results as AudienceRow[],
  };
}

export async function loadCompileRows(env: Env, db: Db, siteId: string, transitionId?: string): Promise<CompileRows> {
  return parseCompileRows(await env.DB.batch(compileRowStatements(env, db, siteId, transitionId)));
}

export function applyTransitionToRows(rows: CompileRows, { experimentId, to, stamps }: Pick<PublishTransition, "experimentId" | "to" | "stamps">): CompileRows | null {
  const exp = rows.experiments.find((e) => e.id === experimentId);
  if (!exp || !TRANSITIONS[exp.status].includes(to)) return null;
  return { ...rows, experiments: rows.experiments.map((e) => e.id === experimentId ? { ...e, status: to, ...stamps } : e) };
}

export function buildCompileInputFromRows(version: number, rows: Omit<CompileRows, "audiences"> & { audiences: Pick<AudienceRow, "id" | "definition_json">[] }, scope: CompileInputScope = {}): StoredCompileInput {
  const { site, variants, changes, goals, audiences } = rows;
  const statuses = scope.statuses ?? (["running"] as const);
  const exps = orderForCompile(rows.experiments.filter((e) => statuses.includes(e.status) && (!scope.experimentIds || scope.experimentIds.includes(e.id))));
  return {
    siteId: site.id,
    siteSalt: site.site_salt,
    version,
    timezone: site.timezone,
    // B77(K5): 目標の外部計測(目標名の指定)。compile が conversionPayloads に焼く
    goals: goals.map((g) => ({ id: g.id, name: g.name, type: g.type, config: JSON.parse(g.config_json), ...(g.analytics_json ? { analytics: JSON.parse(g.analytics_json) } : {}) })),
    retentionDays: site.retention_days,
    audiences: Object.fromEntries(audiences.map((a) => [a.id, JSON.parse(a.definition_json)])),
    experiments: exps.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      urlMatch: JSON.parse(e.url_match_json),
      ...(e.targeting_json ? { targeting: JSON.parse(e.targeting_json) } : {}),
      trafficPercentage: e.traffic_percentage,
      persistAssignment: e.persist_assignment === 1,
      ...(e.analytics_json ? { analytics: JSON.parse(e.analytics_json) } : {}),
      variants: variants
        .filter((v) => v.experiment_id === e.id)
        .map((v) => ({
          id: v.id,
          name: v.name,
          weight: v.weight,
          ...(v.analytics_json ? { analytics: JSON.parse(v.analytics_json) } : {}),
          changes: changes
            .filter((ch) => ch.experiment_id === e.id && ch.variant_id === v.id)
            .map((ch) => ({ id: ch.id, type: ch.type, ...(ch.selector ? { selector: ch.selector } : {}), payload: JSON.parse(ch.payload_json) })),
        })),
    })),
  };
}

/**
 * D9 ②(設計書 §6.3・§9.3、plan ② の K15): compiled config の `results`。`all` は Site の全エクスペリエンス行(状態を問わない)。
 * `runs` = 結果を記録する Site の、running / paused のテストで run_id があるもの(paused は experiments[] に載らないので別に集める)。
 * 出すのは runs が空でないとき、または run_id があって個票を消していない(results_purged_at が無い)エクスペリエンスが残っているとき
 * (結果の記録を無効にした後・すべて終了した後も、個票が残っている間は forget のために出す)。
 * D9 ③(K6 (1)): pendingPurge = Site の results_purge_queue に行がある(削除したエクスペリエンスの個票がまだ残っている)。
 * その間も forget のために出す(run_id を持つエクスペリエンスを削除した後に forget が止まらない)。
 * compile の入力に足すのは publishSite だけ(buildCompileInput は足さない: エージェントの what-if・下書きの bootstrap・公開前の差分に入れない)
 */
export function resultsForCompile(site: SiteRow, all: ExperimentRow[], pendingPurge: boolean): ResultsConfig | undefined {
  const runs: Record<string, string> = {};
  if (site.results_enabled === 1)
    for (const e of all) if (e.kind === "test" && (e.status === "running" || e.status === "paused") && e.run_id !== null) runs[e.id] = e.run_id;
  const rowsMayRemain = pendingPurge || all.some((e) => e.run_id !== null && e.results_purged_at === null);
  return Object.keys(runs).length > 0 || rowsMayRemain ? { forget: true, runs } : undefined;
}

/** D9 ③(K6 (1)): Site の個票の削除待ち(results_purge_queue の行)があるか */
export async function hasPendingPurge(db: Db, siteId: string): Promise<boolean> {
  const row = await db.selectFrom("results_purge_queue").select("run_id").where("site_id", "=", siteId).limit(1).executeTakeFirst();
  return row !== undefined;
}

/**
 * KV `active` の put。書く値は「その時点の D1 最新版」で、自分の版を固定しない(遅延した再試行が新しい版を上書きしないため。review r2 CX-High-4)。
 * 同一キー 1 秒 1 回の制限があるので、GET・公開は失敗後 1.1 秒待って 1 回だけ再試行する。Cron は次の回に回す。
 */
export const ACTIVE_PUT_RETRY_MS = 1100;
async function putActiveLatest(env: Env, db: Db, siteId: string, opts?: {
  beforePut(version: number, lastActivatedAt: number | null): Promise<void>;
  cron?: { assertNotFrozen(): Promise<void> };
}): Promise<number> {
  let attempted = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const row = await db.selectFrom("sites").select(["active_version", "last_activated_at"]).where("id", "=", siteId).executeTakeFirstOrThrow();
      if (row.active_version === null) throw new Error("active_version is null; refusing to write a dangling kv active pointer");
      await opts?.beforePut(row.active_version, row.last_activated_at);
      attempted = true;
      try {
        await env.CONFIG_KV.put(kvKeys.active(siteId), String(row.active_version));
        return row.active_version;
      } catch (e) {
        if (attempt > 0 || opts?.cron) throw e;
        await new Promise(resolve => setTimeout(resolve, ACTIVE_PUT_RETRY_MS));
      }
    }
  } catch (e) {
    // put の失敗応答は反映済みかもしれない。その間に新版の公開が降ろした印を立て直す。
    // 再試行の版の確認で止まったときも、最初の put を同じように扱う。
    if (attempted) await markActiveVersion(env, db, siteId, null, !!opts?.cron);
    throw e;
  }
}

export { RECONCILE_DEFER_MS };
export type ReconcileRow = Pick<SiteRow, "active_kv_stale" | "active_version" | "last_activated_at">;
export type ReconcileOutcome = { stale: boolean; reason: "pending" | "config_missing" | null; deferred: boolean; kvPuts: number };

class MissingConfig extends Error {}
class DeferredRepair extends Error {}

function recentlyActivated(lastActivatedAt: number | null, nowMs: number): boolean {
  return lastActivatedAt !== null && lastActivatedAt > nowMs - RECONCILE_DEFER_MS;
}

async function requireVersionConfig(env: Env, siteId: string, version: number): Promise<void> {
  const body = await env.CONFIG_KV.get(kvKeys.config(siteId, version), "stream");
  if (body === null) {
    console.error("publish repair: config missing", siteId, version);
    throw new MissingConfig();
  }
  await body.cancel(); // 存在だけを調べる。大きな設定本文を展開しない。
}

// 古い版の put が後から着いた場合も、次の修復で拾えるように印を立て直す。
async function markActiveVersion(env: Env, db: Db, siteId: string, written: number | null, cron = false) {
  const mark = db.updateTable("sites")
    .set({ active_kv_stale: written === null ? 1 : sql<number>`case when active_version = ${written} then 0 else 1 end` })
    .where("id", "=", siteId)
    .returning("active_kv_stale");
  if (!cron) return mark.executeTakeFirst();

  // 成功時の比較も失敗時の立て直しも、同じ1往復で凍結を読み、未凍結時だけ印を書く。
  const [freeze, updated] = await env.DB.batch<{ active_kv_stale: number }>([
    env.DB.prepare(`select 1 where not (${NOT_FROZEN_SQL})`),
    toStatement(env, mark.where(sql<SqlBool>`${sql.raw(NOT_FROZEN_SQL)}`)),
  ]);
  const marked = updated?.results[0];
  if (!marked && freeze?.results.length) throw new CronFrozen();
  return marked;
}

/** GET・公開の冒頭はベストエフォート。Cron の凍結だけは runner に返す。 */
export async function reconcileActive(env: Env, db: Db, siteId: string, opts: {
  nowMs: number;
  row?: ReconcileRow;
  cron?: { assertNotFrozen(): Promise<void> };
}): Promise<ReconcileOutcome> {
  let kvPuts = 0;
  try {
    const row = opts.row ?? await db.selectFrom("sites").select(["active_kv_stale", "active_version", "last_activated_at"]).where("id", "=", siteId).executeTakeFirstOrThrow();
    if (row.active_kv_stale !== 1 || row.active_version === null) return { stale: false, reason: null, deferred: false, kvPuts };
    if (recentlyActivated(row.last_activated_at, opts.nowMs)) {
      return { stale: true, reason: "pending", deferred: true, kvPuts };
    }
    let checked = row.active_version;
    await requireVersionConfig(env, siteId, checked);
    let written = checked;
    if (await env.CONFIG_KV.get(kvKeys.active(siteId)) !== String(checked)) {
      written = await putActiveLatest(env, db, siteId, {
        cron: opts.cron,
        async beforePut(version, lastActivatedAt) {
          if (recentlyActivated(lastActivatedAt, opts.nowMs)) throw new DeferredRepair();
          if (checked !== version) {
            await requireVersionConfig(env, siteId, version);
            checked = version;
          }
          await opts.cron?.assertNotFrozen();
          kvPuts++;
        },
      });
    }
    const marked = await markActiveVersion(env, db, siteId, written, !!opts.cron);
    const stale = marked?.active_kv_stale !== 0;
    return { stale, reason: stale ? "pending" : null, deferred: false, kvPuts };
  } catch (e) {
    if (opts.cron && e instanceof CronFrozen) throw e;
    return { stale: true, reason: e instanceof MissingConfig ? "config_missing" : "pending", deferred: e instanceof DeferredRepair, kvPuts };
  }
}

/**
 * `recordFailure` が残す `"<code>: <生テキスト>"` からコード部分だけを取り出す(Plan 10 B1)。
 * `publishes.error` は制約の無い TEXT 列で形式の保証が無いため、区切りが無い・コードの形(英小文字・数字・_)でない行は
 * 固定の `publish_failed` に閉じる(fail-closed。r1 CX-Medium-1 / r2 CX-Medium-1: 区切りが無ければ内容にかかわらず閉じる)
 */
const PUBLISH_ERROR_CODE_RE = /^[a-z][a-z0-9_]*$/;
export function publishErrorCode(stored: string): string {
  const i = stored.indexOf(": ");
  if (i <= 0) return "publish_failed"; // 区切りが無い・先頭にある = recordFailure の形ではない(r2 CX-Medium-1: `timeout` のような英小文字列を生のまま返さない)
  const code = stored.slice(0, i);
  return PUBLISH_ERROR_CODE_RE.test(code) ? code : "publish_failed";
}

type FailureOptions = { historyCode?: string; assetProblems?: AssetProblem[]; kvDeleted?: boolean };

/** 失敗の記録と予約の消失・失効の判別は同じトランザクションで行う。履歴が書けなければ元の失敗を返す。 */
async function recordFailure(
  env: Env, db: Db, rowId: string, version: number | null, code: string, raw: string, opts: FailureOptions = {},
): Promise<Failure> {
  if (rowId) {
    try {
      const update = db.updateTable("publishes")
        .set({ status: "failed", error: `${opts.historyCode ?? code}: ${raw}`.slice(0, 2000), ...(opts.kvDeleted ? { kv_deleted: 1 } : {}) })
        .where("id", "=", rowId).where("status", "=", "reserved");
      const [marked, own] = await env.DB.batch<{ version: number }>([
        toStatement(env, update),
        toStatement(env, db.selectFrom("publishes").select("version").where("id", "=", rowId)),
      ]);
      if (marked?.meta.changes === 0) {
        const existing = own?.results[0];
        if (existing) return failure("publish_reservation_expired", existing.version, raw);
        if (version !== null) return failure("publish_record_missing", version, raw);
        // 予約の応答がなく、自分の行も無ければ、INSERT 自体の失敗として元のエラーを返す。
      }
    } catch (e) {
      console.error("failed to record publish failure", rowId, code, e);
    }
  }
  return failure(code, version, raw, opts.assetProblems);
}

/**
 * 失敗結果の利用者向け文言(日本語)。`PublishResult.message` は 200 応答の結果本体で封筒ではないため `ApiError` の
 * 既定文が届かず、かつては生の例外文字列(`String(e)`)や core の英語診断文をそのまま UI に出していた(rulings §4 最終レビュー)。
 * 生のテキストは `recordFailure` で `publishes.error` に残し、ここでサーバーログにも出す
 */
const RETRY_HINT = "数秒後にもう一度公開してください";
const FAILURE_MESSAGES: Record<string, { message: string; hint?: string }> = {
  stale_preview: { message: "確認した後に、公開する内容が変わりました", hint: "公開の確認をもう一度開き、変わった内容を確かめてから公開してください" },
  version_reservation_failed: { message: "公開 version の予約に失敗しました", hint: RETRY_HINT },
  unknown_goal: { message: "参照している目標が見つかりません" },
  legacy_targeting: { message: "古い書式の配信条件があります" },
  invalid_experiment_targeting: { message: "この形では配信できない配信条件があります" },
  page_condition_moved: { message: "配信条件・オーディエンスに、使えなくなったページの条件があります" },
  invalid_audience_definition: { message: "配信できないオーディエンスがあります" },
  unknown_audience: { message: "参照しているオーディエンスが見つかりません" },
  within_days_exceeds_retention: { message: "期間が訪問者データの保存期間を超える条件があります" },
  config_too_large: { message: "compiled config が大きすぎます", hint: "配信中のエクスペリエンスや変更を減らしてください" },
  invalid_input: { message: "config の生成に必要な入力が不正です" },
  invalid_analytics: { message: "外部計測の設定が不正です" },
  compile_failed: { message: "config の生成に失敗しました" },
  kv_put_failed: { message: "config を KV に書き込めませんでした", hint: RETRY_HINT },
  kv_verify_failed: { message: "書き込んだ config の読み戻し検証に失敗しました", hint: RETRY_HINT },
  state_changed: { message: "公開の準備の間に、エクスペリエンスの状態が変わりました", hint: "もう一度公開してください" },
  // 7n(B48): activation の直前に、この公開の予約行が無くなっていた(D1 を以前の時点に戻した後など)。この版は有効にしていない
  publish_reservation_expired: { message: "公開の準備に時間がかかりすぎたため、この版を有効にしませんでした", hint: "もう一度公開してください" },
  publish_record_missing: { message: "公開の記録が見つからないため、この版を有効にしませんでした", hint: "データベースを以前の時点に戻した後などに起きます。もう一度公開してください" },
  invalid_regex: { message: "配信できない正規表現があります" },
  regex_too_large: { message: "大きすぎる正規表現があります" },
  regex_budget_exceeded: { message: "正規表現の合計が大きすぎます(サイト全体で 500 命令まで)" },
  audience_expansion_too_large: { message: "オーディエンスの参照が多すぎます(展開した条件の数はサイト全体で 20,000 まで)" },
  // B68: 公開する設定の画像の確かめ。どの画像かは応答の assetProblems に載る
  asset_missing: { message: "公開する内容に、見つからない画像があります", hint: ASSET_GUARD_HINTS.asset_missing },
  asset_other_site: { message: "公開する内容に、別のサイトの画像があります", hint: ASSET_GUARD_HINTS.asset_other_site },
};
/** compile の CompileError の message が利用者向けの日本語の説明(場所と直し方)になっているコード。hint にそのまま出す */
export const COMPILE_HINT_CODES: ReadonlySet<string> = new Set([
  "invalid_regex", "regex_too_large", "regex_budget_exceeded", "audience_expansion_too_large",
  "legacy_targeting", "invalid_experiment_targeting", "invalid_audience_definition", "unknown_audience", "unknown_goal", "within_days_exceeds_retention",
  "page_condition_moved",
]);

/** Publish の失敗(と、確認画面の compile の失敗)の利用者向けの文言。古い書式は書き換え方も足す */
export function describeCompileFailure(code: string, raw: string): { message: string; hint?: string } {
  const text = FAILURE_MESSAGES[code] ?? { message: "公開に失敗しました" };
  if (!COMPILE_HINT_CODES.has(code)) return text;
  return { message: text.message, hint: code === "legacy_targeting" ? `${raw}。${LEGACY_TARGETING_HINT}` : raw };
}

function failure(code: string, version: number | null, raw: string, assetProblems?: AssetProblem[]): Extract<PublishResult, { ok: false }> {
  console.error(`publish failed (${code})`, raw);
  const { message, hint } = describeCompileFailure(code, raw);
  return { ok: false, version, error: code, message, ...(hint ? { hint } : {}), ...(assetProblems ? { assetProblems } : {}) };
}

/**
 * B129(spec §3.1 の publish.publish・§5.2): 公開の記録。activation の CAS の batch(後。この要求の印 = 自分の版が active)、
 * 追い越しの文(後。予約行が残っているとき)に 1 文ずつ置く(往復は増えない)。
 * CAS より前の失敗(版の予約・compile・config の put・読み戻し)では D1 の配信中の状態は変わらないので記録しない。
 * actor = 公開した人(published_by は actor.userId)。状態の変更の後の自動の公開も、状態を変えた人
 */
function publishAudit(env: Env, actor: UserActor, site: SiteRow, detail: AuditDetail, opts: AuditStatementOpts): D1PreparedStatement {
  return auditStatement(env.DB, actor, {
    action: "publish.publish", workspaceId: site.workspace_id, siteId: site.id, detail,
    target: { type: "site", id: site.id, label: site.name },
  }, opts);
}

export type PublishOptions = { skipAssetGuard?: boolean; expectDigest?: string };

export type TransitionStamps = Partial<Pick<ExperimentRow, "started_at" | "last_started_at" | "stopped_at" | "run_id">>;
export type PublishTransition = {
  experimentId: string;
  from: ExperimentRow["status"];
  to: "running" | "paused" | "archived";
  stamps: TransitionStamps;
  updatedBy: string;
  casWritable: (eb: ExpressionBuilder<Tables, "experiments">) => Expression<SqlBool>;
  statements: (activeGuard: RawBuilder<SqlBool>, at: number, updatedAt: RawBuilder<number>) => D1PreparedStatement[];
  deliveryPlanOverride?: { experimentId: string; plan: EvaluationPlan };
  collectUntilDirty: boolean;
  afterActivePut?: () => Promise<void>;
};

type Success = Extract<PublishResult, { ok: true }>;
type Failure = Extract<PublishResult, { ok: false }>;
type PublishAttempt = PublishOptions & { transition?: PublishTransition };
type AttemptResult =
  | { kind: "applied"; publish: Success }
  | { kind: "prepare_failed" | "stale_preview" | "invalid_transition" | "conflict" | "record_missing" | "reservation_expired"; publish: Failure }
  | { kind: "outcome_unknown" };

export type TransitionPublishResult =
  | { kind: "applied"; publish: Success }
  | { kind: "prepare_failed" | "record_missing" | "reservation_expired"; publish: Failure }
  | { kind: "stale_preview" | "invalid_transition" | "conflict" | "outcome_unknown" };

export type PreparedPublish = {
  site: SiteRow;
  actor: UserActor;
  nowMs: number;
  version: number;
  rowId: string;
  key: string;
  body: string;
  hash: string;
  config: CompiledConfig;
  warnings: AnalyticsWarning[];
  deliveries: PreparedDelivery[];
  rows: CompileRows;
  transition?: PublishTransition;
  snapshotBefore: StatusSnapshot;
  statusAfter: StatusAfter;
};

export type ActivationOutcome =
  | { kind: "activated" }
  | { kind: "superseded" }
  | { kind: "invalid_transition" }
  | { kind: "state_changed" }
  | { kind: "record_missing" }
  | { kind: "reservation_expired" }
  | { kind: "not_activated_after_error" }
  | { kind: "outcome_unknown" };

/**
 * spec §13.6 の Publish。準備・activation・後処理の順に行い、activation 前の失敗は旧 version を active のまま残す。
 * nowMs は公開の記録と cleanup の時刻判定に使う(テストで注入)。
 * actor = 公開した人(B129: published_by は actor.userId。公開の記録 publish.publish の操作した人)。
 */
export async function publishSite(env: Env, db: Db, site: SiteRow, actor: UserActor, nowMs = Date.now(), opts: PublishOptions = {}): Promise<PublishResult> {
  const result = await runPublish(env, db, site, actor, nowMs, opts);
  if (result.kind === "outcome_unknown") throw publishOutcomeUnknown();
  return result.publish;
}

export async function publishWithTransition(
  env: Env, db: Db, site: SiteRow, actor: UserActor, nowMs: number, opts: PublishOptions & { transition: PublishTransition },
): Promise<TransitionPublishResult> {
  const result = await runPublish(env, db, site, actor, nowMs, opts);
  if (result.kind === "invalid_transition" || result.kind === "stale_preview" || result.kind === "conflict") return { kind: result.kind };
  return result;
}

function failedAttempt(publish: Failure, kind: "prepare_failed" | "invalid_transition" | "stale_preview" | "conflict"): AttemptResult {
  if (publish.error === "publish_reservation_expired") return { kind: "reservation_expired", publish };
  if (publish.error === "publish_record_missing") return { kind: "record_missing", publish };
  return { kind, publish };
}

async function runPublish(env: Env, db: Db, site: SiteRow, actor: UserActor, nowMs: number, opts: PublishAttempt): Promise<AttemptResult> {
  const preparation = await preparePublish(env, db, site, actor, nowMs, opts);
  if (!preparation.ok) {
    const publish = preparation.result;
    const kind = publish.error === "stale_preview" || publish.error === "invalid_transition" ? publish.error : "prepare_failed";
    return failedAttempt(publish, kind);
  }

  const { prepared } = preparation;
  const activation = await activatePublish(env, db, prepared);
  const { version, rowId, config, warnings } = prepared;
  switch (activation.kind) {
    case "invalid_transition":
      break;
    case "state_changed": {
      if (opts.transition) break;
      const reason = "experiment status or last_started_at changed before activation";
      return failedAttempt(await recordFailure(env, db, rowId, version, "state_changed", reason), "prepare_failed");
    }
    case "outcome_unknown":
      return activation;
    case "not_activated_after_error": {
      const reason = "activation did not commit";
      return failedAttempt(await recordFailure(env, db, rowId, version, "publish_failed", reason), "prepare_failed");
    }
    case "reservation_expired":
      return { kind: activation.kind, publish: failure("publish_reservation_expired", version, `publish record ${rowId} expired before activation`) };
    case "record_missing":
      return { kind: activation.kind, publish: failure("publish_record_missing", version, `publish record ${rowId} (version ${version}) is gone before activation`) };
    case "superseded":
      if (opts.transition) break;
      return { kind: "applied", publish: { ok: true, version, needsProfile: config.needsProfile, superseded: true, staticDeploy: "skipped", warnings } };
    case "activated":
      return { kind: "applied", publish: await finishPublish(env, db, prepared) };
  }
  const publish = await recordFailure(env, db, rowId, version, "transition_conflict", activation.kind);
  return failedAttempt(publish, activation.kind === "invalid_transition" ? "invalid_transition" : "conflict");
}

/**
 * 公開に使う設定を用意し、予約した版の config を KV に置いて検証する。
 * B68(spec §22.2): compile の後に画像の参照を取り出し(D1・DO を読まない)、設定の記録(手順 4)を KV の put の前に出して、
 * 「取り出した画像がすべて印の無い行としてある」を条件にした 1 文にする。一時停止・終了では取り出しを飛ばし、同じ文に空の ID の並びを渡す。
 */
export async function preparePublish(
  env: Env,
  db: Db,
  site: SiteRow,
  actor: UserActor,
  nowMs: number,
  opts: PublishAttempt,
): Promise<{ ok: true; prepared: PreparedPublish } | { ok: false; result: Extract<PublishResult, { ok: false }> }> {
  let version: number | null = null;
  let rowId = "";
  try {
    await reconcileActive(env, db, site.id, { nowMs });
    // 手順 2: version を予約(UNIQUE(site_id, version) で競合を検出して取り直す)
    for (let attempt = 0; attempt < 5 && version === null; attempt++) {
      rowId = newId("pub");
      try {
        const reserve = sql`
          insert into publishes (id, site_id, version, status, published_by, created_at)
          select ${rowId}, ${site.id}, coalesce(max(version), 0) + 1, 'reserved', ${actor.userId}, ${nowMs} from publishes where site_id = ${site.id}
          returning version`;
        const [, r] = await env.DB.batch<{ version: number }>([headExpiryStatement(env, site.id, nowMs), sqlStatement(env.DB, reserve)]);
        version = r?.results[0]?.version ?? null;
      } catch (e) {
        if (!/UNIQUE/i.test(String(e))) throw e;
      }
    }
    if (version === null) return { ok: false, result: failure("version_reservation_failed", null, "could not reserve a version after 5 attempts") };

    return await prepareReservedPublish(env, db, site, actor, nowMs, opts, version, rowId);
  } catch (e) {
    // 予約の応答だけが失われた場合も、自分の行が reserved なら失敗を記録する。
    return { ok: false, result: await recordFailure(env, db, rowId, version, "publish_failed", String(e)) };
  }
}

async function prepareReservedPublish(
  env: Env, db: Db, site: SiteRow, actor: UserActor, nowMs: number, opts: PublishAttempt, version: number, rowId: string,
): ReturnType<typeof preparePublish> {
  const fail = async (code: string, raw: string, options?: FailureOptions) => ({
    ok: false as const, result: await recordFailure(env, db, rowId, version, code, raw, options),
  });
  // 手順 1 + 3: compile(参照エラー / サイズ超過は CompileError)
  const before = await loadCompileRows(env, db, site.id, opts.transition?.experimentId);
  const snapshotBefore = snapshotOf(before);
  const rows = opts.transition ? applyTransitionToRows(before, opts.transition) : before;
  if (!rows) {
    const code = opts.expectDigest !== undefined ? "stale_preview" : "invalid_transition";
    const reason = "experiment can no longer make the requested transition";
    return fail(code, reason, { historyCode: code === "invalid_transition" ? "transition_conflict" : code });
  }
  site = rows.site;
  const { experiments } = rows;
  const statusAfter = experiments.map(({ id, status }) => ({ id, status }));
  const input = buildCompileInputFromRows(version, rows);
  if (opts.expectDigest !== undefined && await compileInputDigest(input) !== opts.expectDigest) {
    return fail("stale_preview", "compile input changed since preview");
  }
  // D9 ②(K15): results は Publish の経路だけで足す(写しと同じ SELECT の行から作る)。③ K6: 削除待ちの個票があれば forget を出し続ける
  const results = resultsForCompile(site, experiments, await hasPendingPurge(db, site.id));
  let config: CompiledConfig;
  try {
    config = compile(results ? { ...input, results } : input);
  } catch (e) {
    const code = e instanceof CompileError ? e.code : "compile_failed";
    const message = e instanceof Error ? e.message : String(e);
    return fail(code, message);
  }
  // 届く定義は compile が通った後に作る(同じ input・同じ行のまま)。展開の上限(B159)より前にオーディエンスを展開した全ノードを
  // JSON 化・hash しない。compile は input を書き換えないので、前に作っていたときと記録は同じ
  const deliveries = await prepareDeliveredDefinitions(deliveredDefinitionsFor(input, experiments, await plansForDelivery(db, site.id, opts.transition?.deliveryPlanOverride)), experiments);
  // §10.9: compile は警告に留める。拒否は保存 API(`assertName`)側
  const warnings = analyticsWarnings(config);
  // 決定 51(設計書 §3.3): 同じ対象 URL・同じセレクタを変える組。拒否はしない(どちらが優先されるかを文に入れる)
  for (const { path, message } of overlapWarnings(input.experiments)) warnings.push({ path, message });
  // 決定 50: サイト設定を焼いたタグの gzip が、同期配信の目安を超えた場合に警告する。
  const bootstrapBytes = await gzipSize(bakeBootstrap(config, siteToSettings(site), RUNTIME_SOURCE, { apiBase: edgeOrigin(env), runtimeHash: RUNTIME_HASH }));
  const budget = BOOTSTRAP_LIMITS.totalBytes - BOOTSTRAP_LIMITS.headerAllowance;
  if (bootstrapBytes > budget)
    warnings.push({
      path: "bootstrap",
      message: `配信するタグが大きく(gzip ${bootstrapBytes} バイト、目安 ${budget} バイト)、ページを開いてから最初の表示まで時間がかかることがあります。配信中のエクスペリエンスや変更を減らすと小さくなります`,
    });

  const key = kvKeys.config(site.id, version);
  const body = JSON.stringify(config);
  const hash = await sha256Hex(body);
  // B68 手順 3(spec §22.2): 画像の参照の取り出し。別のサイトの URL は D1 を読まずに失敗にする(KV にはまだ何も置いていない)
  let assetIds: string[] = [];
  if (opts.transition ? opts.transition.to === "running" : !opts.skipAssetGuard) {
    const g = await guardAssets(env, db, site, input, body, { readD1: false });
    if (!g.ok) {
      return fail(g.error, g.assetProblems.map((p) => p.url).join(" "), { assetProblems: g.assetProblems });
    }
    assetIds = g.ids;
  }
  // 手順 4: 公開履歴(本体 + hash)を予約行に記録。KV の put の前に、画像が消す途中・消し終えていないことを条件にした 1 文で書く。
  // Cron の印の文は「届きうる版(kv_deleted = 0 かつ config_hash あり)の config_json に ID が無い」を条件に持つので、D1 が書き込みを
  // 1 本ずつ通す順で、こちらが先なら印は付かず、印が先ならこちらが 0 行になる。往復は前の UPDATE と同じ 1 回
  // B69(CX-High-2): 同じ文で、この版の配る設定に入ったエクスペリエンスの ID も記録する(配信の確かめが、入っていない版を証拠にしない)
  const [recorded] = await env.DB.batch([
    toStatement(env, configRecordUpdate(db, rowId, site.id, hash, body, config.needsProfile, assetIds, config.experiments.map((e) => e.id))),
  ]);
  if ((recorded?.meta.changes ?? 0) === 0) {
    if (assetIds.length > 0) {
      const g = await guardAssets(env, db, site, input, body, { readD1: true });
      const problems = g.ok ? [] : g.assetProblems;
      const raw = problems.length > 0 ? problems.map((p) => p.url).join(" ") : `asset ids missing: ${assetIds.join(" ")}`;
      return fail("asset_missing", raw, { assetProblems: problems });
    }
    // 画像の条件が空なら UPDATE の0行は使える予約がない。準備中の予約の消失と失効を区別し、状態だけの変更を防ぐ。
    const row = await db.selectFrom("publishes").select("id").where("id", "=", rowId).executeTakeFirst();
    const code = row ? "publish_reservation_expired" : "publish_record_missing";
    return { ok: false, result: failure(code, version, `publish record ${rowId} unavailable before config write`) };
  }
  // 手順 3(KV): 予約した N に 1 回だけ put(immutable)。失敗した版の行には config_hash があるので、cleanupOldVersions が後でキーを
  // 消して kv_deleted = 1 にする(無いキーの delete も成功する)。それまでは Cron の「訪問者に届きうる版」に入り、その画像は消えない
  try {
    await env.CONFIG_KV.put(key, body);
  } catch (e) {
    return fail("kv_put_failed", String(e));
  }

  // 手順 5: 読み戻して hash 一致を確認してから activation
  let back: string | null = null;
  try {
    back = await env.CONFIG_KV.get(key);
  } catch {
    back = null;
  }
  if (back === null || (await sha256Hex(back)) !== hash) {
    await env.CONFIG_KV.delete(key).catch(() => {});
    return fail("kv_verify_failed", "config read-back missing or hash mismatch", { kvDeleted: true });
  }

  return { ok: true, prepared: { site, actor, nowMs, version, rowId, key, body, hash, config, warnings, deliveries, rows, snapshotBefore, statusAfter, transition: opts.transition } };
}

/** 準備した版を D1 で有効にし、競合や予約行の消失を判定する。 */
export async function activatePublish(env: Env, db: Db, p: PreparedPublish): Promise<ActivationOutcome> {
  const { site, actor, nowMs, version, rowId, key, hash, deliveries } = p;
  /**
   * activation の調停(spec §13.6「自分より小さいときだけ進める」条件付き更新)。
   * 直前に読んだ prev と一致するときだけ進める CAS で、外れたら読み直して再試行する。**読み直しは必須**:
   * 並行 Publish は全員が同じ `active_version` を読んでから順に更新するので、1 回きりの CAS では
   * 最初の 1 本しか activation できず、いちばん新しい version が superseded になって**古い config が配信され続ける**
   * (この形は実測で `concurrent_publish_has_monotonic_versions` が active=1 になり落ちる)。
   * その時点の active_version が自分以上なら、追い越されたと判断する。
   */
  const CAS_ATTEMPTS = 5;
  let activated = false;
  let recordMissing = false;
  // 7n レビュー: 同じ版の番号の行が(rowId を問わず)あるか。D1 を戻した後に別の公開が同じ版を取り直していれば、KV の config/v<N> はその行のもの
  let versionTaken = false;
  // 7n(B48): この公開の予約行(publishes の rowId の行)がまだあること。D1 を Time Travel で戻した後に、戻す前から続いていた公開などで
  // 行が消えていたら、公開の履歴に無い版を active にしない。CAS の条件と、読み直しの列の両方に使う(読み直しの SELECT の中の副問い合わせなので往復は増えない)
  const ownStatus = db.selectFrom("publishes").select("status")
    .where("id", "=", rowId).where("site_id", "=", site.id).where("version", "=", version);
  const taken = (eb: ExpressionBuilder<Tables, "sites">) =>
    eb.exists(eb.selectFrom("publishes").select("publishes.id").where("publishes.site_id", "=", site.id).where("publishes.version", "=", version));
  /**
   * 予約行が無いときの KV の config/v<N> の後始末。公開の履歴から辿れず古い版の掃除が拾えないので消すが、同じ版の番号の行がほかにあれば
   * (戻した後の公開し直し。compile は時刻を含まないので bytes も同じになりうる)そのキーは今の行のものなので消さない。
   * 無ければ、中身が自分の書いたもの(hash が一致)のときだけ消す
   */
  const dropOrphanConfig = async (versionIsTaken: boolean): Promise<void> => {
    if (versionIsTaken) return;
    try {
      const cur = await env.CONFIG_KV.get(key);
      if (cur !== null && (await sha256Hex(cur)) === hash) await env.CONFIG_KV.delete(key);
    } catch (e) {
      console.error("orphan config delete failed", key, e);
    }
  };
  const transition = p.transition;
  const guard = activeGuard(site.id, version, rowId);
  // 準備を通った遷移には対象行がある。CAS の再試行でも最初に compile した行の編集印と比べる。
  const transitionStatements = transition
    ? transition.statements(guard, nowMs, transitionUpdatedAt(p.rows.experiments.find((e) => e.id === transition.experimentId)!, nowMs))
    : [];
  const transitionOk = transition
    ? sql<SqlBool>`exists ${db.selectFrom("experiments").select("id").where(transition.casWritable)}`
    : undefined;
  const snapshotOk = snapshotMatches(site.id, p.snapshotBefore);
  // 5 回目が 0 行なら最後にもう一度だけ原因を読む。CAS を送るのは 5 回まで。
  for (let attempt = 0; attempt <= CAS_ATTEMPTS && !activated; attempt++) {
    const cur = await db
      .selectFrom("sites")
      .select((eb) => [
        "active_version", ownStatus.as("reservation_status"), taken(eb).as("taken"), snapshotOk.as("snapshot_ok"),
        sql<number>`(select coalesce(max(id), 0) from audit_events where at = ${nowMs})`.as("last_audit_id"),
      ])
      .$if(!!transition, (q) => q.select([
        transitionOk!.as("transition_ok"),
        db.selectFrom("experiments").select("status").where("site_id", "=", site.id).where("id", "=", transition!.experimentId).as("transition_from"),
      ]))
      .where("id", "=", site.id)
      .executeTakeFirstOrThrow()
      .catch((e: unknown) => {
        console.error("activation precondition read failed", site.id, version, e);
        return null;
      });
    // この試行はまだ batch を送っていない。それまでの CAS もすべて 0 行と分かっている。
    if (!cur) return { kind: "not_activated_after_error" };
    const prev = cur.active_version;
    // 予約行が無い = 追い越しではない(superseded の UPDATE は当たる行が無い)。下で KV の config を消して失敗にする
    if (!cur.reservation_status) {
      recordMissing = true;
      versionTaken = Boolean(Number(cur.taken));
      break;
    }
    if (cur.reservation_status !== "reserved") return { kind: "reservation_expired" };
    if (transition && (cur.transition_from !== transition.from || !Number(cur.transition_ok))) return { kind: "invalid_transition" };
    if (!Number(cur.snapshot_ok)) return { kind: "state_changed" };
    if (attempt === CAS_ATTEMPTS || (prev !== null && prev >= version)) break;
    const cas = db
      .updateTable("sites")
      // 決定 52 / plan K4: 配信ファイルの印は activation と同じ文で立てる。出し直しの依頼の前に処理が止まっても印が残り、
      // GET の自己修復が拾う。activation で seq を進めるので、それより前の依頼の結果が印を下ろさない
      .set({ active_version: version, last_activated_at: nowMs, active_kv_stale: 1, static_seq: sql<number>`static_seq + 1`, static_stale: 1 })
      .where("id", "=", site.id)
      .where((eb) => (prev === null ? eb("active_version", "is", null) : eb("active_version", "=", prev)))
      // 7n(B48): 予約行がまだあるときだけ。0 行なら同じ batch の後ろの文(「この版が active」が guard)も何も書かない。次の読み直しで行の有無を見分ける
      .where((eb) => eb.exists(ownStatus.where("status", "=", "reserved")))
      .where(snapshotOk)
      .$if(!!transitionOk, (q) => q.where(transitionOk!));
    // D9 ③(K14): 届く定義の行は CAS と同じ batch(1 トランザクション)で、「この版が active」を条件に足す。
    // 行がある ⇔ この版を activation した(記録の取りこぼし・並行する Publish との順の入れ替わり・出し直しの待ちの間の確認で前の行に当たる、が起きない)。
    // 世代は出し直しの後に入れる(それまでは NULL)
    // B68(spec §3.1): 届く定義が使う画像の表も同じ batch・同じ条件で足す(画像の ID が無い定義は文を作らない)
    // B129: 公開の記録は CAS の後に、この要求の印(自分の版が active)を guard にして置く(CAS に負けた試みでは 0 行)
    const statements = [
      toStatement(env, cas),
      ...transitionStatements,
      ...deliveries.flatMap((d) => {
        const refs = assetDeliveredRefsInsert(db, site.id, d, guard);
        return [toStatement(env, deliveredDefinitionInsert(db, site.id, version, null, d, guard)), ...(refs ? [toStatement(env, refs)] : [])];
      }),
      publishAudit(env, actor, site, { version, superseded: false }, { guard, now: nowMs }),
      publishedStatusStatement(env, site.id, p.statusAfter, guard),
      collectionLogStatement(env, site.id, version, site.results_enabled === 1 ? 1 : 0, Date.now(), guard),
      interimCacheDeleteStatement(env, site.id, guard),
      ...(transition?.collectUntilDirty
        ? [toStatement(env, db.updateTable("sites").set({ collect_until_dirty: 1 }).where("id", "=", site.id).where(guard))]
        : []),
      publishActiveStatement(env, rowId, nowMs, guard),
    ];
    try {
      const [upd] = await env.DB.batch(statements);
      activated = (upd?.meta.changes ?? 0) > 0;
    } catch (e) {
      console.error("activation batch failed", site.id, version, e);
      // 旧版の修復でも履歴が active になる。CAS の直前より後にこの公開が残した成功の記録と突き合わせる。
      // 境界は audit_events_at の同じ公開時刻に限る。保持削除で古い行の ID が再利用されても、この境界は下がらない。
      const priorAuditId = cur.last_audit_id;
      try {
        const cur = await db.selectFrom("sites").select((eb) => [
          "active_version", taken(eb).as("taken"), ownStatus.as("own_status"),
          ownStatus.clearSelect().select("activated_at").as("own_activated_at"),
          sql<number>`exists (select 1 from audit_events where at = ${nowMs} and id > ${priorAuditId}
            and site_id = ${site.id} and action = 'publish.publish' and json_extract(detail_json, '$.version') = ${version}
            and json_extract(detail_json, '$.superseded') = 0 and json_extract(detail_json, '$.reason') is null)`.as("activation_recorded"),
        ]).where("id", "=", site.id).executeTakeFirst();
        if (cur?.own_status === "active" && cur.own_activated_at === nowMs && cur.activation_recorded) return { kind: "activated" };
        if (cur?.own_status === "reserved") return { kind: "not_activated_after_error" };
        if (cur?.own_status) return { kind: "reservation_expired" };
        recordMissing = true;
        versionTaken = Boolean(Number(cur?.taken));
        break;
      } catch (readError) {
        console.error("activation outcome read failed", site.id, version, readError);
        return { kind: "outcome_unknown" };
      }
    }
  }
  if (recordMissing) {
    // 7n(B48): 予約行が無い。activation していないので D1 の配信中の状態は変わっていない(公開の記録も書かない)。
    // recordFailure は当たる行が無いので呼ばない。KV の config は dropOrphanConfig の条件で消す
    await dropOrphanConfig(versionTaken);
    return { kind: "record_missing" };
  }
  if (!activated) {
    if (transition) return { kind: "superseded" }; // 遷移では成功の記録を残さず、呼び元で競合として記録する。
    // 追い越された(または CAS が競り負け続けた)。KV は触らず履歴だけ残す(次の Publish が最新を活性化する)
    // B129: 追い越しの文と同じ batch に記録(無条件。1 文の execute を 2 文の batch にした)
    // 7n レビュー: 最後の読み直しの後(CAS の直前)に予約行が消えていると UPDATE は 0 行。その記録は予約行があるときだけ書き(偽の superseded を残さない)、
    // 同じ batch で同じ版の番号の行の有無も読む(往復は増えない)。0 行なら予約行が無いときと同じ扱い
    const [marked, , takenRow] = await env.DB.batch<{ taken: number; own_status: string | null }>([
      toStatement(env, db.updateTable("publishes").set({ status: "superseded" }).where("id", "=", rowId).where("status", "=", "reserved")),
      publishAudit(env, actor, site, { version, superseded: true }, { guard: sql<SqlBool>`exists (select 1 from publishes where id = ${rowId} and status = 'superseded')`, now: nowMs }),
      toStatement(env, db.selectNoFrom((eb) => [eb.exists(eb.selectFrom("publishes").select("publishes.id").where("publishes.site_id", "=", site.id).where("publishes.version", "=", version)).as("taken"), ownStatus.as("own_status")])),
    ]);
    if ((marked?.meta.changes ?? 0) === 0) {
      const row = takenRow?.results[0];
      if (row?.own_status) return { kind: "reservation_expired" };
      await dropOrphanConfig(Boolean(Number(row?.taken)));
      return { kind: "record_missing" };
    }
    return { kind: "superseded" };
  }
  return { kind: "activated" };
}

/** D1 で有効にした版を KV の active や配信ファイルに反映し、公開の後処理を行う。 */
export async function finishPublish(env: Env, db: Db, p: PreparedPublish): Promise<Success> {
  const { site, nowMs, version, config, warnings } = p;

  // KV `active` の put(書く値は D1 最新版。review r2 CX-High-4)
  let written: number | undefined;
  let delayed = false;
  try {
    written = await putActiveLatest(env, db, site.id);
    // D1 が先へ進んでいたら修復を残す。並行する古い put が後着した場合も KV を照合して拾う。
    const marked = await markActiveVersion(env, db, site.id, written);
    if (marked?.active_kv_stale === 0) {
      if (await env.CONFIG_KV.get(kvKeys.active(site.id)) !== String(written)) {
        delayed = true;
        await markActiveVersion(env, db, site.id, null);
      }
    } else {
      delayed = true;
    }
  } catch (e) {
    delayed = true;
    console.error("publish active pointer update failed", site.id, version, e);
    // put 成功後の D1 の更新・KV の照合で失敗したら、並行する公開が降ろした印も立て直す。
    // put 自体の成否不明は putActiveLatest が処理する。
    if (written !== undefined) {
      try {
        await markActiveVersion(env, db, site.id, null);
      } catch (markError) {
        console.error("publish active repair marker update failed", site.id, version, markError);
      }
    }
  }

  if (p.transition?.afterActivePut) {
    try {
      await p.transition.afterActivePut();
    } catch (e) {
      delayed = true;
      console.error("collect-until rewrite after activation failed", site.id, version, e);
    }
  }

  // KV に書いた版を守る。put に失敗したときは D1 の最新版を読み直して守る。
  // cleanup 側はそれに加えて KV の `active` レコードそのものも読んで守る。
  // ここから下はハウスキーピング(容量最適化であって正しさの前提ではない)。activation は既に成功しているので、
  // cleanup が D1 / KV でこけても publishSite 自体は throw しない(Task 7: status 変更が成功した応答が 500 に化けない)
  try {
    const keepVersion = written ?? (await db.selectFrom("sites").select("active_version").where("id", "=", site.id).executeTakeFirst())?.active_version;
    if (keepVersion != null) {
      const cleanup = await cleanupOldVersions(env, db, site.id, keepVersion, nowMs);
      if (cleanup.failed) delayed = true;
    }
  } catch (e) {
    delayed = true;
    console.error("cleanupOldVersions failed (best-effort, will retry next publish)", e);
  }
  // 決定 52 / spec §13.6 手順 6: 配信ファイルの出し直し。activation は済んでいるので、失敗しても Publish は成功(plan K4)
  const outcome = await requestStaticDeploy(env, db, site.id);
  // staticGeneration は内部用(D9 が Publish の行と配った世代を結びつける)。応答には publicPublishResult で外して出す。
  // 出し直しは最新の D1 から入力を作るので、activation の後により新しい Publish が activation していると、その世代には別の版が焼かれる。
  // 自分の版を焼いた世代のときだけ返し、違えば null(より新しい Publish に追い越された。D9 はこの行を配信済みにしない)
  const staticGeneration = outcome.version === version ? outcome.generation : null;
  const deliveryRecorded = await recordDelivery(env, db, site.id, version, staticGeneration, outcome);
  return {
    ok: true, version, needsProfile: config.needsProfile, superseded: false, staticDeploy: outcome.state, staticGeneration,
    warnings: delayed || outcome.failed || !deliveryRecorded ? [...warnings, DELIVERY_DELAY_WARNING] : warnings,
  };
}

/**
 * D9 ③(設計書 §5.5、plan ③ の K14): activation の batch で足した届く定義の行に、この版を焼いた出し直しの世代を入れ、
 * その世代そのもの(中身も同じ)を配り終えていれば、その 1 点で配信を確かめる(partial: ほかの行は確定しない)。
 * 依頼を送っていない(outcome.digest が null = 依頼の記録を書けなかった・binding が無い・削除の依頼)なら世代も書かない
 * (7o K24 (5): 送っていない世代が行に入ると、依頼の記録の無い世代を行の世代で補う道で古い履歴に引かれる。これで更新の後は
 * 「行に世代がある ⇒ 依頼の記録がある」になる)。1 点には送った入力の digest を付ける(依頼の記録の digest と組み合うときだけ数える)。
 * activation は済んでいるので、失敗しても Publish は成功のまま(行は残る。世代が NULL のままでも、その版を焼いた世代は依頼の記録から引ける)
 */
async function recordDelivery(env: Env, db: Db, siteId: string, version: number, generation: StaticGeneration | null, outcome: StaticDeployOutcome): Promise<boolean> {
  if (generation === null || outcome.digest === null) return true;
  try {
    await setDeliveredGeneration(db, siteId, version, generation);
    if (outcome.state === "deployed" && outcome.deployedAt !== null)
      await confirmDeliveries(
        db,
        siteId,
        { history: [{ generation, deployedAt: outcome.deployedAt, digest: outcome.digest }], historyFrom: null, partial: true },
        Date.now(),
        apiGuard(env),
      );
    return true;
  } catch (e) {
    console.error("delivered definition update failed (best-effort, confirmed later by cron)", e);
    return false;
  }
}

/** 応答に出さない内部用の値(staticGeneration)を外す。OpenAPI の PublishResultSchema には載せない */
export function publicPublishResult(r: PublishResult): PublishResult {
  if (!r.ok) return r;
  const { staticGeneration: _internal, ...rest } = r;
  return rest;
}

/**
 * spec §9.4: 切り替えに必要な版 = KV の active の版・呼び出し元が指定した版・RECENT_ACTIVE_MS 以内に active だった版・配信ファイルが配る版(以上)だけを残し、
 * それ以外の config キーを削除する(plan12 K14 (b): 「直近 N 版」の保持はやめた)。公開のとき(publishSite)と、control の Cron `config-cleanup` から呼ぶ。
 *
 * 配信ファイル(静的アセット)が配っている版も残す(① 不明なら何も消さない ② その版以上 ③ 切り替えの直後 5 分は前の版。決定 52 / plan K20)。
 *
 * 「active 版」の正本は **KV の `active` レコード**(= edge が実際に読む値)であって、D1 の記帳ではない。
 * put が失敗した後は、D1 が指す版とは別の版を配信していることがある。
 * そのため KV を読んでその版を必ず残し、KV が読めなければ 1 件も消さない(fail-closed)
 */
export type CleanupResult = { queries: number; keep: number[] | null; deleted: number; kvActive: string | null | undefined; failed?: true };

export async function cleanupOldVersions(env: Env, db: Db, siteId: string, writtenVersion: number, nowMs: number, beforeDelete?: () => Promise<void>): Promise<CleanupResult> {
  // 戻り値 = 出した D1 のクエリの数(KV は数えない)。Cron が 1 回の実行の D1 の予算を数えるのに使う
  let queries = 0;
  let kvActive: string | null;
  try {
    kvActive = await env.CONFIG_KV.get(kvKeys.active(siteId));
  } catch (e) {
    console.error("cleanup active pointer read failed", siteId, e);
    return { queries, kvActive: undefined, keep: null, deleted: 0, failed: true }; // KV が読めない = いま何が配信されているか分からない。何も消さない
  }
  const served = kvActive === null ? null : Number(kvActive);
  if (served !== null && !Number.isInteger(served)) return { queries, kvActive, keep: null, deleted: 0 }; // 壊れた active レコード。同上
  // 決定 52 / plan K20: 配信ファイル(静的アセット)が配っている版。配信ファイルの更新が遅れている間も、
  // 古い bootstrap が decision でその版を求めるので、その版の config を残す
  queries++;
  const st = await db
    .selectFrom("sites")
    .select(["static_served_version", "static_prev_served_version", "static_served_at"])
    .where("id", "=", siteId)
    .executeTakeFirst();
  // ① 配っている版がまだ分からない(確かめた出し直しが無い)なら何も消さない
  if (!st || st.static_served_version === null) return { queries, kvActive, keep: null, deleted: 0 };
  queries++;
  const rows = await db
    .selectFrom("publishes")
    .select(["id", "version", "status", "activated_at", "kv_deleted"])
    .where("site_id", "=", siteId)
    .where("kv_deleted", "=", sql.lit(0))
    .where("config_hash", "is not", null)
    .orderBy("version", "desc")
    .execute();
  const keep = new Set<number>([writtenVersion]);
  if (served !== null) keep.add(served);
  // ② 確かめ済みの配っている版以上はすべて残す(配る版は前にしか進まない。control が確かめた後に alarm で成功した版も、確かめ済みの版以上にある)
  for (const r of rows) if (r.version >= st.static_served_version) keep.add(r.version);
  // ③ 切り替えから RECENT_ACTIVE_MS の間は、前に配っていた版も残す(切り替えの直後、ブラウザに最大 60 秒残る前の bootstrap が decision でその版を求める)
  if (st.static_prev_served_version !== null && st.static_served_at !== null && nowMs - st.static_served_at < RECENT_ACTIVE_MS) keep.add(st.static_prev_served_version);
  for (const r of rows) if (r.activated_at !== null && nowMs - r.activated_at < RECENT_ACTIVE_MS) keep.add(r.version);
  const doomed = rows.filter((r) => !keep.has(r.version));
  if (doomed.length === 0) return { queries, kvActive, keep: [...keep].sort((a, b) => a - b), deleted: 0 };
  // 消す(KV を書く)直前の確かめ。Cron は凍結の確かめをここに渡す(公開の途中の掃除は渡さない)。凍結中は投げて何も消さない
  if (beforeDelete) {
    queries++; // 確かめの読み取り 1 件
    await beforeDelete();
  }
  // 7n(G04 (b)): 印を付けるのは KV の削除が成功した版だけ。失敗した版は kv_deleted = 0 のまま残し、次の掃除で消し直す
  const deleted: typeof doomed = [];
  for (const r of doomed) {
    try {
      await env.CONFIG_KV.delete(kvKeys.config(siteId, r.version));
      deleted.push(r);
    } catch (e) {
      console.error("config kv delete failed (retried by the next cleanup)", siteId, r.version, e);
    }
  }
  // 消した印は D1 の 1 文にまとめる(Cron の D1 の予算を版の数に比例させない)。D1 のバインド変数の上限に収まるよう CHUNK ずつ。
  // KV の削除より後に印を付けるので、途中で止まっても印の無い版は次の掃除でもう一度消される(冪等)
  for (let i = 0; i < deleted.length; i += MARK_CHUNK) {
    queries++;
    // wtt-control への書き込みなので、凍結の印が無いことを条件に入れる(確かめと書き込みの間に凍結が入っても書かない。0 行 = 次の掃除がやり直す)
    await db
      .updateTable("publishes")
      .set({ kv_deleted: 1 })
      .where("id", "in", deleted.slice(i, i + MARK_CHUNK).map((r) => r.id))
      .where(sql<boolean>`${sql.raw(NOT_FROZEN_SQL)}`)
      .execute();
  }
  return { queries, kvActive, keep: [...keep].sort((a, b) => a - b), deleted: deleted.length, ...(deleted.length < doomed.length ? { failed: true } : {}) };
}

/**
 * spec §13.10: **D1 に記録された active な公開 config**(`sites.active_version` の `publishes.config_json`)を取り出す(決定 39 (7))。
 * Publish は同じ compile 出力を KV `config:v<N>` と D1 `publishes.config_json` の両方に書く(§13.6 手順 3・4)ので、
 * 読取系の口(evaluate)はこちらを読めば KV / edge キャッシュに一切触れずに済む。
 * ただし **KV の active や bootstrap の 60 秒キャッシュとはずれ得る**(KV active の put が落ちた直後など)ので、
 * 「いま edge が配っているもの」と同一視しない — 応答は評価した版を `version` で明示する
 */
export async function loadActiveConfig(db: Db, site: SiteRow): Promise<CompiledConfig | null> {
  if (site.active_version === null) return null;
  const row = await db
    .selectFrom("publishes")
    .select("config_json")
    .where("site_id", "=", site.id)
    .where("version", "=", site.active_version)
    .executeTakeFirst();
  if (!row?.config_json) return null;
  try {
    return parseCompiledConfig(JSON.parse(row.config_json));
  } catch {
    return null;
  }
}
