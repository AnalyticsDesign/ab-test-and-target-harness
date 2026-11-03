import { env } from "cloudflare:workers";
import { kvKeys } from "@wtt/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DomainRow } from "../src/domains";
import {
  ensureInstallMarker,
  FREE_PROBE_LIMIT,
  INSTALL_MARKER_KEY,
  installHashOf,
  mergeProbeResults,
  pickRowsToProbe,
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  PROBE_TOTAL_MS,
  probeDomain,
  probeDomains,
  probeUrl,
  probeOverrideFromEnv,
  readProbeSettings,
} from "../src/domain-probe";
import { MAX_DOMAINS } from "../src/domains";
import { call, createSite, fakeEdgePing, json, setupOwner } from "./helpers";

// B148 Task 3: /__ab/ping への GET で、タグのドメインがこの導入の edge に届くかを判定する

const H = "a".repeat(64);

const fakeFetch =
  (status: number, body: unknown): typeof fetch =>
  async () => {
    const noBody = status === 204 || (status >= 300 && status < 400); // 本文を持てない応答
    return new Response(noBody ? null : typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: status >= 300 && status < 400 ? { Location: "https://elsewhere.example.com/" } : { "Content-Type": "application/json" },
    });
  };
const neverResolves: typeof fetch = () => new Promise<Response>(() => {});
const throws: typeof fetch = async () => {
  throw new TypeError("network connection lost");
};

const row = (value: string, over: Partial<DomainRow> = {}): DomainRow => ({ value, verdict: "unknown", checkedAt: null, triedAt: null, ...over });
const rowsN = (n: number): DomainRow[] => Array.from({ length: n }, (_, i) => row(`h${i}.example.com`));

/** 手で時計を進める間に、決着した promise を拾う */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T> {
  let done = false;
  let value: T;
  void p.then((v) => {
    done = true;
    value = v;
  });
  await vi.advanceTimersByTimeAsync(ms);
  expect(done).toBe(true);
  return value!;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("probeDomain(判定の結果の読み方)", () => {
  test("probe_edge_requires_matching_install", async () => {
    expect(await probeDomain("www.example.com", H, fakeFetch(200, { edge: "wtt", install: H }))).toBe("edge");
  });

  test("probe_other_install_is_outside", async () => {
    expect(await probeDomain("www.example.com", H, fakeFetch(200, { edge: "wtt", install: "other" }))).toBe("outside");
    expect(await probeDomain("www.example.com", H, fakeFetch(200, { edge: "other", install: H }))).toBe("outside");
    expect(await probeDomain("www.example.com", H, fakeFetch(200, "<html>not json</html>"))).toBe("outside");
    expect(await probeDomain("www.example.com", H, fakeFetch(204, ""))).toBe("outside");
  });

  test("probe_redirect_and_404_are_outside", async () => {
    expect(await probeDomain("a.example.com", H, fakeFetch(301, ""))).toBe("outside");
    expect(await probeDomain("a.example.com", H, fakeFetch(404, "not found"))).toBe("outside");
    expect(await probeDomain("a.example.com", H, fakeFetch(400, ""))).toBe("outside");
  });

  test("probe_403_429_and_5xx_are_unknown", async () => {
    expect(await probeDomain("a.example.com", H, fakeFetch(403, ""))).toBe("unknown"); // P6: WAF の Block も確かめられない側
    expect(await probeDomain("a.example.com", H, fakeFetch(429, ""))).toBe("unknown");
    expect(await probeDomain("a.example.com", H, fakeFetch(503, { error: "install marker unavailable" }))).toBe("unknown");
    expect(await probeDomain("a.example.com", H, fakeFetch(530, ""))).toBe("unknown");
  });

  test("probe_timeout_and_network_error_are_unknown", async () => {
    vi.useFakeTimers();
    const p = probeDomain("a.example.com", H, neverResolves); // 3,000 ms で打ち切る(fake timers)
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    expect(await settleWithin(p, 1)).toBe("unknown");
    vi.useRealTimers();
    expect(await probeDomain("a.example.com", H, throws)).toBe("unknown");
  });

  test("probe_sends_one_get_to_ping_without_following_redirects", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const spy: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 302, headers: { Location: "https://www.example.com/login" } });
    };
    expect(await probeDomain("www.example.com", H, spy)).toBe("outside");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://www.example.com/__ab/ping");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.redirect).toBe("manual");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("slow_body_is_cut", async () => {
    vi.useFakeTimers();
    // ヘッダーの後に本文が止まる → 3 秒で unknown
    const stalled: typeof fetch = async () =>
      new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"edge":')) }), { status: 200 });
    expect(await settleWithin(probeDomain("a.example.com", H, stalled), PROBE_TIMEOUT_MS)).toBe("unknown");
    vi.useRealTimers();
    // 本文は 1 KB まで。それを超える本文は途中で切れて JSON として読めない → outside
    const big = JSON.stringify({ edge: "wtt", install: H, pad: "x".repeat(2000) });
    expect(await probeDomain("a.example.com", H, fakeFetch(200, big))).toBe("outside");
  });
});

