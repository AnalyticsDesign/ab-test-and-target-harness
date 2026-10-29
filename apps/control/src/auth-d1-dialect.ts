import { D1Dialect } from "kysely-d1";
import type { CompiledQuery, DatabaseConnection, Dialect, Driver, Kysely, QueryResult } from "kysely";

/**
 * Better Auth に渡す D1 の dialect(B162)。
 * kysely-d1 0.4.0 の driver は結果に互換のキー `numUpdatedOrDeletedRows` を付け、Better Auth の中の kysely 0.28 は
 * そのキーが `in` で見えると isolate ごとに 1 回 `kysely:warning: outdated driver/plugin detected!` を console.log する
 * (Workers Logs では要求の URL 全文付きの行になる)。ここではそのキーを持たない新しい結果を返すだけで、ほかはすべて元に委譲する。
 * kysely-d1 をこのキーを返さない版(または別の D1 dialect)に差し替えたら、この包みは外して `new D1Dialect(...)` に戻せる。
 * control 自身の Kysely(db.ts の getDb)は kysely 0.29 で警告しないので包まない
 */
export function authD1Dialect(database: D1Database): Dialect {
  const inner = new D1Dialect({ database });
  return {
    createAdapter: () => inner.createAdapter(),
    createDriver: () => wrapDriver(inner.createDriver()),
    createQueryCompiler: () => inner.createQueryCompiler(),
    createIntrospector: (db: Kysely<any>) => inner.createIntrospector(db),
  };
}

/** `in` の判定に掛からないよう、キーを持たない新しいオブジェクトにする(undefined の代入ではキーが残る) */
function dropLegacyKey<R>(result: QueryResult<R>): QueryResult<R> {
  if (!("numUpdatedOrDeletedRows" in result)) return result;
  const { numUpdatedOrDeletedRows: _legacy, ...rest } = result as QueryResult<R> & { numUpdatedOrDeletedRows?: unknown };
  return rest;
}

type Methods = Record<string, unknown>;

/** 元にあるときだけ、同じ名前のメソッドを元へ委譲して足す(任意のメソッドの有無を元とそろえる) */
function delegateIfPresent(target: object, source: object, keys: readonly string[], mapArgs: (args: unknown[]) => unknown[] = (a) => a): void {
  for (const key of keys) {
    const fn = (source as Methods)[key];
    if (typeof fn === "function") (target as Methods)[key] = (...args: unknown[]) => fn.apply(source, mapArgs(args));
  }
}

function wrapConnection(conn: DatabaseConnection): DatabaseConnection {
  const wrapped: DatabaseConnection = {
    executeQuery: async <R>(q: CompiledQuery) => dropLegacyKey(await conn.executeQuery<R>(q)),
    streamQuery: async function* <R>(q: CompiledQuery, chunkSize: number) {
      for await (const r of conn.streamQuery<R>(q, chunkSize)) yield dropLegacyKey(r);
    },
  };
  // kysely 0.29 の任意のメソッドと、kysely-d1 の connection が持つトランザクションのメソッド
  delegateIfPresent(wrapped, conn, ["cancelQuery", "collectSessionInfo", "killSession", "beginTransaction", "commitTransaction", "rollbackTransaction"]);
  return wrapped;
}

function wrapDriver(driver: Driver): Driver {
  // Kysely には包んだ connection を渡す。driver のメソッドへ戻すときは元の connection に戻す
  const originals = new WeakMap<DatabaseConnection, DatabaseConnection>();
  const unwrap = (c: DatabaseConnection) => originals.get(c) ?? c;
  const unwrapFirst = (args: unknown[]) => [unwrap(args[0] as DatabaseConnection), ...args.slice(1)];
  const wrapped: Driver = {
    init: (...args) => driver.init(...args),
    acquireConnection: async (...args) => {
      const conn = await driver.acquireConnection(...args);
      const w = wrapConnection(conn);
      originals.set(w, conn);
      return w;
    },
    beginTransaction: (c, s) => driver.beginTransaction(unwrap(c), s),
    commitTransaction: (c) => driver.commitTransaction(unwrap(c)),
    rollbackTransaction: (c) => driver.rollbackTransaction(unwrap(c)),
    releaseConnection: (c, ...rest) => driver.releaseConnection(unwrap(c), ...rest),
    destroy: (...args) => driver.destroy(...args),
  };
  delegateIfPresent(wrapped, driver, ["savepoint", "rollbackToSavepoint", "releaseSavepoint"], unwrapFirst);
  return wrapped;
}
