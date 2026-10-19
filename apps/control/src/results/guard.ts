import { getDb } from "../db";
import type { Env } from "../env";
import { isWriteFrozen } from "../write-freeze";

/**
 * D9 ③(plan ③ の K24・決定 56): 書き込みを含む結果の共通の関数(purgeRun・confirmDeliveries・checkReach・rewriteCollectUntil・
 * ensureSnapshot・保存した速報の書き込み)が、wtt-control に書く各文(1 回の batch / 1 文)の直前に呼ぶ確かめ。
 * 凍結中なら投げる。Cron は `ctx.assertNotFrozen`(CronFrozen を投げる)を、API は apiGuard を渡す。
 * GET に伴う業務データの書き込みは、呼び出し側が WriteFrozen を捕まえて、書かずに計算した値だけを返す(`persisted: false`)
 */
export type WriteGuard = () => Promise<void>;

/** 凍結中に wtt-control へ書こうとした(apiGuard が投げる) */
export class WriteFrozen extends Error {
  constructor() {
    super("write frozen");
    this.name = "WriteFrozen";
  }
}

/** API の guard。呼ぶたびに凍結を読み直す(D1 が読めないときも凍結中 = isWriteFrozen の決まり) */
export function apiGuard(env: Env): WriteGuard {
  const db = getDb(env);
  return async () => {
    if (await isWriteFrozen(db)) throw new WriteFrozen();
  };
}
