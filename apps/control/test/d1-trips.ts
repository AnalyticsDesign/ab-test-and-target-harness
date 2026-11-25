/**
 * B68 Task 4: D1 の往復を数えるラッパ。往復 = 文の実行(`run`・`all`・`first`・`raw`)1 回、または `batch` 1 回。
 * `trips` は往復ごとの SQL(batch は中の文を ` ;; ` でつないだもの)。`before` を渡すと、SQL が当たる最初の往復の直前に 1 回だけ流す
 * (割り込みの再現。割り込みの書き込みは包む前の DB に流す)。D1 の batch は proxy の文も受ける(assets.test.ts と同じ包み方)
 */
const SQL = Symbol.for("wtt.test.tripSql");

export function countingD1(db: D1Database, before?: { match: RegExp; run: () => Promise<unknown> }): { DB: D1Database; trips: string[] } {
  const trips: string[] = [];
  let fired = false;
  const fire = async (q: string) => {
    if (before && !fired && before.match.test(q)) {
      fired = true;
      await before.run();
    }
  };
  const wrap = (stmt: D1PreparedStatement, q: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(s, p) {
        if (p === SQL) return q;
        if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args), q);
        if (p === "run" || p === "all" || p === "first" || p === "raw")
          return async (...args: unknown[]) => {
            await fire(q);
            trips.push(q);
            return (Reflect.get(s, p) as (...a: unknown[]) => unknown).apply(s, args);
          };
        const x = Reflect.get(s, p);
        return typeof x === "function" ? x.bind(s) : x;
      },
    });
  const DB = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (q: string) => wrap(target.prepare(q), q);
      if (prop === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          const q = stmts.map((st) => String((st as unknown as Record<symbol, unknown>)[SQL] ?? "?")).join(" ;; ");
          await fire(q);
          trips.push(q);
          return target.batch(stmts);
        };
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
  return { DB, trips };
}

/** 往復のうち SQL が当たるものの数 */
export const tripsMatching = (trips: readonly string[], re: RegExp): number => trips.filter((t) => re.test(t)).length;

/** 画像の確かめの読み(guardAssets の SELECT)。公開の手順 4 の UPDATE の中の `FROM assets a` とは別に数える */
export const ASSET_READ = /^\s*SELECT id FROM assets WHERE/i;
/** 公開の手順 4(設定の記録) */
export const CONFIG_RECORD = /UPDATE publishes SET config_hash/i;
/** compile の入力の読み(buildCompileInput の 4 つのうち、ほかで読まない `audiences` の definition_json) */
export const COMPILE_INPUT_READ_LEGACY = /select "id", "definition_json" from "audiences"/i;
/** 公開時に同じ batch で読む compile 入力。 */
export const COMPILE_ROWS_BATCH = /select \* from "audiences"/i;
