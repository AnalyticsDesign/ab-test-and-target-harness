// apps/control/src/cron/break-glass-sweep.ts
import { sql, type SqlBool } from "kysely";
import { auditStatement, systemActor } from "../audit";
import { passwordLoginOpen } from "../break-glass";
import { NOT_FROZEN_SQL } from "../write-freeze";
import type { CronJob } from "./runner";

/**
 * plan12 K13(決定 63 (9)・(13)(h)): 非常口(AB_BREAK_GLASS_TOKEN)が閉じている間、15 分ごとにパスワードの記録と、その持ち主のセッションを消す。
 * - 開いている間(passwordLoginOpen)は何もしない(D1 も読まない)
 * - 閉じていれば 1 つの batch(= 1 つのトランザクション)で、**パスワードの記録を持つ人のセッションを先に消し、次にパスワードの記録を消す**。
 *   パスワードのセッションはパスワードの記録を持つ人にしか無いので、いつ作られたセッションでも(この版より前・更新の途中を含む)
 *   閉じた後の最初の掃除で消える。セッションの記録の表は持たない。巻き込まれるのは、開いていた間にパスワードを設定した人の
 *   Google のセッション(1 回ログインし直す)。/setup はオーナーの乱数のパスワードの記録をその場で消す(オーナーを巻き込まない)
 * - 掃除の前に始まったパスワードのログインが掃除の後にセッションを作る競合は、auth.ts の session.create.after が断る
 *   (セッションの保存が batch より前なら batch が消し、後ならその確かめが消す)
 * - 消すのは wtt-control なので writesControl: true。書く直前に assertNotFrozen を呼び、2 つの文にも凍結の印が無いことを条件に入れる
 *   (確かめと batch の間に凍結が入っても消さない。Cron の書き込みの決まり)
 *
 * **配分**: 結果のジョブの配分表(runner.ts の allotQueries)を変えないよう queryShare は持たない(site-settings-refresh と同じ)。
 * 使う D1 のクエリは凍結の確かめ 1 + batch 1 の 2 件で、全体の残りに収まるかを ctx.queries.use で確かめ、足りなければ次の実行に回す
 * (登録は最後。前のジョブが使った残りの中で動く)
 *
 * B129(spec §3.1 の break_glass.sweep): batch の先頭に記録の 1 文を置く(同じ batch なのでクエリの数は変わらない)。
 * guard = 消すパスワードの記録がある + 凍結の印が無い(2 つの削除の文と同じ条件)。件数は削除の前に同じ文の中で、削除の文と同じ選び方で数える
 */
const NAME = "break-glass-sweep";

/** 凍結の確かめ(assertNotFrozen)1 + batch 1 */
const QUERIES = 2;

export const breakGlassSweep: CronJob = {
  name: NAME,
  cadence: { every: "tick" },
  writesControl: true,
  async run(ctx) {
    if (passwordLoginOpen(ctx.env)) return;
    if (!ctx.queries.use(QUERIES)) {
      console.log(`cron ${NAME}: no query budget left in this run; retrying on the next run`);
      return { more: true };
    }
    await ctx.assertNotFrozen();
    const credential = sql`select "userId" from account where "providerId" = 'credential'`;
    const [, sessions, accounts] = await ctx.env.DB.batch([
      auditStatement(
        ctx.env.DB,
        systemActor,
        {
          action: "break_glass.sweep",
          target: { type: "instance" },
          detail: {
            passwords: sql`(select count(*) from account where "providerId" = 'credential')`,
            sessions: sql`(select count(*) from session where "userId" in (${credential}))`,
          },
        },
        { guard: sql<SqlBool>`exists (${credential}) and ${sql.raw(NOT_FROZEN_SQL)}` },
      ),
      ctx.env.DB.prepare(`delete from session where "userId" in (select "userId" from account where "providerId" = 'credential') and ${NOT_FROZEN_SQL}`),
      ctx.env.DB.prepare(`delete from account where "providerId" = 'credential' and ${NOT_FROZEN_SQL}`),
    ]);
    const removedSessions = sessions?.meta.changes ?? 0;
    const removedPasswords = accounts?.meta.changes ?? 0;
    // 件数だけを出す(メールアドレス・user の ID は出さない)
    if (removedSessions > 0 || removedPasswords > 0) console.log(`cron ${NAME}: removed ${removedPasswords} password record(s) and ${removedSessions} session(s) of their holders`);
  },
};
