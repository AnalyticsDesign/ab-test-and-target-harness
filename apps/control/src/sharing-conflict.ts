// B139(spec §6.4・Q23・Q28・Q29): 訪問者 ID の Cookie の共有の衝突の検査と、共有の予約(sharing_claims)と、既存のサイトの共有の自動の移行。
// 衝突 = 同じ導入の中で、同じ登録ドメインのドメインを持つ 2 つのサイトが、「どちらかがその登録ドメインで共有している(今の範囲か、期限の中の前の範囲)」で、
// 「Cookie の名前(正本・UUID・印・期限の中の旧名)のどれかが重なる」こと。Cookie はワークスペースの区切りを知らないので、検査は導入全体で行う
import { kvKeys, markerCookieName } from "@wtt/core";
import { deriveCookieScopes, registrableDomain, tagHosts } from "./cookie-scope";
import { syncSettingsRecord } from "./cron/sync-settings-record";
import { getDb, type Db, type SiteRow } from "./db";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { readCloudflarePlan } from "./instance-settings";
import { collectUntilMaps } from "./results/collect-until";
import { siteToSettings } from "./site-settings";
import { bootstrapSettingsChanged } from "./static-delivery";
import { isWriteFrozen, NOT_FROZEN_SQL } from "./write-freeze";

type PrevName = { name: string; until: number };
type PrevDomain = { domain: string; until: number };

/** 衝突の相手。otherShares = ぶつかった登録ドメインで相手が共有している(作成の調整で、名前を変えるか共有をオフにするかを決める) */
export type SharingConflict = { siteId: string; workspaceId: string; domain: string; otherShares: boolean; otherNames: string[] };

/** 予約 1 行(登録ドメイン × Cookie の名前)。until = 前の範囲・旧名の期限(epoch 秒)。今の範囲 × 今の名前は null */
export type Claim = { domain: string; cookieName: string; until: number | null };

/** 期限(epoch 秒)を足し合わせる。null(期限なし)が勝ち、ほかは遅い方 */
function putUntil(map: Map<string, number | null>, key: string, until: number | null): void {
  const cur = map.get(key);
  if (cur === null) return;
  if (until === null || cur === undefined || until > cur) map.set(key, until);
}

/**
 * サイトが使う Cookie の名前と期限。正本・印(`<正本名>_js`)・UUID(有効なとき)は null。期限の中の旧名と、その印(旧名の後始末が消す)は旧名の期限。
 * 旧名の印も入れるのは、core の SiteSettingsSchema が旧名の印を名前の空間に数え、旧名の後始末が前の範囲から消すため
 */
export function cookieNamesOf(row: SiteRow, nowSec: number): Map<string, number | null> {
  const out = new Map<string, number | null>();
  putUntil(out, row.visitor_cookie_name, null);
  putUntil(out, markerCookieName(row.visitor_cookie_name), null);
  if (row.uuid_cookie_enabled === 1) putUntil(out, row.uuid_cookie_name, null);
  for (const p of JSON.parse(row.previous_cookie_names_json) as PrevName[]) {
    if (p.until <= nowSec) continue;
    putUntil(out, p.name, p.until);
    putUntil(out, markerCookieName(p.name), p.until);
  }
  return out;
}

/**
 * サイトの登録ドメイン。all = 照合元(タグを置くホストの登録ドメイン ∪ 期限の中の前の範囲。共有がオフでもホスト限定の Cookie を拾いうるので入れる)。
 * shared = Domain 付きの Cookie を書く(書いた)範囲(共有がオンなら今の範囲 = null、期限の中の前の範囲 = その期限)
 */
function domainsOf(row: SiteRow, nowSec: number): { all: Set<string>; shared: Map<string, number | null> } {
  const shared = new Map<string, number | null>();
  for (const d of deriveCookieScopes(row).scopes) putUntil(shared, d, null);
  for (const p of JSON.parse(row.previous_cookie_domains_json) as PrevDomain[]) if (p.until > nowSec) putUntil(shared, p.domain, p.until);
  const tag = tagHosts(row)
    .map(registrableDomain)
    .filter((d): d is string => d !== null);
  return { all: new Set([...tag, ...shared.keys()]), shared };
}

/** 今の名前(正本・その印・UUID(有効なとき))。どの登録ドメインでも照合する */
const currentNames = (names: Map<string, number | null>): Set<string> => new Set([...names].filter(([, u]) => u === null).map(([n]) => n));