describe("pickRowsToProbe", () => {
  test("free_plan_probes_40_oldest_first", () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({ value: `h${i}.example.com`, verdict: "edge" as const, checkedAt: 100 - i, triedAt: 100 - i }));
    const { probe, deferred } = pickRowsToProbe(rows, "free");
    expect(probe).toHaveLength(FREE_PROBE_LIMIT);
    expect(deferred).toEqual(["h4.example.com", "h3.example.com", "h2.example.com", "h1.example.com", "h0.example.com"]); // triedAt の新しい 5 行が残る(古い順)
    expect(probe[0]).toBe("h44.example.com"); // 送る順は triedAt の古い順
    expect(pickRowsToProbe(rows, "paid").deferred).toEqual([]);
    expect(pickRowsToProbe(rows, "paid").probe).toHaveLength(45);
  });

  test("null_tried_at_first_then_list_order", () => {
    const rows = [...rowsN(41).map((r) => ({ ...r, triedAt: 5 })), row("new.example.com")];
    const { probe, deferred } = pickRowsToProbe(rows, "free");
    expect(probe).toContain("new.example.com");
    expect(deferred).toEqual(["h39.example.com", "h40.example.com"]); // 同じ triedAt は一覧の順(後ろが残る)
  });

  test("paid_plan_probes_at_most_50", () => {
    // 移行で 50 行を超えた一覧も、Paid の 1 回の保存で送るのは MAX_DOMAINS 行まで
    const { probe, deferred } = pickRowsToProbe(rowsN(60), "paid");
    expect(probe).toHaveLength(MAX_DOMAINS);
    expect(deferred).toEqual(rowsN(60).slice(50).map((r) => r.value));
  });

  test("probe_order_is_oldest_tried_first_even_within_the_limit", () => {
    // 上限の内でも送る順は triedAt の古い順(null が先、同じなら一覧の順)
    const rows = [row("a.example.com", { triedAt: 30 }), row("b.example.com", { triedAt: 10 }), row("c.example.com"), row("d.example.com", { triedAt: 10 })];
    for (const plan of ["free", "paid"] as const) {
      expect(pickRowsToProbe(rows, plan)).toEqual({ probe: ["c.example.com", "b.example.com", "d.example.com", "a.example.com"], deferred: [] });
    }
  });
});

