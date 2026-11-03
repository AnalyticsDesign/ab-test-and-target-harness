import { sql } from "kysely";
import { z } from "zod";
import {
  AnalyticsSettingsSchema, DEFAULT_ANALYTICS, canonicalTimeZone, kvKeys, markerCookieName, NEW_PROFILE_BUDGET_DEFAULTS, NEW_PROFILE_INSTANCE_PER_DAY_FREE, SITE_ID_RE, SiteSettingsSchema,
  type NewProfileBudget, type SiteSettings,
} from "@wtt/core";
import { deriveCookieScopes, registrableDomain } from "./cookie-scope";
import { toStatement, type Db, type SiteRow } from "./db";
import { checkDomainList, deriveDomainColumns, MAX_DOMAINS, type DomainInputError, type DomainRow } from "./domains";
import type { Env } from "./env";
import { ApiError, validationFailed } from "./errors";
import type { CloudflarePlan } from "./instance-settings";

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
  "name", "domain", "mode", "id_source", "allowed_origins_json", "hosts_json", "domains_json",
  "retention_days", "consent_mode", "decision_timeout_ms",
  "visitor_cookie_name", "uuid_cookie_enabled", "uuid_cookie_name", "previous_cookie_names_json",
  "forget_on_revoke", "timezone", "analytics_json", "ga4_property_id", "bigquery_dataset",
  "results_enabled", "results_retention_days", "new_profile_budget_per_day", "share_subdomains", "previous_cookie_domains_json", "updated_at",
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

/**
 * B148: タグを置くドメインの一覧の書き込み。行の検査(形・重複・件数)は applySitePatch が checkDomainList で行い、
 * 422 invalid_domains で行ごとの日本語の文を返す(zod の英語の文を出さないため、ここでは文字列の配列であることだけを見る)
 */
const DomainsInput = z
  .array(z.string())
  .describe(
    `タグを置くドメインの一覧(1〜${MAX_DOMAINS} 行)。1 行に 1 つのホスト名(例: www.example.com)。https:// や末尾の / は付けても外して保存する。` +
      "http:// で書いた行と、既定でないポート付きで書いた行(例: http://localhost:8080、https://www.example.com:8443)は開発用として Origin の形のまま保存する。" +
      "既定のポートは外す: https://www.example.com:443 と www.example.com:443 は通常の行 www.example.com になり、http://localhost:80 は開発用の http://localhost になる。" +
      "先頭の行が代表のドメイン(domain)になる。" +
      "送った一覧で保存済みの一覧を置き換える(同じ値の行は前の判定を保つ)。共有(shareSubdomains)がオンのとき、公開の接尾辞そのもの(co.jp など)の行は 422 invalid_domains",
  );

/** B148: 旧い欄(書き込みは domains に変わった)。読み取りの応答には domain・allowedOrigins が読むだけの値として残る */
const LEGACY_DOMAIN_FIELDS = ["domain", "allowedOrigins", "hosts"] as const;

/**
 * 書き込みの body に旧い欄があれば 422 legacy_domain_fields を返す。strictObject の失敗(知らない欄)より前に、
 * validator のフックが受けた生の body で見る(旧い欄を送る利用者に、書き換え方を示すため)
 */
export function legacyDomainFieldsError(body: unknown): ApiError | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const found = LEGACY_DOMAIN_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
  if (found.length === 0) return null;
  return new ApiError(422, "legacy_domain_fields", {
    path: [found[0]],
    issues: found.map((k) => ({ path: [k], message: `${k} は書き込みでは使えません` })),
    message: "domain・allowedOrigins・hosts は書き込みでは使えません。タグを置くドメインは domains で送ってください",
    hint: 'タグを置くドメインを 1 行ずつ domains に並べて送ってください。例: {"domains": ["www.example.com", "shop.example.com"]}。先頭の行が代表のドメインになり、受け付ける Origin と Cloudflare 経由のホストは一覧から決まります',
  });
}

