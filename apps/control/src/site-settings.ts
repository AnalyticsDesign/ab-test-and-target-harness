import { sql } from "kysely";
import { z } from "zod";
import { AnalyticsSettingsSchema, DEFAULT_ANALYTICS, canonicalTimeZone, kvKeys, SITE_ID_RE, SiteSettingsSchema, type SiteSettings } from "@wtt/core";
import { toStatement, type Db, type SiteRow } from "./db";
import type { Env } from "./env";
import { ApiError, validationFailed } from "./errors";

const HOST_RE = /^[a-z0-9.-]+$/;

/** ホスト名の正規化(小文字・末尾のドット除去・前後空白除去)。KV / D1 の鍵はこの形だけを使う */
export const normalizeHost = (h: string): string => h.trim().toLowerCase().replace(/\.+$/, "");

/** hosts が他 Site に取られていないことだけを調べる(PATCH は batch で入れ替えるのでこれだけを使う) */
export async function assertHostsFree(db: Db, siteId: string, hosts: string[]): Promise<void> {
  if (hosts.length === 0) return;
  const taken = await db.selectFrom("site_hosts").select("host").where("host", "in", hosts).where("site_id", "!=", siteId).executeTakeFirst();
  if (taken) throw new ApiError(409, "host_in_use", { host: taken.host, message: "このホスト名は使えません", hint: "このホスト名は別のサイトに登録されています" });
}

/**
 * PATCH が実際に書き換え得る列(= `applySitePatch` が触る列)。**行全体を書き戻さない**。
 * リクエスト開始時に読んだ行をそのまま SET すると、並行する Publish(Task 6)の記帳列
 * (`active_version` / `active_kv_stale` / `last_activated_at` / `content_updated_at`)を巻き戻す。
 * とくに `active_kv_stale` は KV の active が D1 と食い違ったことを次の Publish に伝える旗なので、
 * PATCH が 0 に戻すと自己修復の契機そのものが消える(Task 6 の `reconcileActive` が依存)。
 * `id` / `workspace_id` / `site_salt` / `bridge_secret*` / `created_at` も PATCH では不変
 */
export const SITE_PATCH_COLUMNS = [
  "name", "domain", "mode", "id_source", "allowed_origins_json", "hosts_json",
  "retention_days", "consent_mode", "decision_timeout_ms",
  "visitor_cookie_name", "uuid_cookie_enabled", "uuid_cookie_name", "previous_cookie_names_json",
  "forget_on_revoke", "timezone", "analytics_json", "ga4_property_id", "bigquery_dataset", "updated_at",
] as const satisfies readonly (keyof SiteRow)[];

/** Kysely の `compile()`(`sql` / `parameters`)を D1 の prepared statement 配列に写す(batch = 1 トランザクション用) */
export function compileUpdate(env: Env, db: Db, row: SiteRow, opts: { markStaticStale?: boolean } = {}): D1PreparedStatement[] {
  const patch = Object.fromEntries(SITE_PATCH_COLUMNS.map((k) => [k, row[k]])) as Pick<SiteRow, (typeof SITE_PATCH_COLUMNS)[number]>;
  // 決定 52 / plan K4: bootstrap に焼く設定が変わるときは、同じ文で配信ファイルの世代を進めて印を立てる
  const set = opts.markStaticStale ? { ...patch, static_seq: sql<number>`static_seq + 1`, static_stale: 1 } : patch;
  return [toStatement(env, db.updateTable("sites").set(set).where("id", "=", row.id))];
}

/**
 * host → site の所有権を D1 で確定する(**Site 作成時のみ**。PATCH は assertHostsFree + batch)。自 site の行を消してから insert し、
 * PK 違反(= 他 site が所有)は 409 host_in_use。KV に触れる前に必ず呼ぶ
 */
export async function claimHosts(db: Db, siteId: string, hosts: string[]): Promise<void> {
  // 先に衝突を調べる(自 site の行を消した後で 409 にすると、失敗時に自 site の所有権が抜ける)
  await assertHostsFree(db, siteId, hosts);
  await db.deleteFrom("site_hosts").where("site_id", "=", siteId).execute();
  for (const host of hosts) {
    try {
      await db.insertInto("site_hosts").values({ host, site_id: siteId }).execute();
    } catch {
      // 上の検査と insert の間に別 Site が取った(稀)。同じ 409 で返す
      throw new ApiError(409, "host_in_use", { host, message: "このホスト名は使えません", hint: "このホスト名は別のサイトに登録されています" });
    }
  }
}