describe("probeDomains", () => {
  test("dev_rows_are_never_probed", async () => {
    const urls: string[] = [];
    const spy: typeof fetch = async (input) => {
      urls.push(String(input));
      return Response.json({ edge: "wtt", install: H });
    };
    const rows = [row("www.example.com"), row("http://localhost:8080", { verdict: "dev" })];
    expect(pickRowsToProbe(rows, "free")).toEqual({ probe: ["www.example.com"], deferred: [] });
    expect(await probeDomains(rows, { plan: "paid", installHash: H, fetchFn: spy })).toEqual([{ domain: "www.example.com", outcome: "edge" }]);
    expect(urls).toEqual(["https://www.example.com/__ab/ping"]);
  });

  test("null_install_hash_makes_every_row_unknown_without_fetching", async () => {
    let called = 0;
    const spy: typeof fetch = async () => {
      called++;
      return new Response(null, { status: 404 });
    };
    const out = await probeDomains(rowsN(42), { plan: "free", installHash: null, fetchFn: spy });
    expect(called).toBe(0);
    expect(out.filter((r) => r.outcome === "unknown")).toHaveLength(FREE_PROBE_LIMIT);
    expect(out.filter((r) => r.outcome === "deferred")).toHaveLength(2); // Free の上限の外は deferred のまま
    expect(out.some((r) => r.outcome === "outside")).toBe(false);
  });

  test("probes_at_most_6_at_a_time", async () => {
    let inFlight = 0;
    let peak = 0;
    const spy: typeof fetch = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return Response.json({ edge: "wtt", install: H });
    };
    const out = await probeDomains(rowsN(20), { plan: "paid", installHash: H, fetchFn: spy });
    expect(peak).toBe(PROBE_CONCURRENCY);
    expect(out.every((r) => r.outcome === "edge")).toBe(true);
    expect(out.map((r) => r.domain)).toEqual(rowsN(20).map((r) => r.value)); // 一覧の順で返す
  });

  test("queued_probes_are_not_aborted_by_slow_head", async () => {
    vi.useFakeTimers();
    // 先頭 6 本が応答しない間に、後ろの健全な 1 本が edge になる(打ち切りの時計は送り出したときから)
    const fetchFn: typeof fetch = async (input) => (String(input).startsWith("https://h6.") ? Response.json({ edge: "wtt", install: H }) : neverResolves(input));
    const out = await settleWithin(probeDomains(rowsN(7), { plan: "paid", installHash: H, fetchFn }), PROBE_TIMEOUT_MS);
    expect(out.find((r) => r.domain === "h6.example.com")?.outcome).toBe("edge");
    expect(out.filter((r) => r.outcome === "unknown")).toHaveLength(6);
  });

  test("total_deadline_defers_remaining_rows", async () => {
    vi.useFakeTimers();
    // 全部が応答しない 40 行 → 12 秒で終わり、確かめなかった行が deferred
    const out = await settleWithin(probeDomains(rowsN(40), { plan: "free", installHash: H, fetchFn: neverResolves }), PROBE_TOTAL_MS);
    expect(out).toHaveLength(40);
    expect(out.every((r) => r.outcome === "unknown" || r.outcome === "deferred")).toBe(true);
    // 3 秒ずつ 6 本で、12 秒の間に打ち切りまで終わるのは 18〜24 本。残りは deferred
    expect(out.filter((r) => r.outcome === "deferred").length).toBeGreaterThanOrEqual(16);
    expect(out.filter((r) => r.outcome === "unknown").length).toBeGreaterThanOrEqual(18);
  });
});

