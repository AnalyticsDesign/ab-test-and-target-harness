// apps/control/src/cron/asset-housekeeping.ts
import { ASSET_PURGE_GRACE_MS } from "../asset-usage";
import { imageStore } from "../capabilities";
import {
  makeThumbnail, parseQuotaUntil, quotaMarkReadStatement, quotaMarkWriteStatement, thumbAttemptStatement, thumbKey,
} from "../thumbnails";
import { NOT_FROZEN_SQL } from "../write-freeze";
import { CronFrozen, type CronContext, type CronJob } from "./runner";

/**
 * B68(spec §5.3・§6.1・§22.1): 画像の後始末の Cron ジョブ(15 分ごと)。1 回の流れ = 凍結の確かめ → 削除の段 → 縮小版の段。
 * 削除を先にするのは、消す画像の縮小版を作らずに済むため。R2 が無ければジョブごと何もしない。Images の binding が無ければ縮小版の段だけ何もしない。
 *
 * **削除の段**(最大 ASSET_PURGE_PER_TICK 枚。D1 の往復は枚数・サイトの数によらず最大 3):
 * 1. 墓標(印 `purge_marked_at` があり、前の回に R2 を消せなかった行)と猶予の過ぎた削除待ちを 1 回で読む(墓標が先)
 * 2. 猶予の過ぎた画像ごとに「印」と「戻し」の 2 文をこの順に並べ、全部を 1 つの DB.batch で流す。印は、下書きのすべての変更・
 *    訪問者に届きうる版の config_json・公開したときの定義(asset_delivered_refs)のどこにも画像の ID がそのまま現れないときだけ付く。
 *    戻しは印が付かなかったとき(= 使われていた)だけ一覧に戻す。どちらも凍結の条件を持つ(凍結なら両方 0 行で、次の回にやり直す)
 * 3. 印の付いた画像(今の回と墓標)の元のファイルと、決まった形の縮小版のキーを 1 回の bucket.delete で消す
 * 4. 3 が成功したら行を消す(印のある行だけ・凍結の条件つき)。3 が失敗したら行に触れない(墓標として次の回にやり直す)
 * - **印は一度付いたら外さない**。R2 の delete の前に参照を確かめ直す段は置かない(確かめ直しで印を外すと、R2 を消した後の墓標まで
 *   一覧に戻せるため。spec §22.1)。消すと決めた後の新しい参照は、公開の手順 4 の条件付きの UPDATE が止める
 *
 * **縮小版の段**(最大 THUMBNAILS_PER_TICK 枚): 枠切れの印(その月の末まで)があれば見送る。作り待ち(削除待ち・墓標を除く)を
 * 古い順に読み、1 枚ごとに R2 から読んで makeThumbnail。retry は回数 + 1(3 回で failed)、quota はその回を止め、回数を増やさず印を置く。
 * 凍結の確かめはジョブの最初の 1 回だけ。縮小版の UPDATE と回数の文は凍結の条件を文に持つので、途中で凍結が入っても書かれない
 * (縮小版の UPDATE が凍結で止まったら makeThumbnail が `frozen` を返し、その回を止める)
 *
 * **配分**: queryShare は持たない(結果のジョブの配分表を変えない。config-cleanup・static-reconcile と同じ)。使う D1 の呼び出しを自分で数え、
 * 処理の単位ごとに ctx.queries.use(累計 + その単位の数) を確かめ、足りなければ残りを `{ more: true }` で次の回に回す。
 * それとは別に、1 回の subrequest の予算(HOUSEKEEPING_SUBREQUESTS)を 2 つの段で分け合う(下の定数の説明)
 */
const NAME = "asset-housekeeping";

/** 削除の段の 1 回の枚数(墓標を含む) */
export const ASSET_PURGE_PER_TICK = 5;
/** 縮小版の段の 1 回の枚数の上限(subrequest の予算の残りでさらに減る) */
export const THUMBNAILS_PER_TICK = 4;

/**
 * 1 回の subrequest の予算(このジョブの分)= 28。
 * - 根拠(docs/dev/b68_task0_notes.md の 4 節): Free の 1 回の上限は 50。今の Cron(ほかの 10 本)の 1 回の subrequest は最大 10(ふつう 4)。
 *   ほかのジョブの伸び(配信ファイルの出し直しの DO の RPC など)に 12 の余裕を残して 50 - 10 - 12 = 28。
 *   後から入った B129 の audit-retention(日次 1 回。D1 の呼び出し最大 5)は、この 12 の余裕の内に収まる(下の最悪の 42 + 5 = 47)
 * - D1・R2・Images の binding の呼び出しが subrequest に数えられるかは本番の測定まで分からない(今の測定では D1 は数えられていない)ので、
 *   安全な側に倒して D1 も含めた**すべての呼び出し**を数える
 * - 見込み: 凍結の確かめ 1 + 削除の段(読み 1・印と戻しの batch 1・R2 の delete 1・行の削除 1。何もない回は読み 1 だけ)+
 *   縮小版の段の読み 1 + 1 枚ごとに THUMB_SUBREQUESTS
 * - 削除の無い回: 28 - (1 + 1 + 1) = 25 → 5 枚(上限の 4 枚)。削除の段を全部使った回: 28 - (1 + 4 + 1) = 22 → 4 枚
 * - 枚数を予算で切るので、ふつうは 28 を超えない。例外は、変換の後に行が消えていた縮小版の後始末の R2 の delete(1 枚 +1。まれ)と、
 *   枠切れの印の書き込み(+1。その回はそこで止まる)で、それでも 28 + 4 = 32。ほかのジョブの最大 10 と合わせて 42(上限 50)
 */