export const SiteCreateSchema = z.strictObject({
  id: z.string().regex(SITE_ID_RE).optional(),
  name: z.string().min(1).max(100),
  domain: z.string().regex(HOST_RE),
  mode: z.enum(["A", "B"]).default("A"),
  consentMode: z.enum(["implicit", "required"]).default("implicit"),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  visitorCookieName: z.string().optional(),
  uuidCookieEnabled: z.boolean().default(false),
  uuidCookieName: z.string().optional(),
});

/** spec §13.5 PATCH /sites/:sid の受理フィールド(ADMIN 以上)。値の検証は core の SiteSettingsSchema に委ねる */
export const SitePatchSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  domain: z.string().regex(HOST_RE).optional(),
  mode: z.enum(["A", "B"]).optional(),
  idSource: z.string().optional(),
  allowedOrigins: z.array(z.string()).max(50).optional(),
  hosts: z.array(z.string()).max(50).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  forgetOnRevoke: z.boolean().optional().describe("撤回時に Profile を削除する(既定 true)。false は Retention に委ねる"),
  timezone: z.string().min(1).max(64).optional().describe("曜日・時間帯の条件の判定に使うタイムゾーン(IANA 名。例: Asia/Tokyo)。変更は次の公開で効く"),
  consentMode: z.enum(["implicit", "required"]).optional(),
  decisionTimeoutMs: z.number().int().optional(),
  visitorCookieName: z.string().optional(),
  uuidCookieEnabled: z.boolean().optional(),
  uuidCookieName: z.string().optional(),
  // 検証は core の AnalyticsSettingsSchema に委ねる(失敗を validation_failed ではなく 422 invalid_analytics で返すため、ここでは unknown)
  analytics: z.unknown().optional().describe("外部計測の名前(dataLayer の命名設定)。全フィールド optional、未指定は既定値。`dataLayerName` は push 先の配列の名前(既定 `dataLayer`。GTM のスニペットで名前を変えているサイトは同じ名前にする)。不正なら 422 invalid_analytics"),
  // 決定 34: 外部 ID(資格情報ではない)。null で消去。site-settings record には載せない
  ga4PropertyId: z.string().regex(/^\d{1,20}$/).nullable().optional(),
  bigqueryDataset: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]\.[A-Za-z0-9_]{1,1024}$/).nullable().optional(),
});
export type SitePatch = z.infer<typeof SitePatchSchema>;

type PrevName = { name: string; until: number };
const prevNames = (row: SiteRow): PrevName[] => JSON.parse(row.previous_cookie_names_json) as PrevName[];

/** D1 行 → site-settings record(spec §5.4 / §9.6)。row が不正なら throw(保存経路が検証済みのため到達しない) */
export function siteToSettings(row: SiteRow): SiteSettings {
  return SiteSettingsSchema.parse(settingsInput(row));
}

/**
 * PATCH を行に適用し、Identity の migration(spec §5.4)と決定 29 / 30 の保存時検証を行う。
 * 返す error は 422 コード付き。KV / D1 への書込みは呼び出し側(activation = KV put 成功後に D1)
 */