/**
 * candidate と other の衝突。ぶつかる登録ドメインのうち、相手が共有しているものを優先して返す。
 * 2026-10-29 ユーザー決定(Q32): 旧名(期限の中の旧い正本名・UUID 名と、その印)は、そのサイトが共有している登録ドメイン
 * (shared = 共有オンの今の範囲 ∪ 期限の中の前の範囲)でだけ照合する。旧名の後始末が Domain 付きで消すのは共有した範囲だけで、
 * ホスト限定でしか居ないドメインでは旧名は他のサイトの Cookie に触れないため。今の名前はどのドメインでも照合する。
 * このため、オフのサイトが名前を変えると衝突は解ける。名前を変えたサイトが同じ範囲で共有を始められるのは旧名の期限の後
 */
function conflictBetween(candidate: SiteRow, other: SiteRow, nowSec: number): SharingConflict | null {
  const mine = cookieNamesOf(candidate, nowSec);
  const theirs = cookieNamesOf(other, nowSec);
  const mineNow = currentNames(mine);
  const theirsNow = currentNames(theirs);
  const a = domainsOf(candidate, nowSec);
  const b = domainsOf(other, nowSec);
  let found: SharingConflict | null = null;
  for (const domain of a.all) {
    if (!b.all.has(domain) || !(a.shared.has(domain) || b.shared.has(domain))) continue;
    // このドメインで照合する名前: 共有している側は旧名も、ホスト限定でしか居ない側は今の名前だけ
    const minesHere = a.shared.has(domain) ? new Set(mine.keys()) : mineNow;
    const theirsHere = b.shared.has(domain) ? new Set(theirs.keys()) : theirsNow;
    if (![...minesHere].some((n) => theirsHere.has(n))) continue;
    const otherShares = b.shared.has(domain);
    if (found === null || (otherShares && !found.otherShares))
      found = { siteId: other.id, workspaceId: other.workspace_id, domain, otherShares, otherNames: [...theirsHere] };
    if (otherShares) break;
  }
  return found;
}

/** others の中で candidate とぶつかるサイトをすべて返す(candidate 自身は除く) */
export function conflictsAmong(candidate: SiteRow, others: readonly SiteRow[], nowSec: number): SharingConflict[] {
  return others.filter((o) => o.id !== candidate.id).flatMap((o) => conflictBetween(candidate, o, nowSec) ?? []);
}

/** D1 の全サイト(candidate 自身を除く)の中で candidate とぶつかるもの */
export async function findSharingConflicts(db: D1Database, candidate: SiteRow, nowSec: number): Promise<SharingConflict[]> {
  const { results } = await db.prepare("SELECT * FROM sites WHERE id != ?1").bind(candidate.id).all<SiteRow>();
  return conflictsAmong(candidate, results, nowSec);
}