export const SiteCreateSchema = z.strictObject({
  id: z.string().regex(SITE_ID_RE).optional(),
  name: z.string().min(1).max(100),
  domains: DomainsInput,
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
  domains: DomainsInput.optional(),
  mode: z.enum(["A", "B"]).optional(),
  idSource: z.string().optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  forgetOnRevoke: z.boolean().optional().describe("撤回時に訪問者プロフィールを削除する(既定 true)。Mode B では訪問者プロフィールの削除には効かない(retentionDays で消える)。結果を記録するサイトでは、その訪問者の結果の記録(参加・目標の達成)も削除する(Mode B を含む)。false は retentionDays(結果の記録は resultsRetentionDays)に委ねる"),
  timezone: z.string().min(1).max(64).optional().describe("曜日・時間帯の条件の判定に使うタイムゾーン(IANA 名。例: Asia/Tokyo)。変更は次の公開で効く"),
  // D9 ②(設計書 §6.6): 有効にするのは計測用 D1 がある導入だけ(無ければ PATCH のルートが 409 results_store_missing)
  resultsEnabled: z
    .boolean()
    .optional()
    .describe("結果を記録する(テストの参加と CV をツールの計測用データベースに残す)。切り替えは未公開の編集に数え、次の公開で効く。有効にした後に開始したテストだけが記録の対象になる"),
  resultsRetentionDays: z
    .number()
    .int()
    .min(7)
    .max(365)
    .optional()
    .describe("結果の個票(参加者ごとの記録)の保持期間(日、7〜365。既定 90)。収集を終えてからこの日数を過ぎた個票を消す。判定した結果は消えない"),
  // plan12 K10: KV の設定の記録にだけ載る(bootstrap には焼かない)ので、変えても公開も配信ファイルの出し直しも要らない
  newProfileBudgetPerDay: z
    .number()
    .int()
    .min(1)
    .max(100_000_000)
    .nullable()
    .optional()
    .describe("新しい訪問者の記録の上限(1 日あたり、1〜100,000,000)。履歴の条件を使うサイトで、1 日に新しく記録する訪問者の数の上限。超えた訪問者にもテストは表示されるが、その訪問の記録は残らない。1 時間あたりはこの値の 10% まで。null で使用状況の設定の Cloudflare のプランの既定(Free 20,000 / Paid 200,000)に戻す。Free では全サイトの合計にも 1 日 20,000 件の上限がある"),
  consentMode: z.enum(["implicit", "required"]).optional(),
  decisionTimeoutMs: z.number().int().optional(),
  visitorCookieName: z.string().optional(),
  uuidCookieEnabled: z.boolean().optional(),
  uuidCookieName: z.string().optional(),
  shareSubdomains: z
    .boolean()
    .optional()
    .describe("訪問者 ID の Cookie を、同じ登録ドメイン(例: example.com)のサブドメインのあいだで共有する(既定 true)。タグを置くドメイン(domains の開発用でない行)を登録ドメインごとにまとめ、まとまりごとに Domain 属性を付けて発行する。false はホストごとの Cookie。切り替えは設置タグの配信ファイルを作り直して反映する"),
  // 検証は core の AnalyticsSettingsSchema に委ねる(失敗を validation_failed ではなく 422 invalid_analytics で返すため、ここでは unknown)
  analytics: z.unknown().optional().describe("外部計測の名前(dataLayer の命名設定)。全フィールド optional、未指定は既定値。`dataLayerName` は push 先の配列の名前(既定 `dataLayer`。GTM のスニペットで名前を変えているサイトは同じ名前にする)。不正なら 422 invalid_analytics"),
  // 決定 34: 外部 ID(資格情報ではない)。null で消去。site-settings record には載せない
  ga4PropertyId: z.string().regex(/^\d{1,20}$/).nullable().optional(),
  bigqueryDataset: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]\.[A-Za-z0-9_]{1,1024}$/).nullable().optional(),
});
export type SitePatch = z.infer<typeof SitePatchSchema>;

type PrevName = { name: string; until: number };
const prevNames = (row: SiteRow): PrevName[] => JSON.parse(row.previous_cookie_names_json) as PrevName[];
type PrevDomain = { domain: string; until: number };
const prevDomains = (row: SiteRow): PrevDomain[] => JSON.parse(row.previous_cookie_domains_json) as PrevDomain[];

/**
 * B139 §3.6: 共有の範囲の前後を比べ、前の範囲の一覧を作り直す(previousCookieNames の扱いにならう)。
 * 期限切れを外し、消えた範囲を until 付きで足し、今の範囲を外す(edge / runtime が今の発行先を後始末で消さないように。
 * 「オン → オフ → オン」「まとまりの削除 → 再追加」でも Domain 付きの Cookie が 1 つ残り、ID を引き継ぐ)
 */