describe("全体の打ち切りの後も後ろの行が確かめられる", () => {
  /** 先頭 slow 行は応答しない・最後の 1 行(healthy.example.com)は edge と答える一覧で、保存を繰り返す(1 回 = 12 秒) */
  async function savesUntilHealthyIsProbed(slow: number, plan: "free" | "paid"): Promise<number> {
    vi.useFakeTimers();
    let rows = [...rowsN(slow), row("healthy.example.com")];
    const fetchFn: typeof fetch = async (input) => (String(input).startsWith("https://healthy.") ? Response.json({ edge: "wtt", install: H }) : neverResolves(input));
    for (let save = 1; save <= 5; save++) {
      const out = await settleWithin(probeDomains(rows, { plan, installHash: H, fetchFn }), PROBE_TOTAL_MS);
      rows = mergeProbeResults(rows, out, 1000 * save).rows;
      if (rows.find((r) => r.value === "healthy.example.com")!.verdict === "edge") return save;
    }
    return -1;
  }

  test("slow_head_rows_do_not_starve_a_healthy_tail_row_free", async () => {
    // Free・40 行以下: 1 回目は先頭の 24 行ほどで打ち切り、2 回目は送っていない行(triedAt が null)から送るので届く
    const saves = await savesUntilHealthyIsProbed(FREE_PROBE_LIMIT - 1, "free");
    expect(saves).toBeGreaterThan(1);
    expect(saves).toBeLessThanOrEqual(3);
  });

  test("slow_head_rows_do_not_starve_a_healthy_tail_row_paid", async () => {
    const saves = await savesUntilHealthyIsProbed(MAX_DOMAINS - 1, "paid");
    expect(saves).toBeGreaterThan(1);
    expect(saves).toBeLessThanOrEqual(3);
  });

  test("paid_plan_sends_at_most_50_fetches", async () => {
    let called = 0;
    const spy: typeof fetch = async () => {
      called++;
      return Response.json({ edge: "wtt", install: H });
    };
    const out = await probeDomains(rowsN(60), { plan: "paid", installHash: H, fetchFn: spy });
    expect(called).toBe(MAX_DOMAINS);
    expect(out.filter((r) => r.outcome === "edge")).toHaveLength(50);
    expect(out.filter((r) => r.outcome === "deferred").map((r) => r.domain)).toEqual(rowsN(60).slice(50).map((r) => r.value));
  });
});

