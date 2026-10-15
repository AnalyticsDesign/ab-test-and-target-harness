import { sql, type ExpressionBuilder } from "kysely";
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
  type StaticGeneration,
} from "@wtt/core";
import { RUNTIME_HASH, RUNTIME_SOURCE } from "@wtt/runtime/source";
import { edgeOrigin } from "./capabilities";
import type { Db, ExperimentRow, SiteRow, Tables } from "./db";
import type { Env } from "./env";
import { newId } from "./ids";
import { siteToSettings } from "./site-settings";
import { requestStaticDeploy, type StaticDeployState } from "./static-delivery";

export const KEEP_RECENT = 5; // spec §9.4: 直近 5 版
export const RECENT_ACTIVE_MS = 5 * 60_000; // spec §9.4: 5 分以内に active だった版

// 失敗形のフィールド名は §13.5 の封筒に揃える(error = 機械可読コード、message = 文)
export type PublishResult =
  | { ok: true; version: number; needsProfile: boolean; superseded: boolean; staticDeploy: StaticDeployState; staticGeneration?: StaticGeneration | null; warnings: AnalyticsWarning[] }
  | { ok: false; version: number | null; error: string; message: string; hint?: string };

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

export async function buildCompileInput(
  db: Db,
  site: SiteRow,
  version: number,
  experiments?: ExperimentRow[],
  scope: CompileInputScope = {},
): Promise<unknown> {
  const statuses = scope.statuses ?? (["running"] as const);
  const all = experiments ?? (await db.selectFrom("experiments").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute());
  const exps = all.filter((e) => statuses.includes(e.status) && (!scope.experimentIds || scope.experimentIds.includes(e.id)));
  const variants = await db.selectFrom("variants").selectAll().where("site_id", "=", site.id).orderBy("position").execute();
  const changes = await db.selectFrom("changes").selectAll().where("site_id", "=", site.id).orderBy("position").execute();
  const goals = await db.selectFrom("goals").selectAll().where("site_id", "=", site.id).execute();
  const audiences = await db.selectFrom("audiences").select(["id", "definition_json"]).where("site_id", "=", site.id).execute();
  return {
    siteId: site.id,
    siteSalt: site.site_salt,
    version,
    timezone: site.timezone,
    goals: goals.map((g) => ({ id: g.id, name: g.name, type: g.type, config: JSON.parse(g.config_json) })),
    retentionDays: site.retention_days,
    audiences: Object.fromEntries(audiences.map((a) => [a.id, JSON.parse(a.definition_json)])),
    experiments: exps.map((e) => ({
      id: e.id,
      name: e.name,
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
  invalid_regex: { message: "配信できない正規表現があります" },
  regex_too_large: { message: "大きすぎる正規表現があります" },
  regex_budget_exceeded: { message: "正規表現の合計が大きすぎます(サイト全体で 500 命令まで)" },
};
/** compile の CompileError の message が利用者向けの日本語の説明(場所と直し方)になっているコード。hint にそのまま出す */
export const COMPILE_HINT_CODES: ReadonlySet<string> = new Set([
  "invalid_regex", "regex_too_large", "regex_budget_exceeded",
  "legacy_targeting", "invalid_experiment_targeting", "invalid_audience_definition", "unknown_audience", "unknown_goal", "within_days_exceeds_retention",
]);

/** Publish の失敗(と、確認画面の compile の失敗)の利用者向けの文言。古い書式は書き換え方も足す */
export function describeCompileFailure(code: string, raw: string): { message: string; hint?: string } {
  const text = FAILURE_MESSAGES[code] ?? { message: "公開に失敗しました" };
  if (!COMPILE_HINT_CODES.has(code)) return text;
  return { message: text.message, hint: code === "legacy_targeting" ? `${raw}。${LEGACY_TARGETING_HINT}` : raw };
}

function failure(code: string, version: number | null, raw: string): PublishResult {
  console.error(`publish failed (${code})`, raw);
  const { message, hint } = describeCompileFailure(code, raw);
  return { ok: false, version, error: code, message, ...(hint ? { hint } : {}) };
}

/**
 * spec §13.6 の Publish。手順 1〜6 を 1 関数で行い、activation 前の失敗は旧 version を active のまま残す。
 * nowMs は cleanup の時刻判定(テストで注入)。KV / D1 の呼び出しはここに閉じる(compile は core の純関数)
 */
export async function publishSite(env: Env, db: Db, site: SiteRow, userId: string, nowMs = Date.now()): Promise<PublishResult> {
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
  try {
    // 写しと compile 入力は**同じ 1 回の SELECT** から取る(別々に読むと間に割り込んだ status 変更で食い違う。rulings §4 CX-High-3)
    const experiments = await db.selectFrom("experiments").selectAll().where("site_id", "=", site.id).orderBy("created_at").execute();
    statusSnapshot = experiments.map((e) => ({ id: e.id, status: e.status }));
    config = compile(await buildCompileInput(db, site, version, experiments));
    // §10.9: compile は警告に留める。拒否は保存 API(`assertName`)側
    warnings = analyticsWarnings(config);
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

  // 手順 3: 予約した N に 1 回だけ put(immutable)
  const key = kvKeys.config(site.id, version);
  const body = JSON.stringify(config);
  const hash = await sha256Hex(body);
  try {
    await env.CONFIG_KV.put(key, body);
  } catch (e) {
    await markFailed(db, rowId, "kv_put_failed", String(e));
    return failure("kv_put_failed", version, String(e));
  }
  // 手順 4: 公開履歴(本体 + hash)を予約行に記録
  await db.updateTable("publishes").set({ config_hash: hash, config_json: body, needs_profile: config.needsProfile ? 1 : 0 }).where("id", "=", rowId).execute();

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
  for (let attempt = 0; attempt < CAS_ATTEMPTS && !activated; attempt++) {
    const cur = await db.selectFrom("sites").select(["active_version", "last_activated_at"]).where("id", "=", site.id).executeTakeFirstOrThrow();
    prev = cur.active_version;
    prevActivatedAt = cur.last_activated_at;
    if (prev !== null && prev >= version) break; // 自分より新しい version が先に active になった
    const upd = await db
      .updateTable("sites")
      // 決定 52 / plan K4: 配信ファイルの印は activation と同じ文で立てる。出し直しの依頼の前に処理が止まっても印が残り、
      // GET の自己修復が拾う。activation で seq を進めるので、それより前の依頼の結果が印を下ろさない
      .set({ active_version: version, last_activated_at: nowMs, static_seq: sql<number>`static_seq + 1`, static_stale: 1 })
      .where("id", "=", site.id)
      .where((eb) => (prev === null ? eb("active_version", "is", null) : eb("active_version", "=", prev)))
      .executeTakeFirst();
    activated = Number(upd.numUpdatedRows) > 0;
  }
  if (!activated) {
    // 追い越された(または CAS が競り負け続けた)。KV は触らず履歴だけ残す(次の Publish が最新を活性化する)
    await db.updateTable("publishes").set({ status: "superseded" }).where("id", "=", rowId).execute();
    return { ok: true, version, needsProfile: config.needsProfile, superseded: true, staticDeploy: "skipped", warnings };
  }
  // KV `active` の put(書く値は D1 最新版。review r2 CX-High-4)
  let written: number;
  try {
    written = await putActiveLatest(env, db, site.id);
  } catch (e) {
    // 成否不明(put は通ったが throw した可能性)なので stale を立て、D1 は prev に戻す(まだ自分の版のときだけ)
    await db
      .updateTable("sites")
      .set({ active_version: prev, last_activated_at: prevActivatedAt, active_kv_stale: 1 })
      .where("id", "=", site.id)
      .where("active_version", "=", version)
      .execute();
    await markFailed(db, rowId, "kv_rate_limited", String(e));
    return failure("kv_rate_limited", version, String(e));
  }
  // 自己修復: 書いた後に D1 がさらに進んでいたら stale を立てる(次回 Publish の冒頭、または次の GET /sites/:sid の
  // reconcile で最新版を再 put。Task 8 で両方に配線済み)。失敗を黙って捨てない。
  // 「読んで比べて書く」ではなく 1 文の条件式にして、比較と更新の間に別の activation が挟まる窓を無くす(rulings §4 CX-High-3)
  await db
    .updateTable("sites")
    .set({ active_kv_stale: sql<number>`case when active_version = ${written} then 0 else 1 end` })
    .where("id", "=", site.id)
    .execute();

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
  return { ok: true, version, needsProfile: config.needsProfile, superseded: false, staticDeploy: outcome.state, staticGeneration, warnings };
}

/** 応答に出さない内部用の値(staticGeneration)を外す。OpenAPI の PublishResultSchema には載せない */
export function publicPublishResult(r: PublishResult): PublishResult {
  if (!r.ok) return r;
  const { staticGeneration: _internal, ...rest } = r;
  return rest;
}

/**
 * spec §9.4: 直近 KEEP_RECENT 版・active 版・RECENT_ACTIVE_MS 以内に active だった版は残し、それ以外の config キーを削除する。
 *
 * 配信ファイル(静的アセット)が配っている版も残す(① 不明なら何も消さない ② その版以上 ③ 切り替えの直後 5 分は前の版。決定 52 / plan K20)。
 *
 * 「active 版」の正本は **KV の `active` レコード**(= edge が実際に読む値)であって、D1 の記帳ではない。
 * put の成否不明(`kv_rate_limited`)のあと D1 だけが巻き戻り、その版が `failed` / `activated_at = null` のまま
 * 直近 5 版から押し出されると、D1 だけを見た cleanup は**配信中の config を消してしまう**。
 * そのため KV を読んでその版を必ず残し、KV が読めなければ 1 件も消さない(fail-closed)
 */
async function cleanupOldVersions(env: Env, db: Db, siteId: string, writtenVersion: number, nowMs: number): Promise<void> {
  let served: number | null;
  try {
    const raw = await env.CONFIG_KV.get(kvKeys.active(siteId));
    served = raw === null ? null : Number(raw);
  } catch {
    return; // KV が読めない = いま何が配信されているか分からない。何も消さない
  }
  if (served !== null && !Number.isInteger(served)) return; // 壊れた active レコード。同上
  // 決定 52 / plan K20: 配信ファイル(静的アセット)が配っている版。配信ファイルの更新が遅れている間も、
  // 古い bootstrap が decision でその版を求めるので、その版の config を残す
  const st = await db
    .selectFrom("sites")
    .select(["static_served_version", "static_prev_served_version", "static_served_at"])
    .where("id", "=", siteId)
    .executeTakeFirst();
  // ① 配っている版がまだ分からない(確かめた出し直しが無い)なら何も消さない
  if (!st || st.static_served_version === null) return;
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
  for (const r of rows.slice(0, KEEP_RECENT)) keep.add(r.version);
  for (const r of rows) if (r.activated_at !== null && nowMs - r.activated_at < RECENT_ACTIVE_MS) keep.add(r.version);
  for (const r of rows) {
    if (keep.has(r.version)) continue;
    await env.CONFIG_KV.delete(kvKeys.config(siteId, r.version)).catch(() => {});
    await db.updateTable("publishes").set({ kv_deleted: 1 }).where("id", "=", r.id).execute();
  }
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