export const HOUSEKEEPING_SUBREQUESTS = 28;
/** 縮小版 1 枚の見込みの subrequest: R2 の get 1 + info 1 + 変換 1 + R2 の put 1 + D1 の更新 1 */
export const THUMB_SUBREQUESTS = 5;
/** 縮小版 1 枚の D1 の呼び出し: 更新 1(ready の batch か、失敗の回数か、枠切れの印)。凍結の確かめは文の条件に入っている */
const THUMB_QUERIES = 1;

type PurgeRow = { id: string; site_id: string; r2_key: string; purge_marked_at: number | null };
type ThumbRow = { id: string; site_id: string; r2_key: string };

/** 印の 1 文(spec §6.1 の手順 2。判定と印を 1 文で行う) */
export function purgeMarkStatement(db: D1Database, row: { id: string; site_id: string }, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE assets SET purge_marked_at = ?1, updated_at = ?1
       WHERE id = ?2 AND deleted_at IS NOT NULL AND deleted_at <= ?4 AND purge_marked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM changes WHERE site_id = ?3 AND instr(payload_json, ?2) > 0)
         AND NOT EXISTS (SELECT 1 FROM publishes WHERE site_id = ?3 AND kv_deleted = 0 AND config_hash IS NOT NULL AND instr(config_json, ?2) > 0)
         AND NOT EXISTS (SELECT 1 FROM asset_delivered_refs WHERE site_id = ?3 AND asset_id = ?2)
         AND ${NOT_FROZEN_SQL}`,
    )
    .bind(now, row.id, row.site_id, now - ASSET_PURGE_GRACE_MS);
}

/** 戻しの 1 文(直前の印が付かなかったときだけ当たる) */
export function purgeRestoreStatement(db: D1Database, row: { id: string }, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE assets SET deleted_at = NULL, deleted_by = NULL, kept_at = ?1, updated_at = ?1
       WHERE id = ?2 AND deleted_at IS NOT NULL AND deleted_at <= ?3 AND purge_marked_at IS NULL AND ${NOT_FROZEN_SQL}`,
    )
    .bind(now, row.id, now - ASSET_PURGE_GRACE_MS);
}

/** このジョブの 1 回の数え方(D1 の呼び出しと subrequest) */
type Meter = { queries: number; subrequests: number };

/** 予算の確かめ。D1 は ctx.queries(全体の残り)、subrequest はこのジョブの予算 */
const fits = (ctx: CronContext, m: Meter, queries: number, subrequests: number): boolean =>
  ctx.queries.use(m.queries + queries) && m.subrequests + subrequests <= HOUSEKEEPING_SUBREQUESTS;

/** 削除の段。`false` = D1 の予算が足りずに途中で止めた(続きは次の回) */
async function purgeStage(ctx: CronContext, bucket: R2Bucket, m: Meter): Promise<boolean> {
  const { env, now } = ctx;
  // 1. 墓標と猶予の過ぎた削除待ちを読む(読み 1 + 印と戻しの batch 1 + 行の削除 1 の 3 件が収まるときだけ始める。途中で止めない)
  if (!fits(ctx, m, 3, 4)) return false;
  m.queries++;
  m.subrequests++;
  const rows = (
    await env.DB.prepare(
      `SELECT id, site_id, r2_key, purge_marked_at FROM assets
       WHERE deleted_at IS NOT NULL AND (purge_marked_at IS NOT NULL OR deleted_at <= ?1)
       ORDER BY purge_marked_at IS NULL, deleted_at LIMIT ?2`,
    )
      .bind(now - ASSET_PURGE_GRACE_MS, ASSET_PURGE_PER_TICK)
      .all<PurgeRow>()
  ).results;
  if (rows.length === 0) return true;

  // 2. 判定と印(+ 使われていた画像の戻し)。画像ごとに印 → 戻しの順で 1 つの batch(文ごとの meta.changes で結果を読む)
  const marked: PurgeRow[] = rows.filter((r) => r.purge_marked_at !== null);
  const fresh = rows.filter((r) => r.purge_marked_at === null);
  if (fresh.length > 0) {
    m.queries++;
    m.subrequests++;
    const results = await env.DB.batch(fresh.flatMap((r) => [purgeMarkStatement(env.DB, r, now), purgeRestoreStatement(env.DB, r, now)]));
    fresh.forEach((r, i) => {
      if ((results[i * 2]?.meta.changes ?? 0) > 0) marked.push(r);
    });
  }
  if (marked.length === 0) return true;

  // 3. R2 を消す(元のファイルと、決まった形の縮小版のキー。無いキーの delete も成功するので、やり直しても同じ)
  m.subrequests++;
  try {
    await bucket.delete(marked.flatMap((r) => [r.r2_key, thumbKey(r.site_id, r.id)]));
  } catch (e) {
    // 行に触れない(墓標として残し、次の回の 1 で先に拾って 3 からやり直す)
    console.error(`cron ${NAME}: deleting ${marked.length} image(s) from R2 failed; kept as tombstones`, e);
    return true;
  }
  // 4. 行を消す(印のある行だけ。凍結で 0 行なら墓標のまま次の回)
  m.queries++;
  m.subrequests++;
  await env.DB.prepare(`DELETE FROM assets WHERE id IN (SELECT value FROM json_each(?1)) AND purge_marked_at IS NOT NULL AND ${NOT_FROZEN_SQL}`)
    .bind(JSON.stringify(marked.map((r) => r.id)))
    .run();
  return true;
}