describe("mergeProbeResults", () => {
  const edgeFetch: typeof fetch = async () => Response.json({ edge: "wtt", install: H });
  const outsideFetch: typeof fetch = async () => new Response("nope", { status: 404 });
  const unknownFetch: typeof fetch = async () => new Response(null, { status: 503 });

  test("confirmed_rows_do_not_starve_others", async () => {
    // 50 行で先頭 40 行が毎回 edge / outside で確定しても、2 回目の保存で残り 10 行が選ばれる(確定した行も triedAt が進むため)
    const rows = rowsN(50);
    const first = await probeDomains(rows, { plan: "free", installHash: H, fetchFn: async (i, init) => (String(i).includes("h1") ? outsideFetch(i, init) : edgeFetch(i, init)) });
    expect(first.filter((r) => r.outcome === "deferred").map((r) => r.domain)).toEqual(rows.slice(40).map((r) => r.value));
    const merged = mergeProbeResults(rows, first, 1000).rows;
    const second = pickRowsToProbe(merged, "free");
    expect(second.probe).toEqual(expect.arrayContaining(rows.slice(40).map((r) => r.value)));
  });

  test("persistently_unknown_rows_do_not_starve_others", async () => {
    // 50 行で先頭 40 行が毎回 unknown でも、2 回目の保存で残り 10 行が選ばれる(unknown でも triedAt が進むため)
    const rows = rowsN(50);
    const first = await probeDomains(rows, { plan: "free", installHash: H, fetchFn: unknownFetch });
    const merged = mergeProbeResults(rows, first, 1000);
    expect(merged.unknown).toHaveLength(40);
    const second = pickRowsToProbe(merged.rows, "free");
    expect(second.probe).toEqual(expect.arrayContaining(rows.slice(40).map((r) => r.value)));
  });

  test("confirmed_results_write_verdict_and_both_times", () => {
    const latest = [row("a.example.com", { verdict: "outside", checkedAt: 5, triedAt: 5 }), row("b.example.com")];
    const out = mergeProbeResults(
      latest,
      [
        { domain: "a.example.com", outcome: "edge" },
        { domain: "b.example.com", outcome: "outside" },
      ],
      100,
    );
    expect(out.rows).toEqual([row("a.example.com", { verdict: "edge", checkedAt: 100, triedAt: 100 }), row("b.example.com", { verdict: "outside", checkedAt: 100, triedAt: 100 })]);
    expect(out.changes).toEqual([
      { domain: "a.example.com", from: "outside", to: "edge" },
      { domain: "b.example.com", from: "unknown", to: "outside" },
    ]);
    expect(out.deferred).toEqual([]);
    expect(out.unknown).toEqual([]);
  });

  test("unknown_probe_does_not_revert_concurrently_confirmed_edge", () => {
    // 開始時点は outside。判定の間に別の保存が edge を確定 → この保存の結果が unknown でも、mergeProbeResults の後は edge のまま
    const latest = [row("a.example.com", { verdict: "edge", checkedAt: 50, triedAt: 50 })];
    const out = mergeProbeResults(latest, [{ domain: "a.example.com", outcome: "unknown" }], 100);
    expect(out.rows).toEqual([row("a.example.com", { verdict: "edge", checkedAt: 50, triedAt: 100 })]);
    expect(out.changes).toEqual([]);
  });

  test("merge_ignores_results_for_removed_rows_and_keeps_added_rows", () => {
    // 判定の間に別の保存で行が消えた・足された → 消えた行の結果は捨て、足された行は latest のまま
    const latest = [row("a.example.com"), row("added.example.com", { verdict: "outside", checkedAt: 7, triedAt: 7 })];
    const out = mergeProbeResults(
      latest,
      [
        { domain: "a.example.com", outcome: "edge" },
        { domain: "removed.example.com", outcome: "edge" },
        { domain: "gone.example.com", outcome: "unknown" },
        { domain: "gone2.example.com", outcome: "deferred" },
      ],
      100,
    );
    expect(out.rows).toEqual([row("a.example.com", { verdict: "edge", checkedAt: 100, triedAt: 100 }), latest[1]]);
    expect(out.changes).toEqual([{ domain: "a.example.com", from: "unknown", to: "edge" }]);
    expect(out.unknown).toEqual([]);
    expect(out.deferred).toEqual([]);
  });

  test("unknown_keeps_previous_verdict_and_time", () => {
    // 前回 edge(checkedAt 10)の行が unknown → 判定(edge)と checkedAt(10)は保ち、triedAt は進める。unknown に名前が入る、changes には入らない
    const latest = [row("x.example.com", { verdict: "edge", checkedAt: 10, triedAt: 10 }), row("y.example.com", { verdict: "edge", checkedAt: 10, triedAt: 10 })];
    const out = mergeProbeResults(
      latest,
      [
        { domain: "x.example.com", outcome: "unknown" },
        { domain: "y.example.com", outcome: "deferred" },
      ],
      100,
    );
    expect(out.rows).toEqual([row("x.example.com", { verdict: "edge", checkedAt: 10, triedAt: 100 }), latest[1]]);
    expect(out.unknown).toEqual(["x.example.com"]);
    expect(out.deferred).toEqual(["y.example.com"]);
    expect(out.changes).toEqual([]);
  });

  test("dev_row_in_latest_is_never_overwritten", () => {
    const latest = [row("http://localhost:8080", { verdict: "dev" })];
    const out = mergeProbeResults(latest, [{ domain: "http://localhost:8080", outcome: "outside" }], 100);
    expect(out.rows).toEqual(latest);
    expect(out.changes).toEqual([]);
  });
});

