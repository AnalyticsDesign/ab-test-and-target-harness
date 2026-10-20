// apps/control/src/cron/site-settings-refresh.ts
import { utcDay } from "@wtt/core";
import { readCloudflarePlan } from "../instance-settings";
import { collectUntilMaps } from "../results/collect-until";
import { CURSOR_END as END, saveCursor } from "./cursor";
import { CronFrozen, type CronContext, type CronJob } from "./runner";
import { syncSettingsRecord } from "./sync-settings-record";

/**
 * plan12 K10(決定 63): KV の Site の設定の記録を、D1 + 使用状況の設定の Cloudflare のプランから組み立て直した記録と**全体で**比べ、
 * 違うサイトだけを書き直す日次のジョブ(違わなければ put しない)。次の 3 つを直す。
 * - この機能を deploy した直後の既存サイトの記録に、新しい訪問者の予算を入れる
 * - プランの変更の書き直し(routes/usage.ts)が途中で止まった分
 * - 残る競合(CL-Medium-11): KV に CAS が無いので、PATCH /sites/:sid の KV の put と D1 の確定の間に書き直し(プランの変更・
 *   rewriteCollectUntil)が D1 を読むと、古い行で組み立てた記録が KV に残りうる。最大 1 日で D1 の値に戻る
 *
 * 組み立ては composeSettingsRecord(= 締め切りの表も D1 から組み立て直すので、D9 ③ の resultsCollectUntil は消えない)。
 * results-collect-until(15 分ごと)も同じ組み立てで比べるので、書き合わない。
 *
 * **配分**: 結果のジョブの配分表(runner.ts の allotQueries)を変えないよう queryShare は持たない(配分の外)。そのかわり
 * 1 回に見るサイトを PAGE 件までにし、使う D1 のクエリ(位置の読み書き・プラン・サイトの一覧・締め切りの表 + 書き直す前の凍結の確かめ)を
 * 数えて ctx.queries.use で全体の残りに収まるか確かめる。足りなければ位置を保存して `{ more: true }`(同じ日の次の実行で続ける)。
 * 位置は cron_cursors の鍵 `site-settings-refresh`(日をまたいで引き継ぎ、末尾まで来たら END = その日は終わり・翌日は先頭から)。KV の読み書きも 1 回の呼び出しで出せる数に上限があるので PAGE で抑える
 */

const NAME = "site-settings-refresh";
/** 1 回の実行で見るサイトの数 */
const PAGE = 10;

export const siteSettingsRefreshJob: CronJob = {
  name: NAME,
  cadence: { daily: { afterUtcHour: 0 } },
  writesControl: true,
  async run(ctx) {
    // 自分が出した D1 のクエリの数(配分を持たないジョブなので runner は数えない)。全体の残りに収まるかを毎回確かめる
    let used = 0;
    const fits = (n: number) => ctx.queries.use(used + n);
    // 位置の読み取り・プラン・サイトの一覧・締め切りの表 + 位置の書き込みの 5 件
    if (!fits(5)) return { more: true };

    const today = utcDay(ctx.now);
    used++;
    const saved = await ctx.env.DB.prepare("SELECT day, cursor FROM cron_cursors WHERE job = ?1").bind(NAME).first<{ day: string; cursor: string | null }>();
    // 位置は日をまたいで引き継ぐ(1 日で回り切れない多数のサイトでも、末尾まで届く)。END はその日の終わりの印で、日が変わったら先頭から
    if (saved?.cursor === END && saved.day === today) return;
    const after = saved && saved.cursor !== END ? saved.cursor : null;

    used++;
    const plan = await readCloudflarePlan(ctx.db);
    used++;
    // 削除の途中のサイトは書かない(KV を消している最中に書き戻さない)
    const rows = await ctx.db
      .selectFrom("sites")
      .selectAll()
      .where("static_removing", "is", null)
      .$if(after !== null, (q) => q.where("id", ">", after!))
      .orderBy("id")
      .limit(PAGE)
      .execute();
    let position: string | null = after;
    if (rows.length > 0) {
      used++;
      const tables = await collectUntilMaps(ctx.db, rows.map((r) => r.id));
      for (const row of rows) {
        // 書き直す前の凍結の確かめ 1 + 位置の書き込み 1 が収まらなければ、ここまでの位置を保存して次の実行に続ける
        if (!fits(2)) {
          await savePosition(ctx, position);
          return { more: true };
        }
        try {
          // 比べ方・書き方は results-collect-until と同じ関数(互いに上書きし合わない保証はこの共有に依る)。書くときだけ凍結の確かめの D1 が 1 件
          if (await syncSettingsRecord(ctx, row, { plan, collectUntil: tables.get(row.id) ?? {} })) used++;
        } catch (e) {
          if (e instanceof CronFrozen) throw e;
          // 1 件の失敗はログに残して飛ばす(翌日の実行か、プランの変更・results-collect-until の書き直しが直す)
          console.error(`cron ${NAME}: site ${row.id} failed; skipped`, e);
        }
        position = row.id;
      }
    }
    // 1 ページ分を見終えた。満杯なら続きがあるかもしれない(次の実行で続きを読む。空なら END)
    const full = rows.length === PAGE;
    await savePosition(ctx, full ? position : END);
    return full ? { more: true } : undefined;
  },
};

/** 位置を保存する(凍結の印が無いときだけ書く。0 行なら凍結 = CronFrozen) */
const savePosition = (ctx: CronContext, cursor: string | null): Promise<void> => saveCursor(ctx, NAME, cursor);
