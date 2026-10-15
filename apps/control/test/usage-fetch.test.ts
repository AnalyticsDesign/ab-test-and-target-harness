// apps/control/test/usage-fetch.test.ts
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { ApiError } from "../src/errors";
import { INSTANCE_SETTING_DEFAULTS } from "../src/instance-settings";
import { buildUsageQuery, parseUsage, usageConfig, type UsageConfig } from "../src/usage/fetch";
import { getUsage, resetUsageCache } from "../src/usage";

// backlog D10 / brief K8〜K10・plan K20〜K24: GraphQL の 1 回の要求と、その解釈
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const T = Date.UTC(2026, 9, 6, 6); // 2026-10-06 06:00 UTC
const cfg: UsageConfig = {
  accountId: ACCOUNT,
  token: "t",
  workers: ["wtt-edge", "wtt-control", "wtt-admin"],
  d1: [{ id: "11111111-2222-3333-4444-555555555555", name: "wtt-control" }],
  kv: [{ id: "aaaaaaaabbbbccccddddeeeeeeeeeeee", name: "CONFIG_KV" }],
};
const withEnv = (o: Partial<Env>): Env => ({ ...(env as unknown as Env), ...o }) as Env;

/** 2026-10-06 に実際に返った形(ID と数値は合成の値) */
const account = (over: Record<string, unknown> = {}) => ({
  workers: [
    { dimensions: { scriptName: "wtt-control" }, sum: { requests: 1200 } },
    { dimensions: { scriptName: "wtt-admin" }, sum: { requests: 300 } },
    { dimensions: { scriptName: "other-project" }, sum: { requests: 500 } },
  ],
  doRequests: [],
  doNamespaces: [{ dimensions: { scriptName: "wtt-edge", namespaceId: "99999999888877776666555555555555" } }],
  doRows: [{ dimensions: { namespaceId: "99999999888877776666555555555555" }, sum: { rowsRead: 7, rowsWritten: 9 } }],
  doStorage: [
    { dimensions: { namespaceId: "99999999888877776666555555555555" }, max: { storedBytes: 2_000_000 } },
    { dimensions: { namespaceId: "ffffffff888877776666555555555555" }, max: { storedBytes: 1_000_000 } },
  ],
  d1: [
    { dimensions: { databaseId: "11111111-2222-3333-4444-555555555555" }, sum: { rowsRead: 14000, rowsWritten: 27 } },
    { dimensions: { databaseId: "aaaaaaaa-0000-0000-0000-000000000000" }, sum: { rowsRead: 1000, rowsWritten: 3 } },
  ],
  d1Storage: [
    { dimensions: { databaseId: "11111111-2222-3333-4444-555555555555" }, max: { databaseSizeBytes: 311_296 } },
    { dimensions: { databaseId: "aaaaaaaa-0000-0000-0000-000000000000" }, max: { databaseSizeBytes: 400_000_000 } },
  ],
  kv: [
    { dimensions: { namespaceId: "aaaaaaaabbbbccccddddeeeeeeeeeeee", actionType: "read" }, sum: { requests: 28 } },
    { dimensions: { namespaceId: "aaaaaaaabbbbccccddddeeeeeeeeeeee", actionType: "write" }, sum: { requests: 6 } },
    { dimensions: { namespaceId: "aaaaaaaabbbbccccddddeeeeeeeeeeee", actionType: "delete" }, sum: { requests: 2 } },
    { dimensions: { namespaceId: "aaaaaaaabbbbccccddddeeeeeeeeeeee", actionType: "list" }, sum: { requests: 1 } },
  ],
  // kvStorage の namespaceId はハイフン付きで返る(K21)
  kvStorage: [{ dimensions: { namespaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, max: { byteCount: 12_546 } }],
  ...over,
});
const body = (acc: unknown) => ({ data: { viewer: { accounts: [acc] } }, errors: null });

/** parseUsage の失敗を「status code」の文字列にする(成功なら null) */
const fails = (b: unknown) => {
  try {
    parseUsage(b, cfg);
    return null;
  } catch (e) {
    return e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
  }
};

function mockGraphql(responses: Array<() => Response>) {
  const real = globalThis.fetch;
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.cloudflare.com/client/v4/graphql") return responses[Math.min(i++, responses.length - 1)]!();
    return real(input as RequestInfo, init);
  });
}