describe("導入の印(readProbeSettings / ensureInstallMarker / installHashOf)", () => {
  /** D1 の文を数える(prepare 1 回 = 往復 1 回) */
  function countingDb(): { db: D1Database; sqls: string[] } {
    const sqls: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "prepare")
          return (q: string) => {
            sqls.push(q);
            return target.prepare(q);
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as D1Database;
    return { db, sqls };
  }
  /** KV の put を数える */
  function countingKv(): { kv: KVNamespace; puts: string[] } {
    const puts: string[] = [];
    const kv = new Proxy(env.CONFIG_KV, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "put")
          return (key: string, ...rest: unknown[]) => {
            puts.push(key);
            return (v as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as KVNamespace;
    return { kv, puts };
  }
  const putD1Marker = (v: string) =>
    env.DB.prepare("INSERT INTO instance_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, 0, NULL)").bind(INSTALL_MARKER_KEY, JSON.stringify(v)).run();
  const d1Marker = async () => (await readProbeSettings(env.DB)).installMarker;

  test("read_probe_settings_reads_plan_and_marker", async () => {
    expect(await readProbeSettings(env.DB)).toEqual({ plan: "free", installMarker: null });
    await env.DB.prepare("INSERT INTO instance_settings (key, value, updated_at, updated_by) VALUES ('cloudflarePlan', '\"paid\"', 0, NULL)").run();
    await putD1Marker("m-1");
    expect(await readProbeSettings(env.DB)).toEqual({ plan: "paid", installMarker: "m-1" });
  });

  test("normal_save_reads_instance_settings_once", async () => {
    // D1 に印がある保存では instance_settings の SELECT は 1 回。KV にだけ印がある最初の保存は +2、どちらにも無い最初の保存は +3
    const steady = async () => {
      const { db, sqls } = countingDb();
      const { kv, puts } = countingKv();
      const { installMarker } = await readProbeSettings(db);
      const marker = await ensureInstallMarker({ ...env, CONFIG_KV: kv }, db, installMarker);
      return { marker, sqls, puts };
    };

    // どちらにも無い(新しい導入): 1 + 3(移行待ちの確かめ・INSERT・読み直し)、KV の put 1
    const fresh = await steady();
    expect(fresh.sqls).toHaveLength(4);
    expect(fresh.puts).toEqual([kvKeys.installMarker]);
    expect(fresh.marker).not.toBeNull();

    // D1 に印がある: 1 回だけ。KV は同じ値なので書かない
    const again = await steady();
    expect(again.sqls).toHaveLength(1);
    expect(again.sqls[0]).toMatch(/instance_settings/);
    expect(again.puts).toEqual([]);
    expect(again.marker).toBe(fresh.marker);

    // KV にだけ印がある(B139 の移行が書いた今の導入): 1 + 2(INSERT・読み直し)、KV は書かない
    await env.DB.prepare("DELETE FROM instance_settings WHERE key = ?1").bind(INSTALL_MARKER_KEY).run();
    await env.CONFIG_KV.put(kvKeys.installMarker, "kv-only");
    const kvOnly = await steady();
    expect(kvOnly.sqls).toHaveLength(3);
    expect(kvOnly.puts).toEqual([]);
    expect(kvOnly.marker).toBe("kv-only");
  });

  test("install_marker_is_created_on_fresh_install", async () => {
    // KV に印なし・サイトは移行待ち 0 件 → 印を作り、その SHA-256 を返す。2 回目は同じ値(上書きしない)
    const m1 = await ensureInstallMarker(env, env.DB, null);
    expect(m1).toMatch(/^[0-9a-f-]{36}$/);
    expect(await d1Marker()).toBe(m1);
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).toBe(m1);
    const hash = await installHashOf(m1);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // edge の check.ts と同じ計算(SHA-256 の小文字 16 進)
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m1!));
    expect(hash).toBe(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
    expect(await installHashOf(null)).toBeNull();

    expect(await ensureInstallMarker(env, env.DB, null)).toBe(m1);
    expect(await ensureInstallMarker(env, env.DB, await d1Marker())).toBe(m1);
  });

  test("install_marker_concurrent_creation_converges", async () => {
    // 同時に 2 回呼んでも同じ値
    const [a, b] = await Promise.all([ensureInstallMarker(env, env.DB, null), ensureInstallMarker(env, env.DB, null)]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(await d1Marker()).toBe(a);
  });

  test("install_marker_adopts_existing_kv_value", async () => {
    // KV にだけ値がある今の導入では、その値を D1 に入れる
    await env.CONFIG_KV.put(kvKeys.installMarker, "from-b139");
    expect(await ensureInstallMarker(env, env.DB, null)).toBe("from-b139");
    expect(await d1Marker()).toBe("from-b139");
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).toBe("from-b139");
  });

  test("install_marker_d1_wins_over_kv", async () => {
    // D1 が正。KV が違えば D1 の値を写す。edge はしばらく古い値を返しうるので、その保存では判定しない(null = すべて unknown)
    await putD1Marker("canonical");
    await env.CONFIG_KV.put(kvKeys.installMarker, "stale");
    expect(await ensureInstallMarker(env, env.DB, "canonical")).toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).toBe("canonical");
    expect(await ensureInstallMarker(env, env.DB, "canonical")).toBe("canonical");
  });

  test("install_marker_is_not_created_while_migration_pending", async () => {
    // share_migration_pending = 1 のサイトがある → null(判定はすべて unknown)
    const { token, workspaceId } = await setupOwner();
    const s = await createSite(token, workspaceId);
    await env.DB.prepare("UPDATE sites SET share_migration_pending = 1 WHERE id = ?1").bind(s.id).run();
    await env.CONFIG_KV.delete(kvKeys.installMarker);
    await env.DB.prepare("DELETE FROM instance_settings WHERE key = ?1").bind(INSTALL_MARKER_KEY).run();
    expect(await ensureInstallMarker(env, env.DB, null)).toBeNull();
    expect(await d1Marker()).toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.installMarker)).toBeNull();
  });
});

