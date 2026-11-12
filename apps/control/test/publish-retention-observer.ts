import type { Env } from "../src/env";

/** 実際に呼ばれた文の D1 meta と計画を控える。問い合わせはすべて実 DB に渡す。 */
export function observeRetentionDb(env: Env) {
  const queries = new WeakMap<object, { sql: string; binds: unknown[] }>();
  const calls: Array<{ sql: string; binds: unknown[]; meta: D1Meta }> = [];
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (text: string) => {
        const wrap = (stmt: D1PreparedStatement, binds: unknown[]): D1PreparedStatement => {
          const observed = new Proxy(stmt, {
            get(s, method) {
              if (method === "bind") return (...values: unknown[]) => wrap(s.bind(...values), values);
              if (method === "all" || method === "run") return async () => {
                const result = await s[method]();
                calls.push({ sql: text, binds, meta: result.meta });
                return result;
              };
              const value = Reflect.get(s, method);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
          queries.set(observed, { sql: text, binds });
          return observed;
        };
        return wrap(target.prepare(text), []);
      };
      if (prop === "batch") return async (statements: D1PreparedStatement[]) => {
        const raw = statements.map((s) => {
          const q = queries.get(s)!;
          return target.prepare(q.sql).bind(...q.binds);
        });
        const results = await target.batch(raw);
        results.forEach((r, i) => calls.push({ ...queries.get(statements[i]!)!, meta: r.meta }));
        return results;
      };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB } as Env, calls };
}
