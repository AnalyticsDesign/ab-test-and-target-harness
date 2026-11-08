import { expressionBuilder, sql, type ExpressionBuilder, type RawBuilder, type SqlBool } from "kysely";
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
import { ASSET_GUARD_HINTS } from "./errors";
import { toStatement, type Db, type ExperimentRow, type SiteRow, type Tables } from "./db";
import type { Env } from "./env";
import { orderForCompile, overlapWarnings } from "./experiment-order";
import { newId } from "./ids";
import { siteToSettings } from "./site-settings";
import { NOT_FROZEN_SQL } from "./write-freeze";
import { assetDeliveredRefsInsert, confirmDeliveries, deliveredDefinitionInsert, deliveredDefinitionsFor, plansForDelivery, prepareDeliveredDefinitions, setDeliveredGeneration, type PreparedDelivery } from "./results/delivered";
import { apiGuard } from "./results/guard";
import { requestStaticDeploy, type StaticDeployOutcome, type StaticDeployState } from "./static-delivery";

export const RECENT_ACTIVE_MS = 5 * 60_000; // spec §9.4: 5 分以内に active だった版
const MARK_CHUNK = 50; // kv_deleted の印を 1 文で付ける版の数の上限(D1 のバインド変数は 1 文 100 個まで)

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