export function applySitePatch(row: SiteRow, patch: SitePatch, nowMs: number): { next: SiteRow; error?: ApiError } {
  const nowSec = Math.floor(nowMs / 1000);
  // Identity / Analytics 命名設定は KV 即時反映で Publish 不要。`content_updated_at` は Goal / オーディエンス(`touchSite`)と、タイムゾーンの変更(PATCH のルートが touchSite)だけが進める
  const next: SiteRow = { ...row, updated_at: nowMs };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.domain !== undefined) next.domain = patch.domain;
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.idSource !== undefined) next.id_source = patch.idSource;
  if (patch.allowedOrigins !== undefined) next.allowed_origins_json = JSON.stringify(patch.allowedOrigins);
  if (patch.hosts !== undefined) next.hosts_json = JSON.stringify(patch.hosts.map(normalizeHost));
  if (patch.retentionDays !== undefined) next.retention_days = patch.retentionDays;
  if (patch.consentMode !== undefined) next.consent_mode = patch.consentMode;
  if (patch.decisionTimeoutMs !== undefined) next.decision_timeout_ms = patch.decisionTimeoutMs;
  if (patch.forgetOnRevoke !== undefined) next.forget_on_revoke = patch.forgetOnRevoke ? 1 : 0;
  if (patch.timezone !== undefined) {
    // 大文字小文字だけを一覧の綴りにそろえて保存する(asia/tokyo → Asia/Tokyo。別名は置き換えない)。オフセット形式は IANA 名ではないので受けない(plan ② P14)
    const tz = canonicalTimeZone(patch.timezone);
    if (tz === null)
      return { next, error: new ApiError(422, "invalid_timezone", { path: ["timezone"], message: "タイムゾーンが不正です", hint: "Asia/Tokyo のような IANA のタイムゾーン名を指定してください" }) };
    next.timezone = tz;
  }

  // 期限切れの旧名を prune(スキーマは時刻非依存なので control が担う、spec §4.3)。until は epoch **秒**(core の型)
  let previous = prevNames(row).filter((p) => p.until > nowSec);
  const until = nowSec + next.retention_days * 86400;
  const alive = (name: string) => previous.some((p) => p.name === name);

  if (patch.visitorCookieName !== undefined && patch.visitorCookieName !== row.visitor_cookie_name) {
    // message は封筒の必須項目(spec §13.5)。ここまで hint だけだったため画面には code がそのまま出ていた(Task 11 で実地確認して発見)
    if (alive(patch.visitorCookieName))
      return { next, error: new ApiError(422, "cookie_name_in_use", { name: patch.visitorCookieName, message: "この Cookie 名は使えません", hint: "保持期限内の旧 Cookie 名には戻せません" }) };
    previous = [...previous.filter((p) => p.name !== row.visitor_cookie_name), { name: row.visitor_cookie_name, until }];
    next.visitor_cookie_name = patch.visitorCookieName;
  }
  const uuidWasOn = row.uuid_cookie_enabled === 1;
  if (patch.uuidCookieEnabled !== undefined) next.uuid_cookie_enabled = patch.uuidCookieEnabled ? 1 : 0;
  if (patch.uuidCookieName !== undefined && patch.uuidCookieName !== row.uuid_cookie_name) {
    if (alive(patch.uuidCookieName))
      return { next, error: new ApiError(422, "cookie_name_in_use", { name: patch.uuidCookieName, message: "この Cookie 名は使えません", hint: "保持期限内の旧 Cookie 名には戻せません" }) };
    if (uuidWasOn) previous = [...previous.filter((p) => p.name !== row.uuid_cookie_name), { name: row.uuid_cookie_name, until }];
    next.uuid_cookie_name = patch.uuidCookieName;
  }
  // UUID Cookie の無効化: 旧 UUID Cookie を削除対象にする(spec §5.4)
  if (uuidWasOn && next.uuid_cookie_enabled === 0) previous = [...previous.filter((p) => p.name !== row.uuid_cookie_name), { name: row.uuid_cookie_name, until }];
  // 有効化で再び名前を使うなら、旧名リストから外す(自分が出力する Cookie を自分で消さない)
  if (next.uuid_cookie_enabled === 1) previous = previous.filter((p) => p.name !== next.uuid_cookie_name);
  next.previous_cookie_names_json = JSON.stringify(previous);

  if (patch.ga4PropertyId !== undefined) next.ga4_property_id = patch.ga4PropertyId;
  if (patch.bigqueryDataset !== undefined) next.bigquery_dataset = patch.bigqueryDataset;

  if (patch.analytics !== undefined) {
    const a = AnalyticsSettingsSchema.safeParse(patch.analytics);
    if (!a.success) {
      // openapi.ts の ErrorEnvelopeSchema は path を配列と宣言している(決定 34。/openapi.json から生成した
      // エージェント側クライアントはその型で読む)。ここは validationFailed() を経由しない独自の ApiError だった
      // ため、path に(zod の issue を `.join(".")` した)**文字列**を積んで契約に違反していた
      // (review r2 finding 2)。validationFailed() を使い、配列 path + issues 全件を得たうえで、
      // zod の issue.message は英語(GA4 の規則を英語で記述する core の設計。§10.9)なので hint に落とし、
      // message だけ日本語の既定文で上書きする(Task 11 で実地確認して発見した「message が無く hint だけ」問題の対処と両立)
      const err = validationFailed(a.error, "invalid_analytics");
      err.extra.hint = a.error.issues[0]?.message;
      // 決定 62: dataLayer の変数名は GA4 に送られない(JS の識別子の規則)ので、GA4 の文言を出さない
      err.extra.message = a.error.issues[0]?.path[0] === "dataLayerName"
        ? "dataLayer の変数名は JavaScript の変数名として使える名前にしてください"
        : "外部計測の名前の設定が GA4 の規則に反しています";
      return { next, error: err };
    }
    next.analytics_json = JSON.stringify(a.data);
  }

  // 決定 29 / 30 の順序: 機械可読コードを持つ規則を先に、残りは core の SiteSettingsSchema
  const ref = next.id_source.startsWith("cookie:") ? next.id_source.slice("cookie:".length) : null;
  if (ref && (ref === next.visitor_cookie_name || ref === next.uuid_cookie_name || previous.some((p) => p.name === ref))) {
    return { next, error: new ApiError(422, "byoid_cookie_name_conflict", { name: ref, message: "BYOID の参照 Cookie 名が衝突しています", hint: "BYOID の参照 Cookie 名は正本 / UUID / 旧 Cookie 名と衝突できません" }) };
  }
  if (next.mode === "B" && next.id_source !== "ab")
    return { next, error: new ApiError(422, "mode_b_requires_id_source_ab", { message: "Mode B(サーバー発行 Cookie)と Mode C(BYOID)は併用できません", hint: "Mode B(サーバー発行 Cookie)と Mode C(BYOID)は MVP では併用できません" }) };
  const parsed = SiteSettingsSchema.safeParse(settingsInput(next));
  if (!parsed.success) {
    // 同上(invalid_analytics と同じ理由で validationFailed() 経由に変更。review r2 finding 2)
    const err = validationFailed(parsed.error, "invalid_settings");
    err.extra.hint = parsed.error.issues[0]?.message;
    err.extra.message = "サイトの設定が不正です";
    return { next, error: err };
  }
  return { next };
}