function nextPrevDomains(row: SiteRow, next: SiteRow, nowSec: number): PrevDomain[] {
  const before = deriveCookieScopes(row).scopes;
  const after = deriveCookieScopes(next).scopes;
  const until = nowSec + next.retention_days * 86400;
  const removed = before.filter((d) => !after.includes(d));
  const kept = prevDomains(row).filter((p) => p.until > nowSec && !removed.includes(p.domain));
  return [...kept, ...removed.map((domain) => ({ domain, until }))].filter((p) => !after.includes(p.domain));
}

/**
 * B139 §3.2: 印の Cookie(`<正本名>_js`。今の名前と旧名から作ったもの)と、ほかの Cookie 名がぶつかっていないか。ぶつかった名前を返す。
 * core の SiteSettingsSchema の refine と同じ規則を、KV の parse より前に 422 cookie_name_in_use で返すために見る
 */
function markerClash(next: SiteRow, previous: PrevName[]): string | null {
  const marker = markerCookieName(next.visitor_cookie_name);
  const oldMarkers = previous.map((p) => markerCookieName(p.name));
  const markers = [marker, ...oldMarkers];
  if (markers.includes(next.uuid_cookie_name)) return next.uuid_cookie_name;
  // 正本名が旧名の印と同じだと、旧名の後始末が今の ID を消す。今の印が旧名と同じだと、旧名の後始末が今の印を消す
  if (oldMarkers.includes(next.visitor_cookie_name)) return next.visitor_cookie_name;
  if (previous.some((p) => p.name === marker)) return marker;
  const ref = next.id_source.startsWith("cookie:") ? next.id_source.slice("cookie:".length) : null;
  if (ref !== null && markers.includes(ref)) return ref;
  return null;
}

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
  // Identity / Analytics 命名設定は KV 即時反映で Publish 不要。`content_updated_at` は Goal / オーディエンス(`touchSite`)と、タイムゾーン・結果の記録の切り替え(PATCH のルートが touchSite)だけが進める
  const next: SiteRow = { ...row, updated_at: nowMs };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.idSource !== undefined) next.id_source = patch.idSource;
  if (patch.domains !== undefined) {
    const checked = checkDomainList(patch.domains);
    if ("errors" in checked) return { next, error: invalidDomains(checked.errors.map((e) => ({ index: e.index, message: DOMAIN_ERROR_MESSAGES[e.reason] }))) };
    // 同じ値の前の行は判定と時刻を保つ。無ければ開発用は dev、ほかは unknown(Cloudflare 経由かの判定は別に行う)
    const previous = new Map((JSON.parse(row.domains_json) as DomainRow[]).map((d) => [d.value, d]));
    const rows = checked.rows.map((r): DomainRow => previous.get(r.value) ?? { value: r.value, verdict: r.dev ? "dev" : "unknown", checkedAt: null, triedAt: null });
    next.domains_json = JSON.stringify(rows);
  }
  if (patch.retentionDays !== undefined) next.retention_days = patch.retentionDays;
  if (patch.consentMode !== undefined) next.consent_mode = patch.consentMode;
  if (patch.decisionTimeoutMs !== undefined) next.decision_timeout_ms = patch.decisionTimeoutMs;
  if (patch.forgetOnRevoke !== undefined) next.forget_on_revoke = patch.forgetOnRevoke ? 1 : 0;
  if (patch.resultsEnabled !== undefined) next.results_enabled = patch.resultsEnabled ? 1 : 0;
  if (patch.resultsRetentionDays !== undefined) next.results_retention_days = patch.resultsRetentionDays;
  if (patch.newProfileBudgetPerDay !== undefined) next.new_profile_budget_per_day = patch.newProfileBudgetPerDay;
  if (patch.shareSubdomains !== undefined) next.share_subdomains = patch.shareSubdomains ? 1 : 0;
  // B148: 旧い 3 列は一覧と Mode からここでだけ導く(どの保存でも書き直すので、一覧と食い違わない。Mode を変えた保存も hosts が変わる)
  writeDerivedColumns(next);
  // B148(spec §6.4): 共有がオンなら、公開の接尾辞そのもの(co.jp・pages.dev など)の行は範囲を決められない。
  // 一覧を送った保存・作成と、共有をオンにする保存で断る(Task 2 review M4: 共有の切り替えだけの保存で抜けないように)
  if ((patch.domains !== undefined || row.share_subdomains !== 1) && next.share_subdomains === 1) {
    const suffixRows = (JSON.parse(next.domains_json) as DomainRow[])
      .map((d, index) => ({ d, index }))
      .filter(({ d }) => d.verdict !== "dev" && d.value !== "localhost" && !IPV4_RE.test(d.value) && registrableDomain(d.value) === null);
    if (suffixRows.length > 0) return { next, error: invalidDomains(suffixRows.map(({ index }) => ({ index, message: PUBLIC_SUFFIX_MESSAGE }))) };
  }
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
  const clash = markerClash(next, previous);
  if (clash !== null)
    return { next, error: new ApiError(422, "cookie_name_in_use", { name: clash, message: "この Cookie 名は使えません", hint: "訪問者 ID の Cookie 名(今の名前と保持期限内の旧名)の末尾に _js を付けた名前は、このツールが印として使うため、ほかの Cookie 名にできません" }) };
  // hosts・allowedOrigins・共有の切り替え・保持期間を反映した後で、前の共有の範囲を作り直す
  next.previous_cookie_domains_json = JSON.stringify(nextPrevDomains(row, next, nowSec));

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
    return { next, error: new ApiError(422, "mode_b_requires_id_source_ab", { message: "Mode B(サーバー発行 Cookie)と Mode C(BYOID)は併用できません", hint: "Mode B では「訪問者 ID の取得元」を ab(ツールが発行する ID)にしてください。サイトの既存の Cookie を使う場合は Mode A のままにします" }) };
  const error = settingsError(next);
  return error ? { next, error } : { next };
}

