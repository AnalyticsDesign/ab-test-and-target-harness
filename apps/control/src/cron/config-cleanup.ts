// apps/control/src/cron/config-cleanup.ts
import { utcDay } from "@wtt/core";
import { cleanupOldVersions } from "../publish";
import { CURSOR_END as END, saveCursor } from "./cursor";
import { CronFrozen, type CronJob } from "./runner";

/**
 * plan12 K14 (b)(決定 63): 古い版の config(KV の `site:<sid>:config:v<N>`)の後始末を、公開の無い日にも回す日次のジョブ。
 * 公開のときの後始末(publishSite)は「直近 N 版」の保持をやめたので、公開が止まると退役した版(切り替えの 5 分の猶予が過ぎた版)が
 * 次の公開まで残る。active_version のある全サイトで cleanupOldVersions を呼び、配信中の版・配信ファイルが配る版以上・
 * 5 分以内に有効だった版以外の config を消す。
 * - KV が読めないサイト・配信ファイルが配る版がまだ分からないサイトは、cleanupOldVersions の fail-closed で何も消さない
 * - 消すのは wtt-control の KV なので writesControl: true。消す直前に凍結を確かめる(cleanupOldVersions の beforeDelete に
 *   ctx.assertNotFrozen を渡す。消す版が無いサイトでは確かめない)。削除の途中のサイト(static_removing)は触らない
 *
 * **配分**: 結果のジョブの配分表(runner.ts の allotQueries)を変えないよう queryShare は持たない(site-settings-refresh と同じ。登録は最後)。
 * そのかわり使う D1 のクエリを自分で数え(cleanupOldVersions が出した数を返す)、1 サイトの最大の見込み SITE_MAX + 位置の保存 1 件が
 * 残りに収まらなければ位置を保存して `{ more: true }` で次の実行に続ける。この確かめは**ジョブごと**: 配分を持たないジョブどうしは
 * 互いの使った数が見えないので、前の配分なしのジョブの分は残りに入らない(全体の上限 50 との差の余裕で受ける)。
 * 位置は cron_cursors の鍵 `config-cleanup`(日をまたいで引き継ぎ、末尾まで来たら END = その日は終わり)。
 * 版の数が多い 1 サイトの印付けは 50 版ごとに 1 件増えるが、その分は数えて次のサイトの前に確かめ直す(1 サイトの処理は途中で止めない)
 */
const NAME = "config-cleanup";
/** 1 回の実行で見るサイトの数 */
const PAGE = 10;
/** 1 サイトで出す D1 のクエリの見込み: sites の読み取り 1 + publishes の読み取り 1 + 凍結の確かめ 1 + 印付け 1 */
const SITE_MAX = 4;

export const configCleanupJob: CronJob = {
  name: NAME,
  cadence: { daily: { afterUtcHour: 1 } },
  writesControl: true,
  async run(ctx) {
    let used = 0;
    const fits = (n: number) => ctx.queries.use(used + n);
    // 位置の読み取り・サイトの一覧・位置の書き込みの 3 件(この確かめもジョブごと。ファイル先頭の「配分」の説明を参照)
    if (!fits(3)) return { more: true };

    const today = utcDay(ctx.now);
    used++;
    const saved = await ctx.env.DB.prepare("SELECT day, cursor FROM cron_cursors WHERE job = ?1").bind(NAME).first<{ day: string; cursor: string | null }>();
    // 位置は日をまたいで引き継ぐ。END はその日の終わりの印で、日が変わったら先頭から
    if (saved?.cursor === END && saved.day === today) return;
    const after = saved && saved.cursor !== END ? saved.cursor : null;

    used++;
    const rows = await ctx.db
      .selectFrom("sites")
      .select(["id", "active_version"])
      .where("active_version", "is not", null)
      .where("static_removing", "is", null)
      .$if(after !== null, (q) => q.where("id", ">", after!))
      .orderBy("id")
      .limit(PAGE)
      .execute();
    let position: string | null = after;
    for (const row of rows) {
      // このサイトの見込み + 位置の保存 1 件が収まらなければ、ここまでの位置を保存して次の実行に続ける
      if (!fits(SITE_MAX + 1)) {
        await saveCursor(ctx, NAME, position);
        return { more: true };
      }
      try {
        used += await cleanupOldVersions(ctx.env, ctx.db, row.id, row.active_version!, ctx.now, () => ctx.assertNotFrozen());
      } catch (e) {
        if (e instanceof CronFrozen) throw e;
        // 1 サイトの失敗はログに残して飛ばす(公開のときか翌日の実行がもう一度消す)。
        // 途中で投げたサイトが出した D1 の呼び出しは used に足されない(上限は SITE_MAX 件。CronFrozen は上で再送出して止まる)
        console.error(`cron ${NAME}: site ${row.id} failed; skipped`, e);
      }
      position = row.id;
    }
    // 1 ページ分を見終えた。満杯なら続きがあるかもしれない(次の実行で続きを読む。空なら END)
    const full = rows.length === PAGE;
    await saveCursor(ctx, NAME, full ? position : END);
    return full ? { more: true } : undefined;
  },
};