function settingsInput(row: SiteRow): unknown {
  return {
    settingsVersion: 1, siteId: row.id, mode: row.mode, idSource: row.id_source,
    allowedOrigins: JSON.parse(row.allowed_origins_json), hosts: JSON.parse(row.hosts_json),
    visitorCookieName: row.visitor_cookie_name, uuidCookieEnabled: row.uuid_cookie_enabled === 1, uuidCookieName: row.uuid_cookie_name,
    previousCookieNames: prevNames(row), decisionTimeoutMs: row.decision_timeout_ms, consentMode: row.consent_mode,
    analytics: row.analytics_json ? JSON.parse(row.analytics_json) : DEFAULT_ANALYTICS,
    retentionDays: row.retention_days, // spec §8.3: DO の alarm 期限は record で edge に配送する(決定 37)
    forgetOnRevoke: row.forget_on_revoke === 1,
  };
}

/** spec §5.4「設定の配送」: settings record と host キーを KV に書く(activation = KV put)。削除された host のキーは消す */
export async function writeSiteRecords(env: Env, row: SiteRow, previousHosts: string[]): Promise<void> {
  try {
    const settings = siteToSettings(row);
    await env.CONFIG_KV.put(kvKeys.settings(row.id), JSON.stringify(settings));
    for (const h of settings.hosts) await env.CONFIG_KV.put(kvKeys.host(h), row.id);
    // 消すのは「自 Site を指している」host キーだけ(他 Site の mapping を巻き込まない)。
    // KV に CAS が無いため get → delete には TOCTOU が残る(get と delete の間に別 Site が
    // その mapping を claim すると、その Site の host キーを消してしまう)。既知の残留で、
    // 巻き込まれた Site の次の PATCH が同じ host を put し直して自己修復する
    for (const h of previousHosts)
      if (!settings.hosts.includes(h)) {
        const cur = await env.CONFIG_KV.get(kvKeys.host(h));
        if (cur === row.id) await env.CONFIG_KV.delete(kvKeys.host(h));
      }
  } catch (e) {
    // message は利用者向けの日本語文言に固定する(describeError がそのまま画面に出す)。生の例外文字列は detail に載せ、
    // errorHandler が 5xx をサーバー側にも記録する(routes/sites.ts の host_in_use と同じ形)
    throw new ApiError(503, "settings_write_failed", { message: "設定の保存に失敗しました", hint: "再試行してください", detail: String(e) });
  }
}

/** Site 削除時の KV 後始末(settings / 自 Site を指す host / active / 予約済み version の config) */
export async function deleteSiteRecords(env: Env, row: SiteRow, versions: number[]): Promise<void> {
  await env.CONFIG_KV.delete(kvKeys.settings(row.id));
  for (const h of JSON.parse(row.hosts_json) as string[]) {
    const cur = await env.CONFIG_KV.get(kvKeys.host(h));
    if (cur === row.id) await env.CONFIG_KV.delete(kvKeys.host(h));
  }
  await env.CONFIG_KV.delete(kvKeys.active(row.id));
  for (const v of versions) await env.CONFIG_KV.delete(kvKeys.config(row.id, v));
}

/** R2 の `sites/<sid>/` 配下をすべて削除する(ベストエフォート。失敗しても Site 削除は成功させ、残骸は手動で消す(control-deploy の手順は廃止)) */
export async function deleteSiteAssets(env: Env, siteId: string): Promise<void> {
  // 決定 43 (5): R2 なし構成(binding が無い)では何もしない。公開ベースが空でも binding があれば消せるものは消す(孤児を作らない)。
  // このため imageStore ではなく binding の有無だけを見る
  const bucket = env.ASSETS;
  if (!bucket) return;
  try {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: `sites/${siteId}/`, cursor });
      if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch {
    // ベストエフォート
  }
}