export async function buildCompileInput(
  db: Db,
  site: SiteRow,
  version: number,
  experiments?: ExperimentRow[],
  scope: CompileInputScope = {},
): Promise<StoredCompileInput> {
  const statuses = scope.statuses ?? (["running"] as const);
  const all = experiments ?? (await db.selectFrom("experiments").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute());
  // 決定 51(設計書 §3.2・§9.3): 並べる順 = 優先の順。compile は入力の順を保つ
  const exps = orderForCompile(all.filter((e) => statuses.includes(e.status) && (!scope.experimentIds || scope.experimentIds.includes(e.id))));
  const variants = await db.selectFrom("variants").selectAll().where("site_id", "=", site.id).orderBy("position").execute();
  const changes = await db.selectFrom("changes").selectAll().where("site_id", "=", site.id).orderBy("position").execute();
  const goals = await db.selectFrom("goals").selectAll().where("site_id", "=", site.id).execute();
  const audiences = await db.selectFrom("audiences").select(["id", "definition_json"]).where("site_id", "=", site.id).execute();
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
 * 同一キー 1 秒 1 回の制限があるので、失敗は 1.1 秒待って 1 回だけ再試行する。戻り値は実際に書いた版
 */
export const ACTIVE_PUT_RETRY_MS = 1100;
async function putActiveLatest(env: Env, db: Db, siteId: string): Promise<number> {
  // `active_version` が null(= まだ一度も activation していない / 並行 rollback で戻された)なら **何も書かない**。
  // 0 に丸めると KV に `config:v0` を指す実在しないポインタを書くことになる(edge は fail-closed だが、
  // 分かっていて壊れた値を書くことはしない)。呼び出し側は失敗として扱い、stale を立てて次の機会に再同期する
  const read = async (): Promise<number> => {
    const v = (await db.selectFrom("sites").select("active_version").where("id", "=", siteId).executeTakeFirstOrThrow()).active_version;
    if (v === null) throw new Error("active_version is null; refusing to write a dangling kv active pointer");
    return v;
  };
  let v = await read();
  try {
    await env.CONFIG_KV.put(kvKeys.active(siteId), String(v));
    return v;
  } catch (first) {
    await new Promise((r) => setTimeout(r, ACTIVE_PUT_RETRY_MS));
    v = await read(); // 待っている間に進んでいれば最新版を書く
    try {
      await env.CONFIG_KV.put(kvKeys.active(siteId), String(v));
      return v;
    } catch {
      throw first;
    }
  }
}

/**
 * `active_kv_stale = 1` の Site の KV active を D1 最新版に揃える。
 * 呼び出し元は `publishSite` の冒頭と、`GET /sites/:sid`(Task 8。読み取りのたびに自己修復を試みる)の 2 箇所。
 * **絶対に throw しない**(GET は最頻の読み取りエンドポイントで、reconcile はあくまでベストエフォートの自己修復)。
 * 状態の読み取り(旧: ここだけ try の外にあった)から put・更新まで丸ごと 1 つの try で囲む。
 * 戻り値は「呼び出し後に整合している(= stale ではない)か」。呼び出し元(GET /sites/:sid)がこれを使って、
 * 直った瞬間のレスポンスが読み込み時点の古い `active_kv_stale` を返して自己矛盾しないようにする(review r1 finding 2)
 */
export async function reconcileActive(env: Env, db: Db, siteId: string): Promise<boolean> {
  try {
    const row = await db.selectFrom("sites").select(["active_kv_stale", "active_version"]).where("id", "=", siteId).executeTakeFirstOrThrow();
    if (row.active_kv_stale !== 1 || row.active_version === null) return true; // そもそも stale ではない
    const written = await putActiveLatest(env, db, siteId);
    // 旗を下ろすのは「自分が KV に書いた版がいまも D1 の最新」のときだけ(put の最中に D1 が進んでいたら stale のまま次の機会に回す)
    const upd = await db.updateTable("sites").set({ active_kv_stale: 0 }).where("id", "=", siteId).where("active_version", "=", written).executeTakeFirst();
    return Number(upd.numUpdatedRows) > 0;
  } catch {
    return false; // 次の機会に再試行(stale のまま)
  }
}

/**
 * `markFailed` が残す `"<code>: <生テキスト>"` からコード部分だけを取り出す(Plan 10 B1)。
 * `publishes.error` は制約の無い TEXT 列で形式の保証が無いため、区切りが無い・コードの形(英小文字・数字・_)でない行は
 * 固定の `publish_failed` に閉じる(fail-closed。r1 CX-Medium-1 / r2 CX-Medium-1: 区切りが無ければ内容にかかわらず閉じる)
 */
const PUBLISH_ERROR_CODE_RE = /^[a-z][a-z0-9_]*$/;
export function publishErrorCode(stored: string): string {
  const i = stored.indexOf(": ");
  if (i <= 0) return "publish_failed"; // 区切りが無い・先頭にある = markFailed の形ではない(r2 CX-Medium-1: `timeout` のような英小文字列を生のまま返さない)
  const code = stored.slice(0, i);
  return PUBLISH_ERROR_CODE_RE.test(code) ? code : "publish_failed";
}

async function markFailed(db: Db, rowId: string, code: string, message: string, kvDeleted = false): Promise<void> {
  await db
    .updateTable("publishes")
    .set({ status: "failed", error: `${code}: ${message}`.slice(0, 2000), ...(kvDeleted ? { kv_deleted: 1 } : {}) })
    .where("id", "=", rowId)
    .execute();
}

/**
 * 失敗結果の利用者向け文言(日本語)。`PublishResult.message` は 200 応答の結果本体で封筒ではないため `ApiError` の
 * 既定文が届かず、かつては生の例外文字列(`String(e)`)や core の英語診断文をそのまま UI に出していた(rulings §4 最終レビュー)。
 * 生のテキストは `markFailed` で `publishes.error` に残し、ここでサーバーログにも出す
 */
const RETRY_HINT = "数秒後にもう一度公開してください";
const FAILURE_MESSAGES: Record<string, { message: string; hint?: string }> = {
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
  kv_rate_limited: { message: "KV への active の書き込みが制限されました", hint: RETRY_HINT },
  // 7n(B48): activation の直前に、この公開の予約行が無くなっていた(D1 を以前の時点に戻した後など)。この版は有効にしていない
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

function failure(code: string, version: number | null, raw: string, assetProblems?: AssetProblem[]): PublishResult {
  console.error(`publish failed (${code})`, raw);
  const { message, hint } = describeCompileFailure(code, raw);
  return { ok: false, version, error: code, message, ...(hint ? { hint } : {}), ...(assetProblems ? { assetProblems } : {}) };
}

/**
 * B129(spec §3.1 の publish.publish・§5.2): 公開の記録。activation の CAS の batch(後。この要求の印 = 自分の版が active)、
 * 追い越しの文(後。無条件)、KV の失敗で D1 を戻す batch(前。戻す文と同じ条件)に 1 文ずつ置く(往復は増えない)。
 * CAS より前の失敗(版の予約・compile・config の put・読み戻し)では D1 の配信中の状態は変わらないので記録しない。
 * actor = 公開した人(published_by は actor.userId)。状態の変更の後の自動の公開も、状態を変えた人
 */
function publishAudit(env: Env, actor: UserActor, site: SiteRow, detail: AuditDetail, opts: AuditStatementOpts & { targetFrom?: RawBuilder<unknown> } = {}): D1PreparedStatement {
  const { targetFrom, ...rest } = opts;
  const target = targetFrom ? { target: { type: "site" as const }, targetFrom } : { target: { type: "site" as const, id: site.id, label: site.name } };
  return auditStatement(env.DB, actor, { action: "publish.publish", workspaceId: site.workspace_id, siteId: site.id, detail, ...target }, rest);
}

/**
 * spec §13.6 の Publish。手順 1〜6 を 1 関数で行い、activation 前の失敗は旧 version を active のまま残す。
 * nowMs は cleanup の時刻判定(テストで注入)。KV / D1 の呼び出しはここに閉じる(compile は core の純関数)。
 * actor = 公開した人(B129: published_by は actor.userId。公開の記録 publish.publish の操作した人)。
 * B68(spec §22.2): compile の後に画像の参照を取り出し(D1・DO を読まない)、設定の記録(手順 4)を KV の put の前に出して、
 * 「取り出した画像がすべて印の無い行としてある」を条件にした 1 文にする。`opts.skipAssetGuard` は状態を変える口の止める操作
 * (一時停止・終了)だけが渡す(Q266): 取り出しを飛ばし、同じ文に空の ID の並びを渡す(条件は常に真)
 */
export async function publishSite(env: Env, db: Db, site: SiteRow, actor: UserActor, nowMs = Date.now(), opts: { skipAssetGuard?: boolean } = {}): Promise<PublishResult> {
  const userId = actor.userId;
  await reconcileActive(env, db, site.id);
  // 手順 2: version を予約(UNIQUE(site_id, version) で競合を検出して取り直す)
  let version: number | null = null;
  let rowId = "";
  for (let attempt = 0; attempt < 5 && version === null; attempt++) {
    rowId = newId("pub");
    try {
      const r = await sql<{ version: number }>`
        insert into publishes (id, site_id, version, status, published_by, created_at)
        select ${rowId}, ${site.id}, coalesce(max(version), 0) + 1, 'reserved', ${userId}, ${nowMs} from publishes where site_id = ${site.id}
        returning version`.execute(db);
      version = r.rows[0]?.version ?? null;
    } catch (e) {
      if (!/UNIQUE/i.test(String(e))) throw e;
    }
  }
  if (version === null) return failure("version_reservation_failed", null, "could not reserve a version after 5 attempts");

  // 手順 1 + 3: compile(参照エラー / サイズ超過は CompileError)
  let config: CompiledConfig;
  let warnings: AnalyticsWarning[];
  // spec §13.8: この publish が「これから activate する」status の写し(compile と同じ瞬間に近いタイミングで読む)。
  // 手順 6 の published_status 更新はここで撮った値を使う — activation(KV 往復・CAS リトライを含み得る)の**後**に
  // status を live で再読みすると、その間に別の status 変更が割り込んで「配信中の config には無い状態」を
  // published_status に書いてしまう(review r1 Task 7 の指摘。site-delete guard が published_status を見るので実害がある)
  let statusSnapshot: Array<Pick<ExperimentRow, "id" | "status">>;
  // D9 ③(K14): 届く定義は compile に渡したのと同じ入力・同じ行から作り、activation の CAS と同じ batch で記録する
  let deliveries: PreparedDelivery[];
  let input: StoredCompileInput;
  try {
    // 写しと compile 入力は**同じ 1 回の SELECT** から取る(別々に読むと間に割り込んだ status 変更で食い違う。rulings §4 CX-High-3)
    const experiments = await db.selectFrom("experiments").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute();
    statusSnapshot = experiments.map((e) => ({ id: e.id, status: e.status }));
    input = await buildCompileInput(db, site, version, experiments);
    // D9 ②(K15): results は Publish の経路だけで足す(写しと同じ SELECT の行から作る)。③ K6: 削除待ちの個票があれば forget を出し続ける
    const results = resultsForCompile(site, experiments, await hasPendingPurge(db, site.id));
    config = compile(results ? { ...input, results } : input);
    // 届く定義は compile が通った後に作る(同じ input・同じ行のまま)。展開の上限(B159)より前にオーディエンスを展開した全ノードを
    // JSON 化・hash しない。compile は input を書き換えないので、前に作っていたときと記録は同じ
    deliveries = await prepareDeliveredDefinitions(deliveredDefinitionsFor(input, experiments, await plansForDelivery(db, site.id)), experiments);
    // §10.9: compile は警告に留める。拒否は保存 API(`assertName`)側
    warnings = analyticsWarnings(config);
    // 決定 51(設計書 §3.3): 同じ対象 URL・同じセレクタを変える組。拒否はしない(どちらが優先されるかを文に入れる)
    for (const { path, message } of overlapWarnings(input.experiments)) warnings.push({ path, message });
    // 決定 50: 焼いた bootstrap(runtime + config + Identity 設定)が新しい接続の最初の往復に収まらない大きさなら警告(拒否はしない)
    const bootstrapBytes = await gzipSize(bakeBootstrap(config, siteToSettings(site), RUNTIME_SOURCE, { apiBase: edgeOrigin(env), runtimeHash: RUNTIME_HASH }));
    const budget = BOOTSTRAP_LIMITS.totalBytes - BOOTSTRAP_LIMITS.headerAllowance;
    if (bootstrapBytes > budget)
      warnings.push({
        path: "bootstrap",
        message: `配信するタグが大きく(gzip ${bootstrapBytes} バイト、目安 ${budget} バイト)、初めて訪れたときの読み込みで通信の往復が 1 回増えることがあります。配信中のエクスペリエンスや変更を減らすと小さくなります`,
      });
  } catch (e) {
    const code = e instanceof CompileError ? e.code : "compile_failed";
    const message = e instanceof Error ? e.message : String(e);
    await markFailed(db, rowId, code, message);
    return failure(code, version, message);
  }

  const key = kvKeys.config(site.id, version);
  const body = JSON.stringify(config);
  const hash = await sha256Hex(body);
  // B68 手順 3(spec §22.2): 画像の参照の取り出し。別のサイトの URL は D1 を読まずに失敗にする(KV にはまだ何も置いていない)
  let assetIds: string[] = [];
  if (!opts.skipAssetGuard) {
    const g = await guardAssets(env, db, site, input, body, { readD1: false });
    if (!g.ok) {
      await markFailed(db, rowId, g.error, g.assetProblems.map((p) => p.url).join(" "));
      return failure(g.error, version, g.assetProblems.map((p) => p.url).join(" "), g.assetProblems);
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
    // 失敗のときだけ D1 をもう 1 回読んで、無い画像を決める(KV に何も置いていないので後始末は無い)
    const g = await guardAssets(env, db, site, input, body, { readD1: true });
    const problems = g.ok ? [] : g.assetProblems;
    const raw = problems.length > 0 ? problems.map((p) => p.url).join(" ") : `asset ids missing: ${assetIds.join(" ")}`;
    await markFailed(db, rowId, "asset_missing", raw);
    return failure("asset_missing", version, raw, problems);
  }
  // 手順 3(KV): 予約した N に 1 回だけ put(immutable)。失敗した版の行には config_hash があるので、cleanupOldVersions が後でキーを
  // 消して kv_deleted = 1 にする(無いキーの delete も成功する)。それまでは Cron の「訪問者に届きうる版」に入り、その画像は消えない
  try {
    await env.CONFIG_KV.put(key, body);
  } catch (e) {
    await markFailed(db, rowId, "kv_put_failed", String(e));
    return failure("kv_put_failed", version, String(e));
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
    await markFailed(db, rowId, "kv_verify_failed", "config read-back missing or hash mismatch", true);
    return failure("kv_verify_failed", version, "config read-back missing or hash mismatch");
  }
  /**
   * activation の調停(spec §13.6「自分より小さいときだけ進める」条件付き更新)。
   * 直前に読んだ prev と一致するときだけ進める CAS で、外れたら読み直して再試行する。**読み直しは必須**:
   * 並行 Publish は全員が同じ `active_version` を読んでから順に更新するので、1 回きりの CAS では
   * 最初の 1 本しか activation できず、いちばん新しい version が superseded になって**古い config が配信され続ける**
   * (この形は実測で `concurrent_publish_has_monotonic_versions` が active=1 になり落ちる)。
   * prev が自分以上になったら本当に追い越されたので superseded。rollback 先は CAS に成功したときの prev に固定するので、
   * request 開始後に活性化された中間版を下回らない(review r1 CX-High-4)
   */
  const CAS_ATTEMPTS = 5;
  let prev: number | null = null;
  let prevActivatedAt: number | null = null;
  let activated = false;
  let recordMissing = false;
  // 7n レビュー: 同じ版の番号の行が(rowId を問わず)あるか。D1 を戻した後に別の公開が同じ版を取り直していれば、KV の config/v<N> はその行のもの
  let versionTaken = false;
  // 7n(B48): この公開の予約行(publishes の rowId の行)がまだあること。D1 を Time Travel で戻した後に、戻す前から続いていた公開などで
  // 行が消えていたら、公開の履歴に無い版を active にしない。CAS の条件と、読み直しの列の両方に使う(読み直しの SELECT の中の副問い合わせなので往復は増えない)
  const reserved = (eb: ExpressionBuilder<Tables, "sites">) =>
    eb.exists(eb.selectFrom("publishes").select("publishes.id").where("publishes.id", "=", rowId).where("publishes.site_id", "=", site.id).where("publishes.version", "=", version));
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
  const recordMissingFailure = () => failure("publish_record_missing", version, `publish record ${rowId} (version ${version}) is gone before activation`);
  for (let attempt = 0; attempt < CAS_ATTEMPTS && !activated; attempt++) {
    const cur = await db
      .selectFrom("sites")
      .select((eb) => ["active_version", "last_activated_at", reserved(eb).as("reserved"), taken(eb).as("taken")])
      .where("id", "=", site.id)
      .executeTakeFirstOrThrow();
    prev = cur.active_version;
    prevActivatedAt = cur.last_activated_at;
    // 予約行が無い = 追い越しではない(superseded の UPDATE は当たる行が無い)。下で KV の config を消して失敗にする
    if (!Number(cur.reserved)) {
      recordMissing = true;
      versionTaken = Boolean(Number(cur.taken));
      break;
    }
    if (prev !== null && prev >= version) break; // 自分より新しい version が先に active になった
    const cas = db
      .updateTable("sites")
      // 決定 52 / plan K4: 配信ファイルの印は activation と同じ文で立てる。出し直しの依頼の前に処理が止まっても印が残り、
      // GET の自己修復が拾う。activation で seq を進めるので、それより前の依頼の結果が印を下ろさない
      .set({ active_version: version, last_activated_at: nowMs, static_seq: sql<number>`static_seq + 1`, static_stale: 1 })
      .where("id", "=", site.id)
      .where((eb) => (prev === null ? eb("active_version", "is", null) : eb("active_version", "=", prev)))
      // 7n(B48): 予約行がまだあるときだけ。0 行なら同じ batch の後ろの文(「この版が active」が guard)も何も書かない。次の読み直しで行の有無を見分ける
      .where(reserved);
    // D9 ③(K14): 届く定義の行は CAS と同じ batch(1 トランザクション)で、「この版が active」を条件に足す。
    // 行がある ⇔ この版を activation した(記録の取りこぼし・並行する Publish との順の入れ替わり・出し直しの待ちの間の確認で前の行に当たる、が起きない)。
    // 世代は出し直しの後に入れる(それまでは NULL)
    // B68(spec §3.1): 届く定義が使う画像の表も同じ batch・同じ条件で足す(画像の ID が無い定義は文を作らない)
    // B129: 公開の記録は CAS の後に、この要求の印(自分の版が active)を guard にして置く(CAS に負けた試みでは 0 行)
    const [upd] = await env.DB.batch([
      toStatement(env, cas),
      ...deliveries.flatMap((d) => {
        const refs = assetDeliveredRefsInsert(db, site.id, version, d, true);
        return [toStatement(env, deliveredDefinitionInsert(db, site.id, version, null, d, true)), ...(refs ? [toStatement(env, refs)] : [])];
      }),
      publishAudit(env, actor, site, { version, superseded: false }, { guard: sql<SqlBool>`(select active_version from sites where id = ${site.id}) = ${version}`, now: nowMs }),
    ]);
    activated = (upd?.meta.changes ?? 0) > 0;
  }
  if (recordMissing) {
    // 7n(B48): 予約行が無い。activation していないので D1 の配信中の状態は変わっていない(公開の記録も書かない)。
    // markFailed は当たる行が無いので呼ばない。KV の config は dropOrphanConfig の条件で消す
    await dropOrphanConfig(versionTaken);
    return recordMissingFailure();
  }
  if (!activated) {
    // 追い越された(または CAS が競り負け続けた)。KV は触らず履歴だけ残す(次の Publish が最新を活性化する)
    // B129: 追い越しの文と同じ batch に記録(無条件。1 文の execute を 2 文の batch にした)
    // 7n レビュー: 最後の読み直しの後(CAS の直前)に予約行が消えていると UPDATE は 0 行。その記録は予約行があるときだけ書き(偽の superseded を残さない)、
    // 同じ batch で同じ版の番号の行の有無も読む(往復は増えない)。0 行なら予約行が無いときと同じ扱い
    const [marked, , takenRow] = await env.DB.batch([
      toStatement(env, db.updateTable("publishes").set({ status: "superseded" }).where("id", "=", rowId)),
      publishAudit(env, actor, site, { version, superseded: true }, { guard: sql<SqlBool>`exists (select 1 from publishes where id = ${rowId})`, now: nowMs }),
      toStatement(env, db.selectNoFrom((eb) => eb.exists(eb.selectFrom("publishes").select("publishes.id").where("publishes.site_id", "=", site.id).where("publishes.version", "=", version)).as("taken"))),
    ]);
    if ((marked?.meta.changes ?? 0) === 0) {
      await dropOrphanConfig(Boolean(Number((takenRow?.results?.[0] as { taken?: unknown } | undefined)?.taken)));
      return recordMissingFailure();
    }
    return { ok: true, version, needsProfile: config.needsProfile, superseded: true, staticDeploy: "skipped", warnings };
  }
  // KV `active` の put(書く値は D1 最新版。review r2 CX-High-4)
  let written: number;
  try {
    written = await putActiveLatest(env, db, site.id);
  } catch (e) {
    // 成否不明(put は通ったが throw した可能性)なので stale を立て、D1 は prev に戻す(まだ自分の版のときだけ)。
    // B129: 戻す文の前に、戻す文と同じ条件(stillMine)で戻しの記録(`reason: "reverted"`。CAS の記録は消せないため)
    const stillMine = (eb: ExpressionBuilder<Tables, "sites">) => eb.and([eb("id", "=", site.id), eb("active_version", "=", version)]);
    await env.DB.batch([
      publishAudit(env, actor, site, { version, reason: "reverted" }, { targetFrom: sql`select id as target_id, name as target_label from sites where ${stillMine(expressionBuilder<Tables, "sites">())}` }),
      toStatement(env, db.updateTable("sites").set({ active_version: prev, last_activated_at: prevActivatedAt, active_kv_stale: 1 }).where(stillMine)),
    ]);
    await markFailed(db, rowId, "kv_rate_limited", String(e));
    return failure("kv_rate_limited", version, String(e));
  }
  // 自己修復: 書いた後に D1 がさらに進んでいたら stale を立てる(次回 Publish の冒頭、または次の GET /sites/:sid の
  // reconcile で最新版を再 put。Task 8 で両方に配線済み)。失敗を黙って捨てない。
  // 「読んで比べて書く」ではなく 1 文の条件式にして、比較と更新の間に別の activation が挟まる窓を無くす(rulings §4 CX-High-3)
  const marked = await db
    .updateTable("sites")
    .set({ active_kv_stale: sql<number>`case when active_version = ${written} then 0 else 1 end` })
    .where("id", "=", site.id)
    .returning("active_version")
    .executeTakeFirst();
  // 7n(G04 (d)): 「食い違いなし」の印を付けたときは、KV の active を読み直して D1 と比べる。並行する公開の古い版の put が自分の put の後に
  // 着いていると、印は 0 なのに KV は古い版のまま止まる(GET の自己修復は stale = 1 のときだけ動く)。違う・読めないときは stale = 1 にして
  // 自己修復に任せる。D1 の値は印の UPDATE の returning から取る(往復を増やさない)。増えるのは KV の get 1 回(食い違いのときだけ D1 の書き込み 1 回)
  if (marked && marked.active_version !== null && marked.active_version === written) {
    let kvActive: string | null;
    try {
      kvActive = await env.CONFIG_KV.get(kvKeys.active(site.id));
    } catch {
      kvActive = null;
    }
    if (kvActive !== String(marked.active_version)) await db.updateTable("sites").set({ active_kv_stale: 1 }).where("id", "=", site.id).execute();
  }

  await db.updateTable("publishes").set({ status: "active", activated_at: nowMs }).where("id", "=", rowId).execute();
  // published_status を Desired Status に追いつかせる(spec §13.8)。ここで live の status 列を再読みしない —
  // `statusSnapshot`(compile と同じ SELECT から撮った写し)の値だけを書く。新しい Experiment がこの手前で
  // 作られていても対象外になる(compile されていないので当然 published_status も動かさない)。
  // **fence**: 「自分の version がまだ active」であるときだけ書く(1 文の条件付き update)。activation 後に別の Publish が
  // 新しい版を activate していたら、その Publish が写した状態を古い写しで上書きしないよう何も書かない(rulings §4 CX-High-3)。
  // 行ごとの update なので対象が多い Site では複数回の D1 呼出しになるが、`cleanupOldVersions` の削除ループも同じ形(逐次 execute)
  const stillActive = (eb: ExpressionBuilder<Tables, "experiments">) =>
    eb.exists(eb.selectFrom("sites").select("sites.id").where("sites.id", "=", site.id).where("sites.active_version", "=", version));
  for (const row of statusSnapshot) {
    await db.updateTable("experiments").set({ published_status: row.status }).where("site_id", "=", site.id).where("id", "=", row.id).where(stillActive).execute();
  }
  // D9 ②(設計書 §6.6・§9.3): 公開した収集の状態(結果を記録する Site か = results.runs にテストを載せる設定か。runs が空かどうかではない。
  // B110: run を持つテストが無い公開でも 1。収集の停止の期間はテストの期間に切り詰めるので、その違いは結果に出ない)が前回の記録と違えば 1 行足す。
  // 行が無いときは有効のときだけ足す(最初から記録しない Site には行を作らない)。published_status と同じ fence の中で、
  // 比べるのと足すのを 1 文にする(追い越された Publish は書かない。収集の停止の期間はこの記録から出す)
  const collecting = site.results_enabled === 1 ? 1 : 0;
  await sql`
    insert into results_collection_log (site_id, at, enabled, publish_version)
    select ${site.id}, ${nowMs}, ${collecting}, ${version}
    where exists (select 1 from sites where id = ${site.id} and active_version = ${version})
      and coalesce((select enabled from results_collection_log where site_id = ${site.id} order by id desc limit 1), 0) <> ${collecting}`.execute(db);
  // D9 ③(plan ③ の K13、設計書 §7.1): 公開で配信の定義・収集の状態が変わるので、保存した速報を消す(次の結果の読みで計算し直す)。
  // 同じ fence の中で消す(追い越された Publish は消さない)。速報を書く側は active_version が読んだ値のままのときだけ書く
  await sql`
    delete from results_interim_cache
    where site_id = ${site.id} and exists (select 1 from sites where id = ${site.id} and active_version = ${version})`.execute(db);

  // 削除してはいけないのは「いま配信されている版」。自分が KV に書いた版(`written`)を渡し、
  // cleanup 側はそれに加えて KV の `active` レコードそのものも読んで守る(自分の版は activated_at = nowMs で 5 分ルールが守る)。
  // ここから下はハウスキーピング(容量最適化であって正しさの前提ではない)。activation は既に成功しているので、
  // cleanup が D1 / KV でこけても publishSite 自体は throw しない(Task 7: status 変更が成功した応答が 500 に化けない)
  try {
    await cleanupOldVersions(env, db, site.id, written, nowMs);
  } catch (e) {
    console.error("cleanupOldVersions failed (best-effort, will retry next publish)", e);
  }
  // 決定 52 / spec §13.6 手順 6: 配信ファイルの出し直し。activation は済んでいるので、失敗しても Publish は成功(plan K4)
  const outcome = await requestStaticDeploy(env, db, site.id);
  // staticGeneration は内部用(D9 が Publish の行と配った世代を結びつける)。応答には publicPublishResult で外して出す。
  // 出し直しは最新の D1 から入力を作るので、activation の後により新しい Publish が activation していると、その世代には別の版が焼かれる。
  // 自分の版を焼いた世代のときだけ返し、違えば null(より新しい Publish に追い越された。D9 はこの行を配信済みにしない)
  const staticGeneration = outcome.version === version ? outcome.generation : null;
  await recordDelivery(env, db, site.id, version, staticGeneration, outcome);
  return { ok: true, version, needsProfile: config.needsProfile, superseded: false, staticDeploy: outcome.state, staticGeneration, warnings };
}

/**
 * D9 ③(設計書 §5.5、plan ③ の K14): activation の batch で足した届く定義の行に、この版を焼いた出し直しの世代を入れ、
 * その世代そのもの(中身も同じ)を配り終えていれば、その 1 点で配信を確かめる(partial: ほかの行は確定しない)。
 * 依頼を送っていない(outcome.digest が null = 依頼の記録を書けなかった・binding が無い・削除の依頼)なら世代も書かない
 * (7o K24 (5): 送っていない世代が行に入ると、依頼の記録の無い世代を行の世代で補う道で古い履歴に引かれる。これで更新の後は
 * 「行に世代がある ⇒ 依頼の記録がある」になる)。1 点には送った入力の digest を付ける(依頼の記録の digest と組み合うときだけ数える)。
 * activation は済んでいるので、失敗しても Publish は成功のまま(行は残る。世代が NULL のままでも、その版を焼いた世代は依頼の記録から引ける)
 */
async function recordDelivery(env: Env, db: Db, siteId: string, version: number, generation: StaticGeneration | null, outcome: StaticDeployOutcome): Promise<void> {
  if (generation === null || outcome.digest === null) return;
  try {
    await setDeliveredGeneration(db, siteId, version, generation);
    if (outcome.state === "deployed" && outcome.deployedAt !== null)
      await confirmDeliveries(
        db,
        siteId,
        { history: [{ generation, deployedAt: outcome.deployedAt, digest: outcome.digest }], historyFrom: null, partial: true },
        Date.now(),
        apiGuard(env),
        edgeOrigin(env),
      );
  } catch (e) {
    console.error("delivered definition update failed (best-effort, confirmed later by cron)", e);
  }
}

/** 応答に出さない内部用の値(staticGeneration)を外す。OpenAPI の PublishResultSchema には載せない */
export function publicPublishResult(r: PublishResult): PublishResult {
  if (!r.ok) return r;
  const { staticGeneration: _internal, ...rest } = r;
  return rest;
}

/**
 * spec §9.4: 切り替えに必要な版 = KV の active の版・今書いた版・RECENT_ACTIVE_MS 以内に active だった版・配信ファイルが配る版(以上)だけを残し、
 * それ以外の config キーを削除する(plan12 K14 (b): 「直近 N 版」の保持はやめた)。公開のとき(publishSite)と、control の Cron `config-cleanup` から呼ぶ。
 *
 * 配信ファイル(静的アセット)が配っている版も残す(① 不明なら何も消さない ② その版以上 ③ 切り替えの直後 5 分は前の版。決定 52 / plan K20)。
 *
 * 「active 版」の正本は **KV の `active` レコード**(= edge が実際に読む値)であって、D1 の記帳ではない。
 * put の成否不明(`kv_rate_limited`)のあと D1 だけが巻き戻り、その版が `failed` / `activated_at = null` のまま
 * 新しい版に押し出されると、D1 だけを見た cleanup は**配信中の config を消してしまう**。
 * そのため KV を読んでその版を必ず残し、KV が読めなければ 1 件も消さない(fail-closed)
 */
export async function cleanupOldVersions(env: Env, db: Db, siteId: string, writtenVersion: number, nowMs: number, beforeDelete?: () => Promise<void>): Promise<number> {
  // 戻り値 = 出した D1 のクエリの数(KV は数えない)。Cron が 1 回の実行の D1 の予算を数えるのに使う
  let queries = 0;
  let served: number | null;
  try {
    const raw = await env.CONFIG_KV.get(kvKeys.active(siteId));
    served = raw === null ? null : Number(raw);
  } catch {
    return queries; // KV が読めない = いま何が配信されているか分からない。何も消さない
  }
  if (served !== null && !Number.isInteger(served)) return queries; // 壊れた active レコード。同上
  // 決定 52 / plan K20: 配信ファイル(静的アセット)が配っている版。配信ファイルの更新が遅れている間も、
  // 古い bootstrap が decision でその版を求めるので、その版の config を残す
  queries++;
  const st = await db
    .selectFrom("sites")
    .select(["static_served_version", "static_prev_served_version", "static_served_at"])
    .where("id", "=", siteId)
    .executeTakeFirst();
  // ① 配っている版がまだ分からない(確かめた出し直しが無い)なら何も消さない
  if (!st || st.static_served_version === null) return queries;
  queries++;
  const rows = await db
    .selectFrom("publishes")
    .select(["id", "version", "status", "activated_at", "kv_deleted"])
    .where("site_id", "=", siteId)
    .where("kv_deleted", "=", 0)
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
  if (doomed.length === 0) return queries;
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
  return queries;
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
