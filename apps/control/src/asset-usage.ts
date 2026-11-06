import { sql } from "kysely";
import { assetMaxMb, assetSiteMaxBytes, assetSiteMaxCount, assetUrlPrefix, compactAssetUrls } from "@wtt/core";
import type { AssetRow, Db } from "./db";
import type { Env } from "./env";
import { NOT_FROZEN_SQL } from "./write-freeze";

/**
 * 画像のライブラリ(B68、spec §4.1・§4.4・§6)の「使っているパターン」「使用中」と使用量。
 * 一覧の「使用中」と削除の可否は、**同じ 2 つの判定**から出す(一覧が「未使用」と出す画像は、押すと必ず削除待ちになる):
 * - 下書きの IMAGE の `src` と ATTRIBUTE の `src`(`name = 'src'` の `value`)の完全一致(`DRAFT_SRC_SQL` / `DRAFT_ATTR_SRC_SQL`)
 * - 公開したときの定義に使われている(`asset_delivered_refs` に行がある)
 * HTML・CSS の中の URL は見ない(猶予の後に Cron が画像の ID で見る)。
 * このファイルは Worker の外(Node の CPU の目安の計測)からも読むので、cloudflare: の import を置かない
 */

/** 削除待ちから消すまでの猶予(24 時間)。削除の応答の purgeAfter と、Cron の削除の段が使う */
export const ASSET_PURGE_GRACE_MS = 24 * 60 * 60 * 1000;

/** 下書きの変更で、画像を使っているかを見る種類 */
const DRAFT_USE_TYPES = ["IMAGE", "ATTRIBUTE"] as const;
/** 変更の本文の `src`(IMAGE の画像の URL) */
const DRAFT_SRC_SQL = "json_extract(payload_json, '$.src')";
/** ATTRIBUTE の `src` の値(属性の名前が `src` のときだけ。それ以外は NULL) */
const DRAFT_ATTR_SRC_SQL = "CASE WHEN json_extract(payload_json, '$.name') = 'src' THEN json_extract(payload_json, '$.value') END";

export type UsedBy = { experimentId: string; variantId: string };
export type UsageExperiment = { name: string; status: string; variants: Record<string, string> };
export type AssetUsageMaps = {
  /** 公開 URL → その URL を下書きの IMAGE・ATTRIBUTE の src で使っているパターン */
  usedByUrl: Map<string, UsedBy[]>;
  /** 画像の ID → 公開したときの定義で使っているエクスペリエンスの ID */
  deliveredByAssetId: Map<string, string[]>;
  /** usedBy・deliveredIn に出るエクスペリエンスの名前・状態・パターン名(1 回だけ置く) */
  experiments: Record<string, UsageExperiment>;
};

/** サイトの使用量(`count`・`bytes` は削除待ちを含む)と上限 */
export type AssetUsage = {
  count: number; bytes: number; pendingCount: number; pendingBytes: number;
  maxCount: number; maxBytes: number; maxFileBytes: number;
};
export type AssetLimits = Pick<AssetUsage, "maxCount" | "maxBytes" | "maxFileBytes">;
type UsageCounts = Pick<AssetUsage, "count" | "bytes" | "pendingCount" | "pendingBytes">;

export function assetLimits(env: Env): AssetLimits {
  return {
    maxCount: assetSiteMaxCount(env.AB_ASSET_SITE_MAX_COUNT),
    maxBytes: assetSiteMaxBytes(env.AB_ASSET_SITE_MAX_MB),
    maxFileBytes: Math.floor(assetMaxMb(env.AB_ASSET_MAX_MB) * 1024 * 1024),
  };
}

/** サイトの使用量を読む 1 文(書き込みと同じ `DB.batch` に入れて、書いた後の値を読むため) */
export function siteUsageQuery(db: Db, siteId: string) {
  return db
    .selectFrom("assets")
    .where("site_id", "=", siteId)
    .select([
      sql<number>`count(*)`.as("count"),
      sql<number>`coalesce(sum(size), 0)`.as("bytes"),
      sql<number>`count(deleted_at)`.as("pendingCount"),
      sql<number>`coalesce(sum(CASE WHEN deleted_at IS NOT NULL THEN size END), 0)`.as("pendingBytes"),
    ]);
}

/** `siteUsageQuery` の batch の結果 → 使用量(行が無い・数でない値は 0) */
export function usageFromResult(result: D1Result | undefined, limits: AssetLimits): AssetUsage {
  const r = (result?.results?.[0] ?? {}) as Partial<Record<keyof UsageCounts, unknown>>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { count: num(r.count), bytes: num(r.bytes), pendingCount: num(r.pendingCount), pendingBytes: num(r.pendingBytes), ...limits };
}