/** 保存の前の検査(spec §6.4・Q23)。ぶつかる相手を 1 つ(相手が共有しているものを優先)返す。無ければ null */
export async function findSharingConflict(db: D1Database, candidate: SiteRow, nowSec: number): Promise<SharingConflict | null> {
  const all = await findSharingConflicts(db, candidate, nowSec);
  return all.find((c) => c.otherShares) ?? all[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// 予約(Q28)

/**
 * サイトの予約(共有している範囲 × Cookie の名前。今の名前と期限の中の旧名)。共有がオフで前の範囲も無いサイトは空。
 * Q32 の照合の規則と同じ形: 旧名を照合するのは共有している範囲だけなので、予約も共有している範囲にだけ旧名を入れる
 * (ホスト限定でしか居ないサイトとの今の名前の衝突は、保存の前の検査で見る)
 */
export function claimsOf(row: SiteRow, nowSec: number): Claim[] {
  const { shared } = domainsOf(row, nowSec);
  const names = cookieNamesOf(row, nowSec);
  const out: Claim[] = [];
  for (const [domain, du] of shared)
    for (const [cookieName, nu] of names) out.push({ domain, cookieName, until: du === null ? nu : nu === null ? du : Math.min(du, nu) });
  return out;
}

const claimKey = (c: Pick<Claim, "domain" | "cookieName">): string => `${c.domain}\n${c.cookieName}`;

/** 予約の集合に足すもの(範囲 × 名前の組)があるか。ある保存は D1 を先に確定してから KV を書く */
export function claimsGrow(before: readonly Claim[], after: readonly Claim[]): boolean {
  const had = new Set(before.map(claimKey));
  return after.some((c) => !had.has(claimKey(c)));
}

/**
 * サイトの保存の D1 batch に入れる予約の文(この順で入れる)。
 * (1) 同じ組の期限切れの行を消す(どのサイトのものでも。期限切れの解放を持ち主の保存に頼らない)→ (2) 自分の予約を消す → (3) 新しい予約を入れる。
 * (3) の主キーの違反で batch が落ちたら衝突(isClaimConflict)。
 * pendingOnly = 共有の自動の移行用: サイトがまだ移行の対象(share_migration_pending = 1)で、凍結していないときだけ書く。
 * orIgnore = KV の失敗で D1 を戻すとき用(戻す間に他のサイトが取った組は飛ばす)
 */
export function claimStatements(
  d1: D1Database,
  siteId: string,
  claims: readonly Claim[],
  nowSec: number,
  opts: { pendingOnly?: boolean; orIgnore?: boolean } = {},
): D1PreparedStatement[] {
  const pairs = JSON.stringify(claims.map((c) => [c.domain, c.cookieName, c.until]));
  // 移行の対象のときだけ書く条件。n = サイト ID の引数の番号(D1 は使わない引数の bind を断るので、文ごとに番号を合わせる)
  const guard = (n: number) => (opts.pendingOnly ? ` AND EXISTS (SELECT 1 FROM sites WHERE id = ?${n} AND share_migration_pending = 1) AND ${NOT_FROZEN_SQL}` : "");
  const pairsIn = "(domain, cookie_name) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2))";
  const expired = d1.prepare(`DELETE FROM sharing_claims WHERE until IS NOT NULL AND until <= ?1 AND ${pairsIn}${guard(3)}`);
  return [
    opts.pendingOnly ? expired.bind(nowSec, pairs, siteId) : expired.bind(nowSec, pairs),
    d1.prepare(`DELETE FROM sharing_claims WHERE site_id = ?1${guard(1)}`).bind(siteId),
    d1
      .prepare(
        `INSERT${opts.orIgnore ? " OR IGNORE" : ""} INTO sharing_claims (domain, cookie_name, site_id, until)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?1, json_extract(value, '$[2]') FROM json_each(?2) WHERE 1 = 1${guard(1)}`,
      )
      .bind(siteId, pairs),
  ];
}

/** batch の失敗が予約の主キーの違反か(D1 の例外の文に表と制約の名前が入る) */
export const isClaimConflict = (e: unknown): boolean => /UNIQUE constraint failed: sharing_claims\./.test(String(e));

/** 予約に負けたとき、claims のどれかを持つ別のサイト(期限の中)。見つからなければ null(その間に解放された) */
export async function claimHolder(db: D1Database, siteId: string, claims: readonly Claim[], nowSec: number): Promise<SharingConflict | null> {
  const pairs = JSON.stringify(claims.map((c) => [c.domain, c.cookieName]));
  const row = await db
    .prepare(
      `SELECT c.site_id AS siteId, s.workspace_id AS workspaceId, c.domain AS domain FROM sharing_claims c JOIN sites s ON s.id = c.site_id
       WHERE c.site_id != ?1 AND (c.until IS NULL OR c.until > ?3)
         AND (c.domain, c.cookie_name) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2)) LIMIT 1`,
    )
    .bind(siteId, pairs, nowSec)
    .first<{ siteId: string; workspaceId: string; domain: string }>();
  return row ? { ...row, otherShares: true, otherNames: [] } : null;
}

// ---------------------------------------------------------------------------------------------
// 422 sharing_conflict の封筒

/** 保存(PATCH)で衝突したときの案内 */
export const SHARING_CONFLICT_HINT =
  "このサイトの訪問者 ID の Cookie 名を変えると解けます(共有をオフにしても、相手が共有していれば解けません)。名前を変えたサイトがその登録ドメインで共有を始められるのは、旧い名前の保持期間が過ぎてからです";
/** 作成で、自動の調整の後にも衝突が残ったとき(同時の作成で予約に負けた・その名前が手で付けられていた)の案内(Q29) */
export const SHARING_CONFLICT_CREATE_HINT = "もう一度作ってください。続くときは、訪問者 ID の Cookie 名を指定して作ってください";
/** 相手のサイトを見る権限が無いとき(別のワークスペース)。サイト名と ID を出さない */
const HIDDEN_MESSAGE = "同じ導入の別のワークスペースのサイトと、訪問者 ID の Cookie がぶつかります";

/**
 * 422 sharing_conflict。visibleName = 保存する人が見られる相手のサイト名(見られなければ null。名前も ID も出さない)。
 * domain = ぶつかった登録ドメイン(相手が分からないとき — 予約に負けた後に解放された — は null)
 */
export function sharingConflictError(domain: string | null, visibleName: string | null, hint: string): ApiError {
  const message = visibleName !== null ? `サイト「${visibleName}」と、訪問者 ID の Cookie がぶつかります` : HIDDEN_MESSAGE;
  return new ApiError(422, "sharing_conflict", { path: ["shareSubdomains"], ...(domain !== null ? { domain } : {}), message, hint });
}

// ---------------------------------------------------------------------------------------------
// 作成のときの調整(Q29)

/** Cookie 名の上限(core の CookieName) */
const COOKIE_NAME_MAX = 64;

/** 作成で衝突したときに付ける名前: `<接頭辞>_<サイト ID>`。64 字を超えるなら `<接頭辞>_<サイト ID の SHA-256 の先頭 16 字>` */
export async function siteScopedCookieName(prefix: string, siteId: string): Promise<string> {
  const plain = `${prefix}_${siteId}`;
  if (plain.length <= COOKIE_NAME_MAX) return plain;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(siteId)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------------------------
// 共有の自動の移行(一度きり)

/** 1 回の呼び出しで処理するサイトの数 */
export const MIGRATION_PAGE = 25;

/** 移行の途中で凍結に気づいた(そこで止める。続きは次の Cron) */
class MigrationFrozen extends Error {}

type MigrateOutcome = "on" | "off" | "skipped";

/**
 * 既存のサイト(share_migration_pending = 1)のうち、衝突しないものだけを共有オンにする一度きりの処理。control の Cron が毎回の最初に呼ぶ。
 * - 完了の印(KV の meta:install)があれば何もしない(利用者がオンにした・オフにした設定を変えない)
 * - 1 回に MIGRATION_PAGE 件まで。進み具合は D1 の share_migration_pending(処理したサイトは同じ batch で 0 にする)。
 *   止まっても、残りは次の呼び出しが続きから進める
 * - 衝突するサイト・設定を共有の形にできないサイトはオフのまま(印だけ 0 にする)
 * - オンにするサイトは、通常の保存と同じく同じ batch で予約を入れる。主キーの違反(移行の途中に利用者が同じ範囲で共有を始めた)はオフのまま
 * - オンにする batch が落ちたサイトは、オフのまま印を 0 にする(ログに残す。失敗し続けるサイトで移行が終わらなくならない)。
 *   印を 0 にする書き込み自体が落ちたときだけ印は 1 のまま残り、次の呼び出しで試し直す。凍結に気づいたらそこで止める
 * - 完了の印が既にあれば書き換えない
 * - KV の設定の記録は、オンにしたサイトだけを syncSettingsRecord(違うときだけ書く。host のキーは書かない)で書き直す。
 *   配信ファイルは、公開中の版があり bootstrap に焼く設定が変わるなら、同じ文で作り直しの印を立てる(static-reconcile と GET が拾う)
 */
export async function migrateSharing(env: Env, db: D1Database, nowSec: number): Promise<{ done: boolean; turnedOn: string[] }> {
  if ((await env.CONFIG_KV.get(kvKeys.installMarker)) !== null) return { done: true, turnedOn: [] };
  const page = (await db.prepare("SELECT * FROM sites WHERE share_migration_pending = 1 ORDER BY id LIMIT ?1").bind(MIGRATION_PAGE).all<SiteRow>()).results;
  if (page.length === 0) return finishMigration(env, []);

  const dbEnv: Env = { ...env, DB: db };
  const kdb = getDb(dbEnv);
  const assertNotFrozen = async () => {
    if (await isWriteFrozen(kdb)) throw new MigrationFrozen();
  };
  const turnedOn: string[] = [];
  try {
    await assertNotFrozen();
    // 照合はメモリの上で行い、この呼び出しでオンにしたサイトを後のサイトの照合に反映する
    const sites = new Map((await db.prepare("SELECT * FROM sites").all<SiteRow>()).results.map((r) => [r.id, r]));
    for (const row of page) {
      try {
        const outcome = await migrateOne(db, kdb, row, [...sites.values()], nowSec);
        if (outcome === "on") {
          turnedOn.push(row.id);
          sites.set(row.id, { ...row, share_subdomains: 1, share_migration_pending: 0 });
        }
      } catch (e) {
        // ここに来るのは、オフのまま残す書き込み(印を 0 にする)自体が落ちたときだけ。印は 1 のまま次の呼び出しで試し直す
        if (e instanceof MigrationFrozen) throw e;
        console.error(`sharing migration: site ${row.id} failed; retried on the next run`, e);
      }
    }
    if (turnedOn.length > 0) {
      const rows = (await db.prepare("SELECT * FROM sites WHERE id IN (SELECT value FROM json_each(?1)) AND static_removing IS NULL").bind(JSON.stringify(turnedOn)).all<SiteRow>()).results;
      const plan = await readCloudflarePlan(kdb);
      const tables = await collectUntilMaps(kdb, rows.map((r) => r.id));
      for (const row of rows) {
        try {
          await syncSettingsRecord({ env: dbEnv, assertNotFrozen }, row, { plan, collectUntil: tables.get(row.id) ?? {} });
        } catch (e) {
          if (e instanceof MigrationFrozen) throw e;
          // D1 は確定済み。KV は site-settings-refresh・results-collect-until が D1 と比べて直す
          console.error(`sharing migration: settings record of site ${row.id} was not rewritten`, e);
        }
      }
    }
  } catch (e) {
    if (e instanceof MigrationFrozen) return { done: false, turnedOn };
    throw e;
  }
  if (page.length === MIGRATION_PAGE) return { done: false, turnedOn };
  // 飛ばしたサイト(印が 1 のまま)が残っていれば、次の呼び出しで試し直す
  if ((await db.prepare("SELECT 1 AS x FROM sites WHERE share_migration_pending = 1 LIMIT 1").first()) !== null) return { done: false, turnedOn };
  return finishMigration(env, turnedOn);
}

/** 完了の印を書く。既にあれば書き換えない(B148 の判定が照合に使う値なので、別の実行が書いた値を上書きしない) */
async function finishMigration(env: Env, turnedOn: string[]): Promise<{ done: boolean; turnedOn: string[] }> {
  if ((await env.CONFIG_KV.get(kvKeys.installMarker)) === null) await env.CONFIG_KV.put(kvKeys.installMarker, crypto.randomUUID());
  return { done: true, turnedOn };
}

/** 1 サイトの移行。利用者が途中で共有を選んだ(印が 0 になった)サイトは書かない(skipped) */
async function migrateOne(db: D1Database, kdb: Db, row: SiteRow, sites: readonly SiteRow[], nowSec: number): Promise<MigrateOutcome> {
  const leaveOff = async (): Promise<MigrateOutcome> => {
    const r = await db.prepare(`UPDATE sites SET share_migration_pending = 0 WHERE id = ?1 AND share_migration_pending = 1 AND ${NOT_FROZEN_SQL}`).bind(row.id).run();
    if ((r.meta.changes ?? 0) > 0) return "off";
    if (await isWriteFrozen(kdb)) throw new MigrationFrozen();
    return "skipped";
  };
  // 削除の途中のサイトはオンにしない
  if (row.static_removing !== null) return leaveOff();
  const candidate: SiteRow = { ...row, share_subdomains: 1 };
  let staticChanged: boolean;
  try {
    siteToSettings(candidate);
    staticChanged = row.active_version !== null && bootstrapSettingsChanged(row, candidate);
  } catch {
    // 今の設定が今の規則で読めない(印の名前の規則に反する旧名など)。衝突と同じくオフのまま残す(秘密は出さない)
    console.warn(`sharing migration: site ${row.id} has settings that cannot be shared; left unshared`);
    return leaveOff();
  }
  if (conflictsAmong(candidate, sites, nowSec).length > 0) return leaveOff();
  let results: D1Result[];
  try {
    results = await db.batch([
      ...claimStatements(db, row.id, claimsOf(candidate, nowSec), nowSec, { pendingOnly: true }),
      db
        .prepare(
          `UPDATE sites SET share_subdomains = 1, share_migration_pending = 0${staticChanged ? ", static_seq = static_seq + 1, static_stale = 1" : ""}
           WHERE id = ?1 AND share_migration_pending = 1 AND ${NOT_FROZEN_SQL}`,
        )
        .bind(row.id),
    ]);
  } catch (e) {
    // 主キーの違反 = 移行の途中に、利用者が同じ範囲・同じ名前で別のサイトの共有を始めた。オフのまま残す。
    // それ以外の失敗も、設定を読めないサイトと同じくオフのまま印を 0 にする(失敗し続けるサイトが移行を止めないように)
    if (!isClaimConflict(e)) console.warn(`sharing migration: turning sharing on failed for site ${row.id}; left unshared`, e);
    return leaveOff();
  }
  if ((results.at(-1)?.meta.changes ?? 0) > 0) return "on";
  if (await isWriteFrozen(kdb)) throw new MigrationFrozen();
  return "skipped";
}