describe("テストの既定の fetch(偽の edge)", () => {
  test("default_fetch_is_a_fake_edge_answering_with_the_kv_marker", async () => {
    // fetchFn を渡さないときは global fetch。テストでは偽の edge が受け、外へは出ない
    expect(await probeDomains([row("www.example.com")], { plan: "free", installHash: H })).toEqual([{ domain: "www.example.com", outcome: "unknown" }]); // KV に印が無い = 503
    const marker = await ensureInstallMarker(env, env.DB, null);
    const hash = await installHashOf(marker);
    expect(await probeDomains([row("www.example.com")], { plan: "free", installHash: hash })).toEqual([{ domain: "www.example.com", outcome: "edge" }]);
    fakeEdgePing.set("other.example.com", () => new Response("not found", { status: 404 }));
    expect(await probeDomains([row("other.example.com")], { plan: "free", installHash: hash })).toEqual([{ domain: "other.example.com", outcome: "outside" }]);
  });
});

describe("E2E の偽の edge への宛先の上書き(AB_PROBE_ORIGIN_OVERRIDE)", () => {
  /** 送った URL を控える fetch(応答は edge の印) */
  const capture = () => {
    const urls: string[] = [];
    const fn: typeof fetch = async (input) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify({ edge: "wtt", install: H }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    return { urls, fn };
  };

  test("probe_override_only_for_localhost_and_test_domains", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // 手元の Origin で、.test のドメインなら上書きする(?host= に判定するドメイン)
    expect(probeUrl("edge.example.test", "http://127.0.0.1:8812")).toBe("http://127.0.0.1:8812/__ab/ping?host=edge.example.test");
    expect(probeUrl("edge.example.test", "http://localhost:8812")).toBe("http://localhost:8812/__ab/ping?host=edge.example.test");
    expect(err).not.toHaveBeenCalled();
    // 実在しうるドメイン(.test 以外)は上書きしない
    expect(probeUrl("www.example.com", "http://127.0.0.1:8812")).toBe("https://www.example.com/__ab/ping");
    // 手元でない Origin・形の違う値は上書きしない
    for (const bad of ["https://127.0.0.1:8812", "http://evil.example.com:8812", "http://127.0.0.1", "http://127.0.0.1:8812/", "http://127.0.0.1:8812/x", "http://10.0.0.1:80"]) {
      expect(probeUrl("edge.example.test", bad)).toBe("https://edge.example.test/__ab/ping");
    }
    expect(err).toHaveBeenCalledTimes(7); // 無視した上書きはログに残す
    // 未設定・空は何もしない(ログも残さない)
    err.mockClear();
    expect(probeUrl("edge.example.test", undefined)).toBe("https://edge.example.test/__ab/ping");
    expect(probeUrl("edge.example.test", "")).toBe("https://edge.example.test/__ab/ping");
    expect(err).not.toHaveBeenCalled();
    // probeDomains は opts.originOverride を各行の宛先に使う
    const c = capture();
    expect(
      await probeDomains([row("edge.example.test"), row("www.example.com")], { plan: "free", installHash: H, fetchFn: c.fn, originOverride: "http://127.0.0.1:8812" }),
    ).toEqual([
      { domain: "edge.example.test", outcome: "edge" },
      { domain: "www.example.com", outcome: "edge" },
    ]);
    expect(c.urls.sort()).toEqual(["http://127.0.0.1:8812/__ab/ping?host=edge.example.test", "https://www.example.com/__ab/ping"]);
  });

  test("probe_override_needs_the_e2e_enable_var", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    err.mockClear(); // 前のテストの spy が残っていても数え直す
    // 上書きの値だけでは効かない(本番の設定に紛れても、実在のドメインの確かめを手元へ向けない)
    expect(probeOverrideFromEnv({ AB_PROBE_ORIGIN_OVERRIDE: "http://127.0.0.1:8812" })).toBeUndefined();
    expect(probeOverrideFromEnv({ AB_PROBE_ORIGIN_OVERRIDE: "http://127.0.0.1:8812", AB_E2E_PROBE_OVERRIDE_ENABLED: "true" })).toBeUndefined();
    expect(err).toHaveBeenCalledTimes(2);
    // 2 つそろうと効く。値が無ければ何もしない(ログも残さない)
    expect(probeOverrideFromEnv({ AB_PROBE_ORIGIN_OVERRIDE: "http://127.0.0.1:8812", AB_E2E_PROBE_OVERRIDE_ENABLED: "1" })).toBe("http://127.0.0.1:8812");
    err.mockClear();
    expect(probeOverrideFromEnv({ AB_E2E_PROBE_OVERRIDE_ENABLED: "1" })).toBeUndefined();
    expect(probeOverrideFromEnv({})).toBeUndefined();
    expect(err).not.toHaveBeenCalled();
  });

  test("probe_override_alone_does_not_redirect_site_creation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // 手元(127.0.0.1)の偽の edge は outside と答え、実在の宛先(edge.example.test)は edge と答える
    fakeEdgePing.set("127.0.0.1", () => new Response("not found", { status: 404 }));
    await ensureInstallMarker(env, env.DB, null);
    const { token, workspaceId } = await setupOwner();
    const createB = async (envOverride: Record<string, string>) => {
      const res = await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { name: "s", domains: ["edge.example.test"], mode: "B" }, envOverride });
      expect(res.status).toBe(201);
      return (await json<{ domains: DomainRow[]; id: string }>(res)).domains[0]!.verdict;
    };
    // 上書きだけ: 宛先は変わらない(edge)
    expect(await createB({ AB_PROBE_ORIGIN_OVERRIDE: "http://127.0.0.1:8812" })).toBe("edge");
    // 2 つそろうと手元へ向く(outside)。同じホストは別のサイトが持てないので、前のサイトを消してから
    await env.DB.prepare("delete from site_hosts").run();
    expect(await createB({ AB_PROBE_ORIGIN_OVERRIDE: "http://127.0.0.1:8812", AB_E2E_PROBE_OVERRIDE_ENABLED: "1" })).toBe("outside");
  });

  test("probe_override_is_not_in_production_wrangler_configs", () => {
    // 開発リポジトリでは公開版の overlay も見る(公開リポジトリには release/ が無いので control の設定だけ)
    const configs = env.TEST_WRANGLER_CONFIGS;
    expect(Object.keys(configs)).toContain("apps/control/wrangler.jsonc");
    for (const [file, text] of Object.entries(configs)) {
      expect(text.length, file).toBeGreaterThan(0);
      expect(text, file).not.toContain("AB_PROBE_ORIGIN_OVERRIDE");
      expect(text, file).not.toContain("AB_E2E_PROBE_OVERRIDE_ENABLED");
    }
  });
});