describe("usage fetch (D10)", () => {
  beforeEach(() => resetUsageCache());
  afterEach(() => vi.restoreAllMocks());

  it("usageConfig needs the token and a 32-hex account id; resources default to the product worker names", () => {
    expect(usageConfig(withEnv({ CF_USAGE_TOKEN: undefined, CF_ACCOUNT_ID: ACCOUNT }))).toBeNull();
    expect(usageConfig(withEnv({ CF_USAGE_TOKEN: "t", CF_ACCOUNT_ID: "not-an-id" }))).toBeNull();
    expect(usageConfig(withEnv({ CF_USAGE_TOKEN: "t", CF_ACCOUNT_ID: ACCOUNT, AB_USAGE_RESOURCES: undefined }))).toEqual({
      accountId: ACCOUNT, token: "t", workers: ["wtt-edge", "wtt-control", "wtt-admin"], d1: [], kv: [],
    });
    // 壊れた形は既定に倒す(取得は止めない。合計は出る)。isolate で 1 回だけ警告を出す
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(usageConfig(withEnv({ CF_USAGE_TOKEN: "t", CF_ACCOUNT_ID: ACCOUNT, AB_USAGE_RESOURCES: "oops" as unknown }))?.d1).toEqual([]);
    expect(warn).toHaveBeenCalledWith("AB_USAGE_RESOURCES is not a JSON object; using the default product workers only");
    expect(usageConfig(withEnv({ CF_USAGE_TOKEN: "t", CF_ACCOUNT_ID: ACCOUNT, AB_USAGE_RESOURCES: { workers: ["a"], d1: [{ id: "x", name: "n" }], kv: [] } }))).toMatchObject({ workers: ["a"], d1: [{ id: "x", name: "n" }] });
    // `--var` や .dev.vars からは JSON の文字列で来る
    expect(usageConfig(withEnv({ CF_USAGE_TOKEN: "t", CF_ACCOUNT_ID: ACCOUNT, AB_USAGE_RESOURCES: JSON.stringify({ workers: ["a"], d1: [], kv: [] }) }))?.workers).toEqual(["a"]);
  });

  it("the query asks today, the storage from yesterday, and the DO mapping over 30 days", () => {
    const q = buildUsageQuery(ACCOUNT, T);
    expect(q).toContain(`accountTag: "${ACCOUNT}"`);
    expect(q).toContain('date_geq: "2026-10-06", date_leq: "2026-10-06"');
    expect(q).toContain('date_geq: "2026-10-05", date_leq: "2026-10-06"');
    expect(q).toContain('date_geq: "2026-09-06", date_leq: "2026-10-06"');
    for (const alias of ["workers:", "doRequests:", "doNamespaces:", "doRows:", "doStorage:", "d1:", "d1Storage:", "kv:", "kvStorage:"]) expect(q).toContain(alias);
  });

  it("parses totals over the account and the breakdown over the product only", () => {
    const r = parseUsage(body(account()), cfg);
    expect(r.workers_requests).toEqual({ used: 2000, breakdown: [{ name: "wtt-control", used: 1200 }, { name: "wtt-admin", used: 300 }] });
    expect(r.d1_rows_read).toEqual({ used: 15000, breakdown: [{ name: "wtt-control", used: 14000 }] });
    expect(r.d1_storage.used).toBe(400_311_296);
    // 1 DB の上限は DB ごとに効くので、本製品の DB の中の最大。他のプロジェクトの 400 MB の DB は入らない(K22)
    expect(r.d1_largest_db).toEqual({ used: 311_296, breakdown: [{ name: "wtt-control", used: 311_296 }] });
    expect(r.kv_reads.used).toBe(28);
    expect(r.kv_writes.used).toBe(6);
    expect(r.kv_deletes.used).toBe(2);
    expect(r.kv_lists.used).toBe(1);
  });

  it("d1_largest_db is not judged without product databases", () => {
    const r = parseUsage(body(account()), { ...cfg, d1: [] });
    expect(r.d1_largest_db).toEqual({ used: 0, breakdown: [], judged: false });
    expect(r.d1_storage.used).toBe(400_311_296); // アカウント合計は全 DB のまま
  });

  it("d1_largest_db is not judged when the configured database ids match no row (final review finding 3)", () => {
    // ID の書き間違い・別の DB・まだ行が無い。本物の D1 が 0 バイトになることはないので、0 を「余裕あり」と判定しない
    const r = parseUsage(body(account()), { ...cfg, d1: [{ id: "00000000-0000-0000-0000-000000000000", name: "wtt-control" }] });
    expect(r.d1_largest_db).toEqual({ used: 0, breakdown: [], judged: false });
    expect(r.d1_storage.used).toBe(400_311_296);
  });

  it("matches KV ids with and without hyphens (K21, review focus)", () => {
    const r = parseUsage(body(account()), cfg);
    expect(r.kv_storage).toEqual({ used: 12_546, breakdown: [{ name: "CONFIG_KV", used: 12_546 }] });
    expect(r.kv_reads.breakdown).toEqual([{ name: "CONFIG_KV", used: 28 }]);
  });

  it("attributes DO rows and storage through the 30-day mapping when there are no DO calls today (K20, review focus)", () => {
    const r = parseUsage(body(account()), cfg);
    expect(r.do_requests).toEqual({ used: 0, breakdown: [] });
    expect(r.do_rows_written).toEqual({ used: 9, breakdown: [{ name: "wtt-edge", used: 9 }] });
    expect(r.do_storage).toEqual({ used: 3_000_000, breakdown: [{ name: "wtt-edge", used: 2_000_000 }] });
  });

  it("empty datasets are zero usage, not an error", () => {
    const empty = Object.fromEntries(Object.keys(account()).map((k) => [k, []]));
    const r = parseUsage(body(empty), cfg);
    expect(r.workers_requests).toEqual({ used: 0, breakdown: [] });
    expect(r.d1_largest_db.used).toBe(0);
  });

  it("GraphQL errors, a missing account and a missing dataset are upstream failures (K23, review focus)", () => {
    expect(fails({ data: null, errors: [{ message: "not authorized" }] })).toBe("503 usage_upstream_failed");
    expect(fails({ ...body(account()), errors: [{ message: "dataset unavailable" }] })).toBe("503 usage_upstream_failed");
    expect(fails({ data: { viewer: { accounts: [] } }, errors: null })).toBe("503 usage_upstream_failed");
    const { kv: _kv, ...noKv } = account();
    expect(fails(body(noKv))).toBe("503 usage_upstream_failed");
  });

  it("missing, non-numeric, negative or non-finite values and null rows are upstream failures, not zero (K23)", () => {
    for (const row of [
      { dimensions: { scriptName: "wtt-control" }, sum: {} },
      { dimensions: { scriptName: "wtt-control" }, sum: { requests: "80000" } },
      { dimensions: { scriptName: "wtt-control" }, sum: { requests: -1 } },
      { dimensions: { scriptName: "wtt-control" }, sum: { requests: null } },
      null,
    ]) {
      expect(fails(body(account({ workers: [row] }))), JSON.stringify(row)).toBe("503 usage_upstream_failed");
    }
  });

  it("missing dimensions needed for totals are upstream failures (K23)", () => {
    const base = account();
    const drop = <T extends { dimensions: Record<string, unknown> }>(rows: T[], key: string) =>
      rows.map((r) => ({ ...r, dimensions: Object.fromEntries(Object.entries(r.dimensions).filter(([k]) => k !== key)) }));
    expect(fails(body(account({ kv: drop(base.kv, "actionType") })))).toBe("503 usage_upstream_failed");
    expect(fails(body(account({ doStorage: drop(base.doStorage, "namespaceId") })))).toBe("503 usage_upstream_failed");
    expect(fails(body(account({ d1Storage: drop(base.d1Storage, "databaseId") })))).toBe("503 usage_upstream_failed");
  });

  it("an unknown kv action type is not counted", () => {
    const base = account();
    const before = parseUsage(body(base), cfg);
    const after = parseUsage(body(account({ kv: [...base.kv, { dimensions: { namespaceId: "aaaaaaaabbbbccccddddeeeeeeeeeeee", actionType: "purge" }, sum: { requests: 50 } }] })), cfg);
    for (const id of ["kv_reads", "kv_writes", "kv_deletes", "kv_lists"] as const) expect(after[id]).toEqual(before[id]);
  });

  it("a dataset that hits the page limit is treated as truncated (K29)", () => {
    const full = Array.from({ length: 10_000 }, () => ({ dimensions: { scriptName: "other-project" }, sum: { requests: 1 } }));
    expect(fails(body(account({ workers: full })))).toBe("503 usage_upstream_failed");
  });

  it("getUsage: not configured is 503 usage_not_configured", async () => {
    await expect(getUsage(withEnv({ CF_USAGE_TOKEN: undefined }), INSTANCE_SETTING_DEFAULTS, T)).rejects.toMatchObject({ status: 503, code: "usage_not_configured" });
  });

  it("getUsage: sends the token, judges with the given settings and caches the raw result for 60 seconds on the same UTC day (K24)", async () => {
    const spy = mockGraphql([() => Response.json(body(account()))]);
    const e = withEnv({ CF_USAGE_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT });
    const a = await getUsage(e, INSTANCE_SETTING_DEFAULTS, T);
    expect(a.plan).toBe("free");
    const [, init] = spy.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
    const b = await getUsage(e, { ...INSTANCE_SETTING_DEFAULTS, cloudflarePlan: "paid" }, T + 59_000);
    expect(b.plan).toBe("paid"); // 設定は毎回いまの値で判定する
    expect(b.asOf).toBe(T); // キャッシュの間は取得した時刻のまま
    expect(spy).toHaveBeenCalledTimes(1);
    await getUsage(e, INSTANCE_SETTING_DEFAULTS, T + 61_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("getUsage: does not reuse yesterday's result across UTC midnight, and does not cache failures", async () => {
    const late = Date.UTC(2026, 9, 6, 23, 59, 50);
    const spy = mockGraphql([() => new Response("bad gateway", { status: 502 }), () => Response.json(body(account())), () => Response.json(body(account()))]);
    const e = withEnv({ CF_USAGE_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT });
    await expect(getUsage(e, INSTANCE_SETTING_DEFAULTS, late)).rejects.toMatchObject({ status: 503, code: "usage_upstream_failed" });
    await getUsage(e, INSTANCE_SETTING_DEFAULTS, late);
    await getUsage(e, INSTANCE_SETTING_DEFAULTS, late + 20_000); // 日をまたいだ
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
