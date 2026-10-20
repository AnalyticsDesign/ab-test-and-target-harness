// apps/control/src/cron/cursor.ts
import { utcDay } from "@wtt/core";
import { NOT_FROZEN_SQL } from "../write-freeze";
import { CronFrozen, type CronContext } from "./runner";

/** 日の終わりの印(その日はもう回さない)。位置は cron_cursors の鍵(ジョブ名)ごとに 1 行 */
export const CURSOR_END = "#end";

/**
 * 日をまたいで引き継ぐ位置(cron_cursors)を保存する(凍結の印が無いときだけ書く 1 文。0 行なら凍結 = CronFrozen)。
 * 書き込みのときの日付は ctx.now の UTC の日。site-settings-refresh と config-cleanup が使う(位置の持ち方を揃える)
 */
export async function saveCursor(ctx: CronContext, job: string, cursor: string | null): Promise<void> {
  const r = await ctx.env.DB.prepare(
    `INSERT INTO cron_cursors (job, day, cursor) SELECT ?1, ?2, ?3 WHERE ${NOT_FROZEN_SQL}
     ON CONFLICT (job) DO UPDATE SET day = excluded.day, cursor = excluded.cursor`,
  )
    .bind(job, utcDay(ctx.now), cursor)
    .run();
  if ((r.meta?.changes ?? 0) === 0) throw new CronFrozen();
}
