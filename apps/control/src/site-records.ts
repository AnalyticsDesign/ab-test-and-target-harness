import type { Db } from "./db";
import type { Env } from "./env";
import type { CloudflarePlan } from "./instance-settings";
import { collectUntilMaps } from "./results/collect-until";
import { putSettingsRecord } from "./site-settings";

/**
 * 全サイトの KV の Site の設定の記録を、D1 + 指定のプランから組み立て直して書く(host キーは変えない)。
 * 使用状況の設定でプランを変えたとき、その場で呼ぶ(プランで新しい訪問者の予算の既定が変わるため)。戻り値は書き直したサイトの数。
 *
 * - 削除の途中のサイト(static_removing)は書かない(KV を消している最中に書き戻さない。results-collect-until と同じ)
 * - 1 サイトの失敗は記録して次へ進める(書けなかった分は翌日の site-settings-refresh が直す)。Workers の 1 回の呼び出しで出せる
 *   外部への呼び出しの数には上限があるので、サイトが多い導入では途中で打ち切られうるが、同じ理由で Cron が残りを直す
 * - 締め切りの表は全サイト分を 1 回の読み取りで求める(サイトごとに読まない)
 */
export async function refreshSiteRecords(env: Env, db: Db, plan: CloudflarePlan): Promise<number> {
  const rows = await db.selectFrom("sites").selectAll().where("static_removing", "is", null).orderBy("id").execute();
  const tables = await collectUntilMaps(db);
  let written = 0;
  for (const row of rows) {
    try {
      await putSettingsRecord(env, row, { plan, collectUntil: tables.get(row.id) ?? {} });
      written++;
    } catch (e) {
      console.error(`site record refresh failed for ${row.id} (site-settings-refresh retries daily)`, e);
    }
  }
  return written;
}