/** 一覧と Mode から旧い 3 列(domain・allowed_origins_json・hosts_json)を書く。書くのは applySitePatch と applyDomainRows だけ */
function writeDerivedColumns(next: SiteRow): void {
  const derived = deriveDomainColumns(JSON.parse(next.domains_json) as DomainRow[], next.mode);
  next.domain = derived.domain;
  next.allowed_origins_json = JSON.stringify(derived.allowedOrigins);
  next.hosts_json = JSON.stringify(derived.hosts);
}

/** core の SiteSettingsSchema の検査。通らなければ 422 invalid_settings */
function settingsError(next: SiteRow): ApiError | null {
  const parsed = SiteSettingsSchema.safeParse(settingsInput(next));
  if (parsed.success) return null;
  // 同上(invalid_analytics と同じ理由で validationFailed() 経由に変更。review r2 finding 2)
  const err = validationFailed(parsed.error, "invalid_settings");
  err.extra.hint = parsed.error.issues[0]?.message;
  err.extra.message = "サイト設定が不正です";
  return err;
}

/**
 * B148 Task 4: 判定の結果を当てた一覧の行(mergeProbeResults の rows)を applySitePatch の後の行に入れ、3 列を導き直して検査をもう一度通す。
 * 判定は行の値を変えず判定だけを変えるので、Cookie の共有の範囲(tagHosts は判定を見ない)と旧名の一覧は変わらない
 */
export function applyDomainRows(row: SiteRow, rows: DomainRow[]): { next: SiteRow; error?: ApiError } {
  const next: SiteRow = { ...row, domains_json: JSON.stringify(rows) };
  writeDerivedColumns(next);
  const error = settingsError(next);
  return error ? { next, error } : { next };
}

/**
 * B148 Task 4(Task 2 review M3): Mode A の間は判定しないので、A の間に保存されていた行の判定(A の前の edge など)は確かめていない扱いにする。
 * Mode を B にする保存が、判定の結果を当てる前に呼ぶ(確かめられなかった行が、前の edge のままホストに戻らないように)。開発用の行はそのまま
 */
export function resetVerdictsFromModeA(row: SiteRow): SiteRow {
  const rows = (JSON.parse(row.domains_json) as DomainRow[]).map((d): DomainRow => (d.verdict === "dev" ? d : { ...d, verdict: "unknown", checkedAt: null }));
  return { ...row, domains_json: JSON.stringify(rows) };
}

