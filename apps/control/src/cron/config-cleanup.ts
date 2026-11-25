// apps/control/src/cron/config-cleanup.ts
import { utcDay } from "@wtt/core";
import { cleanupOldVersions, type CleanupResult } from "../publish";
import { DAILY_EXPIRY_ROWS, dailyExpiryBatch, EXPIRY_CURSOR_JOB, RESERVED_TTL_MS } from "../publish-expiry";
import { publishBodyKeep, prunePublishBodies, readPrunedToday, PUBLISH_BODY_SITE_CAP, PUBLISH_BODY_DAILY_CAP, PUBLISH_BODY_COUNTER_JOB } from "../publish-body-retention";
import { activeNeedsMark, markActiveMismatches } from "./active-marker";
import { CURSOR_END as END, saveCursor } from "./cursor";
import { CronFrozen, type CronJob } from "./runner";

/**
 * plan12 K14 (b)(決定 63): 古い版の config(KV の `site:<sid>:config:v<N>`)の後始末を、公開の無い日にも回す日次のジョブ。
 * 公開のときの後始末(publishSite)は「直近 N 版」の保持をやめたので、公開が止まると退役した版(切り替えの 5 分の猶予が過ぎた版)が
 * 次の公開まで残る。active_version のある全サイトで cleanupOldVersions を呼び、配信中の版・配信ファイルが配る版以上・
 * 5 分以内に有効だった版以外の config を消す。掃除が読んだ KV active と D1 の版を照合し、食い違えば修復の印を立てる。
 * その後、本体を残す版数を超えた古い公開の本体も掃除する。
 * - KV が読めないサイト・配信ファイルが配る版がまだ分からないサイトは、cleanupOldVersions の fail-closed で何も消さない
 * - 消すのは wtt-control の KV なので writesControl: true。消す直前に凍結を確かめる(cleanupOldVersions の beforeDelete に
 *   ctx.assertNotFrozen を渡す。消す版が無いサイトでは確かめない)。削除の途中のサイト(static_removing)は触らない
 *
 * **配分**: 結果のジョブの配分表(runner.ts の allotQueries)を変えないよう queryShare は持たない(site-settings-refresh と同じ。登録は最後)。
 * そのかわり使う D1 のクエリを自分で数え(cleanupOldVersions が出した数を返す)、1 サイトの開始に必要な見込み SITE_MAX + 位置の保存 1 件が
 * 残りに収まらなければ位置を保存して `{ more: true }` で次の実行に続ける。この確かめは**ジョブごと**: 配分を持たないジョブどうしは
 * 互いの使った数が見えないので、前の配分なしのジョブの分は残りに入らない(D1 の 1 回の呼び出しの上限 1,000 との差の余裕で受ける)。
 * 本体の 1 日の数は cron_cursors の config-cleanup:body-prune。batch 内で上限を守り、応答を失っても二重に数えない。
 * 位置は cron_cursors の鍵 `config-cleanup`(日をまたいで引き継ぎ、末尾まで来たら END = その日は終わり)。
 * 版の数が多い 1 サイトの印付けは 50 版ごとに 1 件増えるが、その分は数えて次のサイトの前に確かめ直す(1 サイトの処理は途中で止めない)
 */
const NAME = "config-cleanup";
/** 1 回の実行で見るサイトの数 */
const PAGE = 10;
/** sites 1 + publishes 1 + KV 削除前の凍結 1 + 印 1 + 本体の凍結 1 + 本体 batch 1。照合の追加 2 と、削除済みの印が 50 版ごとに増える分は、照合・本体の前に残りを確かめ直す */
const SITE_MAX = 6;

export function summarizePruneTimes(stmts: Array<number | null>): { maxMs: number | null; totalMs: number | null } {
  if (stmts.some((n) => n === null)) return { maxMs: null, totalMs: null };
  return { maxMs: stmts.reduce<number>((m, n) => Math.max(m, n!), 0), totalMs: stmts.reduce<number>((s, n) => s + n!, 0) };
}