export const emptyUsage = (limits: AssetLimits): AssetUsage => ({ count: 0, bytes: 0, pendingCount: 0, pendingBytes: 0, ...limits });

type DraftUseRow = { experiment_id: string; variant_id: string; src: unknown; attr: unknown; experiment_name: string; status: string; variant_name: string };
type DeliveredRow = { asset_id: string; experiment_id: string; experiment_name: string; status: string };

/** 下書きの使い方を読む 1 文。`url` を渡すとその URL だけ(削除の 409 の読み直し) */
function draftUses(siteId: string, url?: string) {
  const onlyUrl = url === undefined ? sql`` : sql` AND (${sql.raw(DRAFT_SRC_SQL)} = ${url} OR ${sql.raw(DRAFT_ATTR_SRC_SQL)} = ${url})`;
  return sql<DraftUseRow>`
    SELECT c.experiment_id, c.variant_id, ${sql.raw(DRAFT_SRC_SQL.replace("payload_json", "c.payload_json"))} AS src,
           ${sql.raw(DRAFT_ATTR_SRC_SQL.replaceAll("payload_json", "c.payload_json"))} AS attr,
           e.name AS experiment_name, e.status AS status, v.name AS variant_name
    FROM changes c
    JOIN experiments e ON e.site_id = c.site_id AND e.id = c.experiment_id
    JOIN variants v ON v.site_id = c.site_id AND v.experiment_id = c.experiment_id AND v.id = c.variant_id
    WHERE c.site_id = ${siteId} AND c.type IN (${sql.join(DRAFT_USE_TYPES.map((t) => sql.lit(t)))})${onlyUrl}
    ORDER BY c.experiment_id, v.position, c.variant_id`;
}

/** 公開したときの定義の使い方を読む 1 文。`assetId` を渡すとその画像だけ */
function deliveredUses(siteId: string, assetId?: string) {
  const onlyAsset = assetId === undefined ? sql`` : sql` AND r.asset_id = ${assetId}`;
  return sql<DeliveredRow>`
    SELECT r.asset_id, r.experiment_id, e.name AS experiment_name, e.status AS status
    FROM asset_delivered_refs r
    JOIN experiments e ON e.site_id = r.site_id AND e.id = r.experiment_id
    WHERE r.site_id = ${siteId}${onlyAsset}
    ORDER BY r.experiment_id`;
}