/** 一覧の行の誤りの文(利用者に見せる。どの行かは issues の path で返す) */
const DOMAIN_ERROR_MESSAGES: Record<DomainInputError | "duplicate" | "empty" | "too_many", string> = {
  path: "パス(/ より後ろ)・?・# は書けません。ホスト名だけを書いてください",
  wildcard: "* は使えません。ホスト名を 1 つずつ書いてください",
  not_domain: "ドメインの形ではありません。www.example.com の形で書いてください",
  duplicate: "同じドメインが既にあります",
  empty: "タグを置くドメインを 1 つ以上書いてください",
  too_many: `${MAX_DOMAINS} 行までです。使っていない行を消してください`,
};
const PUBLIC_SUFFIX_MESSAGE = "この行は公開の接尾辞なので、ID を共有する範囲を決められません。サブドメインまで書くか、共有をオフにしてください";
/** 一覧の値は HOST_RE を通っているので、IP は IPv4 の形だけ(IPv6 は開発用の Origin でしか書けない) */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 422 invalid_domains。issues は行ごと(index が null の誤りは一覧全体を指す)。path は先頭の issue */
function invalidDomains(items: { index: number | null; message: string }[]): ApiError {
  const issues = items.map((i) => ({ path: i.index === null ? ["domains"] : ["domains", i.index], message: i.message }));
  return new ApiError(422, "invalid_domains", {
    path: issues[0]?.path ?? ["domains"],
    message: "タグを置くドメインの一覧に直すところがあります",
    hint: issues[0]?.message,
    issues,
  });
}

function settingsInput(row: SiteRow): unknown {
  return {
    settingsVersion: 1, siteId: row.id, mode: row.mode, idSource: row.id_source,
    allowedOrigins: JSON.parse(row.allowed_origins_json), hosts: JSON.parse(row.hosts_json),
    visitorCookieName: row.visitor_cookie_name, uuidCookieEnabled: row.uuid_cookie_enabled === 1, uuidCookieName: row.uuid_cookie_name,
    previousCookieNames: prevNames(row),
    shareSubdomains: row.share_subdomains === 1, cookieDomains: deriveCookieScopes(row).scopes, previousCookieDomains: prevDomains(row),
    decisionTimeoutMs: row.decision_timeout_ms, consentMode: row.consent_mode,
    analytics: row.analytics_json ? JSON.parse(row.analytics_json) : DEFAULT_ANALYTICS,
    retentionDays: row.retention_days, // spec §8.3: DO の alarm 期限は record で edge に配送する(決定 37)
    forgetOnRevoke: row.forget_on_revoke === 1,
  };
}

/**
 * KV の Site の設定の記録に足す、siteToSettings(row) 以外の材料。
 * plan = 使用状況の設定の Cloudflare のプラン(新しい訪問者の予算の既定と導入全体の上限が決まる)、collectUntil = 収集の締め切りの表(D9 ③)
 */
export type SettingsExtras = { plan: CloudflarePlan; collectUntil: Record<string, number> };

/** 新しい訪問者の予算(plan12 K10)。サイトの上書きがあればそれ、無ければプランの既定。導入全体の上限は Free のときだけ(Paid は上限なし) */
export function newProfileBudgetOf(row: SiteRow, plan: CloudflarePlan): NewProfileBudget {
  return {
    perDay: row.new_profile_budget_per_day ?? NEW_PROFILE_BUDGET_DEFAULTS[plan],
    ...(plan === "free" ? { instancePerDay: NEW_PROFILE_INSTANCE_PER_DAY_FREE } : {}),
  };
}

/**
 * KV の Site の設定の記録の中身(書かない)。siteToSettings(row) に新しい訪問者の予算と、収集の締め切りの表(空なら項目を出さない)を足したもの。
 * **KV の settings 記録の組み立てはここだけ**(putSettingsRecord と、KV の記録を D1 と比べる Cron — results-collect-until・site-settings-refresh — が使う)。
 * siteToSettings(row) には足さない(bootstrap の焼き込み・デプロイ専用の Worker への入力・焼き直しの判定でも使うため)
 */
export function composeSettingsRecord(row: SiteRow, extras: SettingsExtras): SiteSettings {
  return {
    ...siteToSettings(row),
    newProfileBudget: newProfileBudgetOf(row, extras.plan),
    ...(Object.keys(extras.collectUntil).length > 0 ? { resultsCollectUntil: extras.collectUntil } : {}),
  };
}

/** composeSettingsRecord を JSON に通した形(KV に入る形。undefined の項目は消える)。KV の記録と canonicalJson で比べる Cron が使う */
export const settingsRecordForCompare = (row: SiteRow, extras: SettingsExtras): unknown => JSON.parse(JSON.stringify(composeSettingsRecord(row, extras)));