export function configCleanupJobWith(o: { siteCap?: number; dailyCap?: number } = {}): CronJob {
  const siteCap = o.siteCap ?? PUBLISH_BODY_SITE_CAP;
  const dailyCap = o.dailyCap ?? PUBLISH_BODY_DAILY_CAP;
  return {
    name: NAME,
    cadence: { daily: { afterUtcHour: 1 } },
    writesControl: true,
    async run(ctx) {
      let used = 0;
      const fits = (n: number) => ctx.queries.use(used + n);
      const keepCount = publishBodyKeep(ctx.env.AB_PUBLISH_BODY_KEEP);
      let sites = 0, kvDeleted = 0, pruned = 0, prunedToday = 0, rowsWritten = 0, rowsRead = 0;
      let unknown = 0, withinKeep = 0, overCap = 0, overBudget = 0, afterFailure = 0;
      let failed = false;
      let sizeAfter: number | null = null;
      const stmtTimes: Array<number | null> = [];
      try {
        // 位置と日次の数を 1 往復で読む。サイト一覧・位置保存と合わせて初めの見込みは従来と同じ 3。
        if (!fits(3)) return { more: true };
        const today = utcDay(ctx.now);
        used++;
        const cursors = await ctx.env.DB.prepare("SELECT job, day, cursor FROM cron_cursors WHERE job IN (?1, ?2, ?3)")
          .bind(NAME, PUBLISH_BODY_COUNTER_JOB, EXPIRY_CURSOR_JOB).all<{ job: string; day: string; cursor: string | null }>();
        const saved = cursors.results.find((r) => r.job === NAME);
        prunedToday = readPrunedToday(cursors.results.find((r) => r.job === PUBLISH_BODY_COUNTER_JOB), ctx.now);
        const expiry = cursors.results.find(r => r.job === EXPIRY_CURSOR_JOB);
        let expiryPending = !expiry || expiry.day < today;
        if (expiryPending && fits(3)) {
          used += 3;
          const position = expiry?.cursor === END ? null : expiry?.cursor;
          const page = await ctx.env.DB.prepare(`select id from publishes where id > ?1 and status = 'reserved'
            and created_at < ?2 order by id limit ?3`)
            .bind(position ?? "", ctx.now - RESERVED_TTL_MS, DAILY_EXPIRY_ROWS).all<{ id: string }>();
          await ctx.assertNotFrozen();
          const result = await ctx.env.DB.batch(dailyExpiryBatch(ctx.env, page.results.map(r => r.id), ctx.now));
          if (result.at(-1)?.results.length) throw new CronFrozen();
          expiryPending = false;
        }
        // 位置は日をまたいで引き継ぐ。END はその日の終わりの印で、日が変わったら先頭から
        if (saved?.cursor === END && saved.day === today) return expiryPending ? { more: true } : undefined;
        if (!fits(2)) return { more: true }; // サイト一覧と位置の保存
        const after = saved && saved.cursor !== END ? saved.cursor : null;
        used++;
        const rows = await ctx.db.selectFrom("sites").select(["id", "active_version", "last_activated_at"])
          .where("active_version", "is not", null).where("static_removing", "is", null)
          .$if(after !== null, (q) => q.where("id", ">", after!)).orderBy("id").limit(PAGE).execute();
        let position: string | null = after;
        for (const row of rows) {
          if (!fits(SITE_MAX + 1)) {
            await saveCursor(ctx, NAME, position);
            return { more: true };
          }
          sites++;
          let cleanup: CleanupResult | undefined;
          try {
            cleanup = await cleanupOldVersions(ctx.env, ctx.db, row.id, row.active_version!, ctx.now, () => ctx.assertNotFrozen());
            used += cleanup.queries;
            kvDeleted += cleanup.deleted;
          } catch (e) {
            if (e instanceof CronFrozen) throw e;
            // 例外になったサイトが使った問い合わせは従来と同じく used に含まれない。
            console.error(`cron ${NAME}: site ${row.id} failed; skipped`, e);
          }
          const kv = cleanup?.kvActive;
          if (kv !== undefined && (row.last_activated_at ?? 0) <= ctx.now - 2 * 60_000 && activeNeedsMark(kv, row.active_version!)) {
            // 次回もこのサイトから照合できるよう、済んだサイトの位置だけを保存する。
            if (!fits(2 + 1)) {
              await saveCursor(ctx, NAME, position);
              return { more: true };
            }
            used += 2;
            await ctx.assertNotFrozen();
            await markActiveMismatches(ctx.env.DB, new Map([[row.id, { version: row.active_version!, kv }]]), NAME);
          }
          // KV の掃除とは try を分け、本体の失敗が後続サイトの KV の掃除を止めないようにする。
          // 見送りの理由は、もともと消さないサイト(守る版が不明・保持の数以下)を先に数える
          if (!cleanup || cleanup.keep === null) unknown++;
          else if (row.active_version! <= keepCount) withinKeep++;
          else if (failed) afterFailure++;
          else if (prunedToday >= dailyCap) overCap++;
          // KV の掃除は 50 版ごとに印の文が増え、SITE_MAX の見込みを超えうる。本体の 2 + 位置の保存 1 が残りに収まらなければ、
          // このサイトの本体は送らない(次の日の回で消す。位置は進めるので、KV の削除が失敗し続けるサイトでも回が止まらない)
          else if (!fits(2 + 1)) overBudget++;
          else {
            try {
              used += 2; // 凍結の読み取り + batch(2 文で 1 往復)。失敗時も安全側に数える。
              await ctx.assertNotFrozen();
              const r = await prunePublishBodies(ctx.env, ctx.db, { siteId: row.id, keep: cleanup.keep, keepCount, siteCap, dailyCap, runId: crypto.randomUUID(), now: ctx.now });
              pruned += r.pruned;
              prunedToday = r.prunedToday;
              rowsWritten += r.rowsWritten;
              rowsRead += r.rowsRead;
              stmtTimes.push(...r.stmtMs);
              sizeAfter = r.sizeAfter;
            } catch (e) {
              if (e instanceof CronFrozen) throw e;
              failed = true; // commit の成否が不明。残りの本体は次の実行へ送り、日次枠を推測しない。
              stmtTimes.push(null);
              console.error(`cron ${NAME}: site ${row.id} failed pruning bodies; skipped`, e);
            }
          }
          position = row.id;
        }
        const full = rows.length === PAGE;
        await saveCursor(ctx, NAME, full ? position : END);
        return full || expiryPending ? { more: true } : undefined;
      } finally {
        const times = summarizePruneTimes(stmtTimes);
        console.log(`cron ${NAME}: sites ${sites}, kv deleted ${kvDeleted}, bodies pruned ${pruned} (today ${prunedToday} of ${dailyCap}, keep ${keepCount}), skipped ${unknown} unknown / ${withinKeep} within keep / ${overCap} over the daily cap / ${overBudget} over the run budget / ${afterFailure} after a prune failure, rows_written ${rowsWritten}, rows_read ${rowsRead}, prune stmt ms max ${times.maxMs ?? "unknown"} total ${times.totalMs ?? "unknown"}, size_after ${sizeAfter ?? "unknown"}`);
      }
    },
  };
}

export const configCleanupJob = configCleanupJobWith();
