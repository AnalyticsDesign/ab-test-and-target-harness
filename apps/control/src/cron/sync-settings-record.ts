// apps/control/src/cron/sync-settings-record.ts
import { kvKeys } from "@wtt/core";
import type { SiteRow } from "../db";
import { canonicalJson } from "../results/delivered";
import { putSettingsRecord, settingsRecordForCompare, type SettingsExtras } from "../site-settings";
import type { CronContext } from "./runner";

/**
 * KV の Site の設定の記録を、D1 + extras から組み立てた記録と**全体で**比べ、違えば書き直す(違わなければ put しない)。書いたかを返す。
 *
 * results-collect-until(15 分ごと・D9 ③)と site-settings-refresh(日次・plan12 K10)と、共有の自動の移行(B139 の migrateSharing)が**この 1 つの関数**を使う。
 * 2 つのジョブが互いの記録を上書きし合わない保証は「比べ方と組み立てが同一」であることに依存するので、ここ以外で比べ方を書かない。
 * - 読めない・無い記録は書き直す
 * - 書く直前に ctx.assertNotFrozen()(凍結中は CronFrozen。呼び出し側のジョブはそこで止まる)
 * - D1 のクエリは書くときの凍結の確かめ 1 件だけ(KV は数えない)。締め切りの表・プランは呼び出し側が渡す
 */
export async function syncSettingsRecord(ctx: Pick<CronContext, "env" | "assertNotFrozen">, row: SiteRow, extras: SettingsExtras): Promise<boolean> {
  const raw = await ctx.env.CONFIG_KV.get(kvKeys.settings(row.id));
  let current: unknown = null;
  try {
    current = raw === null ? null : JSON.parse(raw);
  } catch {
    current = null; // 読めない記録は書き直す
  }
  // 記録の全体を比べる(締め切りの表だけでなく、Site の PATCH と書き直しが重なって古い設定が残った場合も直す)
  if (current !== null && canonicalJson(current) === canonicalJson(settingsRecordForCompare(row, extras))) return false;
  await ctx.assertNotFrozen();
  await putSettingsRecord(ctx.env, row, extras);
  return true;
}
