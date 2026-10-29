import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { CompiledQuery } from "kysely";
import { authD1Dialect } from "../src/auth-d1-dialect";
import { call, setupOwner } from "./helpers";

/**
 * B162: Better Auth の中の kysely 0.28 は、driver の結果に `numUpdatedOrDeletedRows` のキーがある(`in` で判定)と
 * isolate ごとに 1 回 `kysely:warning: outdated driver/plugin detected!` を console.log する。
 * Better Auth に渡す dialect は、そのキーを持たない結果を返す(numAffectedRows などは残す)
 */
describe("authD1Dialect (B162)", () => {
  async function run(sqlText: string) {
    const driver = authD1Dialect(env.DB).createDriver();
    await driver.init();
    const conn = await driver.acquireConnection();
    try {
      return await conn.executeQuery(CompiledQuery.raw(sqlText));
    } finally {
      await driver.releaseConnection(conn);
    }
  }

  it("drops numUpdatedOrDeletedRows from an update result and keeps numAffectedRows", async () => {
    await run("create table if not exists b162_probe (id integer primary key, v text)");
    await run("insert into b162_probe (id, v) values (1, 'a'), (2, 'a')");
    const res = await run("update b162_probe set v = 'b' where v = 'a'");
    expect("numUpdatedOrDeletedRows" in res).toBe(false);
    expect(res.numAffectedRows).toBe(2n);
  });

  it("drops the key from a select result too and keeps rows", async () => {
    await run("create table if not exists b162_probe (id integer primary key, v text)");
    await run("insert into b162_probe (id, v) values (1, 'a')");
    const res = await run("select id, v from b162_probe");
    expect("numUpdatedOrDeletedRows" in res).toBe(false);
    expect(res.rows).toEqual([{ id: 1, v: "a" }]);
  });

  it("Better Auth does not print the kysely outdated-driver warning", async () => {
    const spy = vi.spyOn(console, "log");
    try {
      const { token } = await setupOwner();
      expect((await call("GET", "/me", { token })).status).toBe(200);
      const warned = spy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("outdated driver/plugin")));
      expect(warned).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