/** 縮小版の段。`false` = D1 の予算が足りずに途中で止めた(続きは次の回) */
async function thumbnailStage(ctx: CronContext, bucket: R2Bucket, m: Meter): Promise<boolean> {
  const { env, now } = ctx;
  // subrequest の予算の残りで作れる枚数(先の段で使った分だけ減る。読みの 1 を先に引く)
  const room = Math.floor((HOUSEKEEPING_SUBREQUESTS - m.subrequests - 1) / THUMB_SUBREQUESTS);
  const limit = Math.min(THUMBNAILS_PER_TICK, room);
  if (limit <= 0) return true;
  if (!fits(ctx, m, 1 + THUMB_QUERIES, 1 + THUMB_SUBREQUESTS)) return false;
  // 枠切れの印と作り待ちを 1 回で読む(作り待ちの部分索引。削除待ち・墓標の行には作らない)
  m.queries++;
  m.subrequests++;
  const [mark, pending] = await env.DB.batch([
    quotaMarkReadStatement(env),
    env.DB.prepare(`SELECT id, site_id, r2_key FROM assets WHERE thumb_state = 'pending' AND deleted_at IS NULL ORDER BY created_at LIMIT ?1`).bind(limit),
  ]);
  const until = parseQuotaUntil((mark?.results?.[0] as { value?: unknown } | undefined)?.value);
  if (until !== null && now < until) return true; // その月の末まで見送る(翌月の最初の回で作り直しが始まる)
  for (const row of (pending?.results ?? []) as ThumbRow[]) {
    if (!fits(ctx, m, THUMB_QUERIES, THUMB_SUBREQUESTS)) return false;
    m.queries += THUMB_QUERIES;
    m.subrequests += THUMB_SUBREQUESTS;
    let result: Awaited<ReturnType<typeof makeThumbnail>>;
    try {
      const obj = await bucket.get(row.r2_key);
      // 元の画像が R2 に無い・読めないときも失敗として数える(3 回で failed になり、拾い続けない)
      result = obj ? await makeThumbnail(env, row, await obj.arrayBuffer(), now) : "retry";
    } catch (e) {
      console.error(`cron ${NAME}: reading ${row.id} from R2 failed`, e);
      result = "retry";
    }
    if (result === "quota") {
      // 枠切れ: その回を止め、回数を増やさず、その月の末までの印を置く
      await quotaMarkWriteStatement(env, now).run();
      console.log(`cron ${NAME}: the Images quota ran out; thumbnails paused until the end of the month (UTC)`);
      return true;
    }
    // 書き込みの凍結に当たった: 行は pending のまま(回数も増えていない)。残りの行も同じなので、変換を続けずにその回を止める
    if (result === "frozen") throw new CronFrozen();
    if (result === "retry") await thumbAttemptStatement(env, row.id, now).run();
  }
  return true;
}

export const assetHousekeepingJob: CronJob = {
  name: NAME,
  cadence: { every: "tick" },
  writesControl: true,
  async run(ctx) {
    const store = imageStore(ctx.env);
    if (!store) return; // R2 が無い導入(削除の段も縮小版の段も無い)
    const m: Meter = { queries: 0, subrequests: 0 };
    if (!fits(ctx, m, 1, 1)) return { more: true };
    m.queries++;
    m.subrequests++;
    await ctx.assertNotFrozen();
    if (!(await purgeStage(ctx, store.bucket, m))) return { more: true };
    if (!ctx.env.IMAGES) return; // Images の binding が無い導入は縮小版の段だけ何もしない
    if (!(await thumbnailStage(ctx, store.bucket, m))) return { more: true };
  },
};