/** 2 つの読みの行 → 使い方の表(純関数。一覧の組み立ての CPU の目安もこれを通す) */
export function buildUsageMaps(draftRows: readonly DraftUseRow[], deliveredRows: readonly DeliveredRow[]): AssetUsageMaps {
  const usedByUrl = new Map<string, UsedBy[]>();
  const seen = new Set<string>();
  // エクスペリエンスの ID は利用者が決める(`constructor` などもありうる)ので、prototype の無い表にする
  const experiments: Record<string, UsageExperiment> = Object.create(null);
  const experimentOf = (id: string, name: string, status: string): UsageExperiment => {
    let e = experiments[id];
    if (e === undefined) {
      e = { name, status, variants: Object.create(null) as Record<string, string> };
      experiments[id] = e;
    }
    return e;
  };
  for (const r of draftRows) {
    let used = false;
    for (const url of [r.src, r.attr]) {
      if (typeof url !== "string" || url === "") continue;
      // 同じパターンの複数の変更・src と ATTRIBUTE の両方で同じ URL を使っていても 1 回だけ数える
      const k = `${url}\u0000${r.experiment_id}\u0000${r.variant_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const list = usedByUrl.get(url);
      const entry = { experimentId: r.experiment_id, variantId: r.variant_id };
      if (list) list.push(entry);
      else usedByUrl.set(url, [entry]);
      used = true;
    }
    if (used) experimentOf(r.experiment_id, r.experiment_name, r.status).variants[r.variant_id] = r.variant_name;
  }
  const deliveredByAssetId = new Map<string, string[]>();
  for (const r of deliveredRows) {
    const list = deliveredByAssetId.get(r.asset_id);
    if (list) list.push(r.experiment_id);
    else deliveredByAssetId.set(r.asset_id, [r.experiment_id]);
    experimentOf(r.experiment_id, r.experiment_name, r.status);
  }
  return { usedByUrl, deliveredByAssetId, experiments };
}

/** サイトの画像の使い方(下書き = D1 1 回・公開したときの定義 = D1 1 回。並べて読む) */
export async function listAssetUsage(db: Db, siteId: string): Promise<AssetUsageMaps> {
  const [draft, delivered] = await Promise.all([draftUses(siteId).execute(db), deliveredUses(siteId).execute(db)]);
  return buildUsageMaps(draft.rows, delivered.rows);
}

/**
 * 1 枚の画像の使い方(削除が 0 行のときの 409 の読み直し。一覧と同じ条件)。
 * 下書き・公開したときの定義の 2 文を 1 つの `DB.batch` で読む(D1 の呼び出し 1 回)
 */
export async function assetUsageOf(env: Env, db: Db, siteId: string, asset: Pick<AssetRow, "id" | "public_url">): Promise<{ usedBy: UsedBy[]; deliveredIn: string[]; experiments: Record<string, UsageExperiment> }> {
  const stmt = (q: { sql: string; parameters: readonly unknown[] }) => env.DB.prepare(q.sql).bind(...q.parameters);
  const [draft, delivered] = await env.DB.batch([stmt(draftUses(siteId, asset.public_url).compile(db)), stmt(deliveredUses(siteId, asset.id).compile(db))]);
  const maps = buildUsageMaps((draft?.results ?? []) as DraftUseRow[], (delivered?.results ?? []) as DeliveredRow[]);
  return { usedBy: maps.usedByUrl.get(asset.public_url) ?? [], deliveredIn: maps.deliveredByAssetId.get(asset.id) ?? [], experiments: maps.experiments };
}

/**
 * 削除待ちの印を付ける 1 文(判定と印を 1 文で行い、読んだ後に使われ始めるのを防ぐ)と、使用量の読みを 1 つの `DB.batch` で流す。
 * 下書きの IMAGE・ATTRIBUTE の src・公開したときの定義のどれかに使われていれば 0 行。凍結中も 0 行(入口の関門より後に凍結が入ったとき)。
 * 判定は同じサイトの中だけ。R2 には触れない
 */
export async function markAssetPendingDeletion(
  env: Env,
  db: Db,
  siteId: string,
  assetId: string,
  uid: string,
  now = Date.now(),
  /** 同じ batch の後ろに足す文(B129: 操作の記録。印と同じトランザクションで書く) */
  extra: readonly D1PreparedStatement[] = [],
): Promise<{ marked: boolean; usage: AssetUsage }> {
  // 先に行を読まない(往復を増やさない): 公開 URL は相関の部分問い合わせで更新する行の assets.public_url を直接見る
  const update = db
    .updateTable("assets")
    .set({ deleted_at: now, deleted_by: uid, kept_at: null, updated_at: now })
    .where("site_id", "=", siteId)
    .where("id", "=", assetId)
    .where("deleted_at", "is", null)
    .where(
      sql<boolean>`NOT EXISTS (SELECT 1 FROM changes WHERE changes.site_id = assets.site_id AND changes.type IN (${sql.join(DRAFT_USE_TYPES.map((t) => sql.lit(t)))})
        AND (${sql.raw(DRAFT_SRC_SQL.replace("payload_json", "changes.payload_json"))} = assets.public_url
             OR ${sql.raw(DRAFT_ATTR_SRC_SQL.replaceAll("payload_json", "changes.payload_json"))} = assets.public_url))`,
    )
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM asset_delivered_refs r WHERE r.site_id = assets.site_id AND r.asset_id = assets.id)`)
    .where(sql.raw<boolean>(NOT_FROZEN_SQL));
  const c = update.compile();
  const u = siteUsageQuery(db, siteId).compile();
  const [written, used] = await env.DB.batch([env.DB.prepare(c.sql).bind(...c.parameters), env.DB.prepare(u.sql).bind(...u.parameters), ...extra]);
  return { marked: (written?.meta.changes ?? 0) > 0, usage: usageFromResult(used, assetLimits(env)) };
}

/** 一覧の行(作った人の名前を join したもの) */
export type AssetListRow = AssetRow & { creator_name: string | null };
export type AssetJson = {
  id: string; name: string; publicUrl: string; thumbnailUrl: string | null; thumbnail: AssetRow["thumb_state"];
  mime: string; size: number; width: number | null; height: number | null;
  createdAt: number; createdBy: { id: string; name: string | null };
  usedBy: UsedBy[]; deliveredIn: string[]; inUse: boolean; keptAt: number | null;
};

/**
 * 一覧・アップロード・名前の変更の 1 件の形。縮小版は R2 にできている(ready)ときだけ URL を出す。
 * Images の binding が無い導入では、作り待ち(pending)を skipped として出す(作る仕組みが無く、待っても変わらないため)
 */
export function assetJson(row: AssetListRow, publicBase: string, imagesOn: boolean, uses: { usedBy: UsedBy[]; deliveredIn: string[] }): AssetJson {
  const thumbnail = !imagesOn && row.thumb_state === "pending" ? "skipped" : row.thumb_state;
  return {
    id: row.id,
    name: row.name,
    publicUrl: row.public_url,
    thumbnailUrl: thumbnail === "ready" && row.thumb_key ? `${publicBase}/${row.thumb_key}` : null,
    thumbnail,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    createdBy: { id: row.created_by, name: row.creator_name },
    usedBy: uses.usedBy,
    deliveredIn: uses.deliveredIn,
    inUse: uses.usedBy.length > 0 || uses.deliveredIn.length > 0,
    keptAt: row.kept_at,
  };
}

/**
 * 一覧の 1 件。1 件の応答(`AssetJson`)から `publicUrl`・`thumbnailUrl` を外し、上の段の `urlPrefix` と `path` で URL を表す
 * (I5: 1,000 枚で応答が大きくなりすぎないように。戻し方は @wtt/core の `assetItemUrls`)。
 * 公開ベースを後から変えた導入の前の画像は `path` の代わりに `publicUrl`、縮小版の URL が決まった形でない件だけ `thumbnailUrl` が入る
 */
export type AssetListItem = Omit<AssetJson, "publicUrl" | "thumbnailUrl" | "createdBy"> & {
  path?: string; publicUrl?: string; thumbnailUrl?: string | null;
  /**
   * 作った人。上の段の `creators` の添字(整数)。ID と名前は表に 1 回だけ置く(名前は最大 100 字、ユーザー ID は 32 字で、
   * 各件に繰り返すと 1,000 枚で応答が膨らむため。B68 Q331: ID を各件に持たせた形は本番の 1,000 枚で 600,000 B を超えた)
   */
  creator: number;
};
/** 作った人の表の 1 行。作った人のユーザーが消えていれば name は null */
export type AssetCreator = { id: string; name: string | null };
export type AssetListJson = {
  urlPrefix: string | null;
  assets: AssetListItem[];
  /** 一覧に出る画像を作った人(一覧に最初に出た順。各件の creator が添字) */
  creators: AssetCreator[];
  experiments: Record<string, UsageExperiment>;
  usage: AssetUsage;
};

/** 1 件の形 → 一覧の 1 件の形(キーの順は 1 件の形のまま、URL の 2 つの位置に path などを置き、createdBy の位置に表の添字を置く) */
function listItemOf(a: AssetJson, urlPrefix: string, creator: number): AssetListItem {
  const { id, name, publicUrl, thumbnailUrl, createdBy: _createdBy, ...rest } = a;
  const { mime, size, width, height, createdAt, ...after } = rest;
  return {
    id, name, ...compactAssetUrls(urlPrefix, { id, thumbnail: a.thumbnail, publicUrl, thumbnailUrl }),
    mime, size, width, height, createdAt, creator, ...after,
  };
}

/**
 * 一覧の応答を組み立てる(純関数)。行はそのサイトの全部(削除待ちを含む。新しい順)。
 * 使用量は行から数え(追加の読みをしない)、`assets` は削除待ちを除く。`experiments` は一覧に出る画像が使うものだけ
 */
export function buildAssetList(
  rows: readonly AssetListRow[],
  maps: AssetUsageMaps,
  opts: { siteId: string; publicBase: string; imagesOn: boolean; limits: AssetLimits },
): AssetListJson {
  const urlPrefix = assetUrlPrefix(opts.publicBase, opts.siteId);
  const usage = emptyUsage(opts.limits);
  const assets: AssetListItem[] = [];
  // 作った人の表(配列)と、ID → 添字。ID は Map のキーなので prototype の名前の ID でも混ざらない
  const creators: AssetCreator[] = [];
  const creatorIndex = new Map<string, number>();
  const shown = new Set<string>();
  for (const row of rows) {
    usage.count++;
    usage.bytes += row.size;
    if (row.deleted_at !== null) {
      usage.pendingCount++;
      usage.pendingBytes += row.size;
      continue;
    }
    const usedBy = maps.usedByUrl.get(row.public_url) ?? [];
    const deliveredIn = maps.deliveredByAssetId.get(row.id) ?? [];
    for (const u of usedBy) shown.add(u.experimentId);
    for (const e of deliveredIn) shown.add(e);
    let creator = creatorIndex.get(row.created_by);
    if (creator === undefined) {
      creator = creators.push({ id: row.created_by, name: row.creator_name }) - 1;
      creatorIndex.set(row.created_by, creator);
    }
    assets.push(listItemOf(assetJson(row, opts.publicBase, opts.imagesOn, { usedBy, deliveredIn }), urlPrefix, creator));
  }
  const experiments: Record<string, UsageExperiment> = Object.create(null);
  for (const id of shown) {
    const e = maps.experiments[id];
    if (e !== undefined) experiments[id] = e;
  }
  return { urlPrefix, assets, creators, experiments, usage };
}