/**
 * KV の Site の設定の記録(kvKeys.settings)を書く唯一の口。composeSettingsRecord(row, extras) を put する。
 * putSiteRecords と、書き直し(results/collect-until.ts の rewriteCollectUntil・site-records.ts の refreshSiteRecords。host キーは変えない)が使う。
 * 例外はそのまま投げる。戻り値は書いた記録(hosts は siteToSettings(row) と同じ)
 */
export async function putSettingsRecord(env: Env, row: SiteRow, extras: SettingsExtras): Promise<SiteSettings> {
  const record = composeSettingsRecord(row, extras);
  await env.CONFIG_KV.put(kvKeys.settings(row.id), JSON.stringify(record));
  return record;
}

/**
 * spec §5.4「設定の配送」: settings record と、新しい hosts の host キーを KV に書く(activation = KV put)。**消さない**
 * B148 Task 4: `previousHosts`(前の行の hosts)を渡すと、その中に無かったホストのキーだけを書く(KV の書き込みは Free で 1 日 1,000 回。
 * 保存の正常の経路だけが渡す。戻しと作成は渡さず、今までどおり全部を書く)
 * (外した host のキーは D1 の確定の後に releaseHosts で消す。plan12 K14 (c))。
 * D9 ③(K11): run ごとの収集の締め切り(`collectUntilMap(db, siteId)` の表)と、plan12 K10: Cloudflare のプラン(新しい訪問者の予算の既定)を
 * extras で受けて settings に足して書く(composeSettingsRecord)。
 * KV の settings を書くのはこの関数と putSettingsRecord だけなので、呼び出し元は必ず今の表とプランを渡す(渡し忘れると Site の保存で締め切りか予算が消える)
 */
export async function putSiteRecords(env: Env, row: SiteRow, extras: SettingsExtras, opts: { previousHosts?: readonly string[] } = {}): Promise<void> {
  try {
    const settings = await putSettingsRecord(env, row, extras);
    for (const h of settings.hosts) if (!opts.previousHosts?.includes(h)) await env.CONFIG_KV.put(kvKeys.host(h), row.id);
  } catch (e) {
    // message は利用者向けの日本語文言に固定する(describeError がそのまま画面に出す)。生の例外文字列は detail に載せ、
    // errorHandler が 5xx をサーバー側にも記録する(routes/sites.ts の host_in_use と同じ形)
    throw new ApiError(503, "settings_write_failed", { message: "設定の保存に失敗しました", hint: "再試行してください", detail: String(e) });
  }
}

/**
 * 外した host の KV の mapping(`host:<h>`)を消す。**D1 の変更が確定した後**に呼ぶ(plan12 K14 (c))。
 * D1 の site_hosts でその host を持つ Site が**自 Site でも他 Site でも**無いときだけ、KV の値を読み、自 Site を指していれば消す。
 * 他の Site が D1 で持っていれば(別の Site が取った直後など)KV が古い値を返しても消さない。
 * 保証の範囲: D1 で確かめてから KV を消すまでの間に別の Site が取る競合は残る(KV に CAS が無いため)。
 * ホストのキーは新しいものだけを書く(putSiteRecords の previousHosts)ので、消えてしまったキーは、そのホストを一覧から外して足し直すまで戻らない(plan で受け入れた)。例外はそのまま投げる(呼び出し元が D1 確定後の扱いを決める)
 */
export async function releaseHosts(env: Env, db: Db, siteId: string, hosts: string[]): Promise<void> {
  if (hosts.length === 0) return;
  const owned = new Set((await db.selectFrom("site_hosts").select("host").where("host", "in", hosts).execute()).map((r) => r.host));
  for (const h of hosts) {
    if (owned.has(h)) continue;
    const cur = await env.CONFIG_KV.get(kvKeys.host(h));
    if (cur === siteId) await env.CONFIG_KV.delete(kvKeys.host(h));
  }
}

/**
 * Site 削除時の KV 後始末(settings / active / 予約済み version の config / 自 Site を指す host)。
 * **D1 の行を消した後**に呼ぶ(host は releaseHosts が D1 に持ち主が居ないことを確かめてから消す)
 */
export async function deleteSiteRecords(env: Env, db: Db, row: SiteRow, versions: number[]): Promise<void> {
  await env.CONFIG_KV.delete(kvKeys.settings(row.id));
  await env.CONFIG_KV.delete(kvKeys.active(row.id));
  for (const v of versions) await env.CONFIG_KV.delete(kvKeys.config(row.id, v));
  await releaseHosts(env, db, row.id, JSON.parse(row.hosts_json) as string[]);
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
