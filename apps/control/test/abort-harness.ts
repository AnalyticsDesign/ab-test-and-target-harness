import type { Env } from "../src/env";

export type AbortMode = "before" | "after" | "throw_after";
export type AbortPoint = { at: number; mode: AbortMode };

const SQL = Symbol("abortSql");

export function abortingBindings(env: Env, point: AbortPoint | null): { env: Env; calls: string[]; reached: Promise<void> } {
  const calls: string[] = [];
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  const pending = new Promise<never>(() => {});

  async function invoke<T>(label: string, execute: () => Promise<T>): Promise<T> {
    calls.push(label);
    if (calls.length !== point?.at) return execute();
    if (point.mode !== "before") await execute();
    markReached();
    if (point.mode === "throw_after") throw new Error("injected after commit");
    // 待っている側の catch・finally も、打ち切りの後は走らせない。
    return pending;
  }

  const wrapStatement = (stmt: D1PreparedStatement, query: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === SQL) return query;
        if (prop === "bind") return (...args: unknown[]) => wrapStatement(target.bind(...args), query);
        const method = Reflect.get(target, prop);
        if (prop === "run" || prop === "all" || prop === "first" || prop === "raw") {
          return (...args: unknown[]) => invoke(query, () => method.apply(target, args));
        }
        return typeof method === "function" ? method.bind(target) : method;
      },
    });

  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrapStatement(target.prepare(query), query);
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          const query = statements.map((stmt) => String(Reflect.get(stmt, SQL) ?? "?")).join(" ;; ");
          return invoke(query, () => target.batch(statements));
        };
      }
      const method = Reflect.get(target, prop);
      return typeof method === "function" ? method.bind(target) : method;
    },
  });

  const CONFIG_KV = new Proxy(env.CONFIG_KV, {
    get(target, prop) {
      const method = Reflect.get(target, prop);
      if (prop === "get" || prop === "put" || prop === "delete") {
        return (key: string, ...args: unknown[]) => invoke(`kv.${prop} ${key}`, () => method.apply(target, [key, ...args]));
      }
      if (prop === "list") {
        return (options?: KVNamespaceListOptions) => {
          const label = options?.prefix === undefined ? "kv.list" : `kv.list ${options.prefix}`;
          return invoke(label, () => target.list(options));
        };
      }
      return typeof method === "function" ? method.bind(target) : method;
    },
  });

  return { env: { ...env, DB, CONFIG_KV }, calls, reached };
}

/** before・after の停止点を待つ。throw_after で後続の catch まで見る場合は p を直接待つ。 */
export function settleOrAbort<T>(p: Promise<T>, reached: Promise<void>): Promise<{ aborted: true } | { aborted: false; value: T }> {
  return Promise.race([
    p.then((value) => ({ aborted: false as const, value })),
    reached.then(() => ({ aborted: true as const })),
  ]);
}
