import { sql } from "kysely";
import { extractManagedAssetUrls, extractUploaderSiteUrls } from "./asset-refs";
import { imageStore, uploaderPublicBase } from "./capabilities";
import type { Db, SiteRow } from "./db";
import type { Env } from "./env";
import type { StoredCompileInput } from "./publish";

/**
 * B68(spec §22.2・§22.3・§22.5): 公開する本体(compile した設定の JSON)の画像の確かめ。
 * 公開(`publishSite`)・状態を変える口の開始・再開(CAS の前)・公開の確認の画面が同じ関数を使う(止める操作の公開は使わない。Q266)。
 *
 * 取り出しは 2 つ。どちらも D1・DO を読まない:
 * - (a) 管理する画像の URL(`imageStore(env)` があるときだけ)
 * - (b) R2 なしの画像アップローダーの URL(`uploaderPublicBase(env)` があれば R2 の有無によらず。Q263)
 * 別のサイトの URL が 1 つでもあれば、D1 を読まずに `asset_other_site`。`readD1` のときだけ (a) の ID を `assets` で 1 回引き、
 * 印の無い行が無い ID があれば `asset_missing`。公開は `readD1: false` で呼び(成功の往復を増やさない)、返った `ids` を
 * 手順 4 の条件付きの UPDATE に渡す(0 行のときだけ `readD1: true` で呼び直して、無い画像を決める)
 */

export type AssetProblem = { url: string; reason: "missing" | "other_site"; experimentId: string; variantId: string; changeId: string };
export type AssetGuardError = "asset_missing" | "asset_other_site";
export type AssetGuardResult = { ok: true; ids: string[] } | { ok: false; error: AssetGuardError; assetProblems: AssetProblem[] };

/**
 * 問題の URL を含む変更を compile の入力から探す(Worker の中だけ。D1 は読まない。失敗のときだけ呼ぶ)。
 * 同じ URL を複数の変更が含めば、それぞれ 1 件。URL は本体にそのまま現れた文字列で、区切り・`"`・`\` を含まないので、
 * 変更の JSON(`JSON.stringify`)にも同じ形で現れる。変更の外(配信条件・目標・外部計測の値など)にだけある URL は載らない
 */
export function findAssetProblems(input: StoredCompileInput, found: ReadonlyArray<{ url: string; reason: AssetProblem["reason"] }>): AssetProblem[] {
  const out: AssetProblem[] = [];
  if (found.length === 0) return out;
  for (const e of input.experiments)
    for (const v of e.variants)
      for (const ch of v.changes) {
        const text = JSON.stringify(ch);
        for (const f of found) if (text.includes(f.url)) out.push({ url: f.url, reason: f.reason, experimentId: e.id, variantId: v.id, changeId: ch.id });
      }
  return out;
}

/** (a) の ID のうち、`assets` に印の無い行がある(削除待ちを含む)もの。D1 の 1 回(バインド 2 個) */
async function presentAssetIds(db: Db, siteId: string, ids: readonly string[]): Promise<Set<string>> {
  const r = await sql<{ id: string }>`
    SELECT id FROM assets WHERE site_id = ${siteId} AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) AND purge_marked_at IS NULL`.execute(db);
  return new Set(r.rows.map((x) => x.id));
}

export async function guardAssets(
  env: Env,
  db: Db,
  site: Pick<SiteRow, "id">,
  input: StoredCompileInput,
  body: string,
  opts: { readD1: boolean },
): Promise<AssetGuardResult> {
  const store = imageStore(env);
  const managed = store ? extractManagedAssetUrls(body, store.publicBase) : [];
  const uploader = extractUploaderSiteUrls(body, uploaderPublicBase(env));
  const other = [...managed, ...uploader].filter((u) => u.siteId !== site.id).map((u) => ({ url: u.url, reason: "other_site" as const }));
  if (other.length > 0) return { ok: false, error: "asset_other_site", assetProblems: findAssetProblems(input, other) };
  const ids = [...new Set(managed.map((u) => u.assetId))];
  if (!opts.readD1 || ids.length === 0) return { ok: true, ids };
  const present = await presentAssetIds(db, site.id, ids);
  const missing = managed.filter((u) => !present.has(u.assetId)).map((u) => ({ url: u.url, reason: "missing" as const }));
  if (missing.length === 0) return { ok: true, ids };
  return { ok: false, error: "asset_missing", assetProblems: findAssetProblems(input, missing) };
}

/** 確かめを当てる構成か(R2 もアップローダーの公開ベースも無い導入では、状態を変える口の CAS の前の確かめを飛ばす) */
export const assetGuardEnabled = (env: Env): boolean => imageStore(env) !== null || uploaderPublicBase(env) !== null;

/**
 * 公開の手順 4(設定の記録)の条件。`?ids` の画像がすべて、このサイトの `assets` に印の無い行としてある(空なら常に真)。
 * 止める操作の公開は `[]` を渡す(SQL を 2 つに分けない)
 */
export function configRecordUpdate(db: Db, rowId: string, siteId: string, hash: string, body: string, needsProfile: boolean, ids: readonly string[]) {
  const q = sql`
    UPDATE publishes SET config_hash = ${hash}, config_json = ${body}, needs_profile = ${needsProfile ? 1 : 0}
    WHERE id = ${rowId}
      AND NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(ids)}) j
                      WHERE NOT EXISTS (SELECT 1 FROM assets a
                                        WHERE a.site_id = ${siteId} AND a.id = j.value AND a.purge_marked_at IS NULL))`;
  return { compile: () => q.compile(db) };
}
