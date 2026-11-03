import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kvKeys } from "@wtt/core";
import { getDb } from "../src/db";
import { deriveDomainColumns, type DomainRow } from "../src/domains";
import { writeInstanceSettings } from "../src/instance-settings";
import { call, createSite, fakeEdgePing, fakeEdgeResponse, json, setupOwner, siteRow } from "./helpers";

// B148 Task 2: サイトの作成・保存は domains だけを受ける。旧い 3 列は一覧から導いて書く(P10・plan の「D1 の持ち方」)

type Issue = { path: (string | number)[]; message: string };
type Body = Record<string, any> & { error?: string; hint?: string; issues?: Issue[] };

const row = (value: string, verdict: DomainRow["verdict"]): DomainRow => ({ value, verdict, checkedAt: null, triedAt: null });

async function owner() {
  const o = await setupOwner();
  const patch = async (sid: string, body: Record<string, unknown>, envOverride?: Record<string, unknown>) => {
    const res = await call("PATCH", `/sites/${sid}`, { token: o.token, body, envOverride });
    return { status: res.status, body: await json<Body>(res) };
  };
  const create = async (body: Record<string, unknown>, envOverride?: Record<string, unknown>) => {
    const res = await call("POST", `/workspaces/${o.workspaceId}/sites`, { token: o.token, body, envOverride });
    return { status: res.status, body: await json<Body>(res) };
  };
  return { ...o, patch, create };
}

/** D1 の旧い 3 列が domains_json から導いた値と一致する */
async function expectDerived(sid: string): Promise<void> {
  const r = await siteRow(sid);
  const d = deriveDomainColumns(JSON.parse(r.domains_json) as DomainRow[], r.mode);
  expect({ domain: r.domain, allowedOrigins: JSON.parse(r.allowed_origins_json), hosts: JSON.parse(r.hosts_json) }).toEqual(d);
}

/** 判定(Task 4)の代わりに、D1 の一覧の行の判定を直接書く(3 列は次の保存が導き直す) */
async function setVerdicts(sid: string, rows: DomainRow[]): Promise<void> {
  await env.DB.prepare("update sites set domains_json = ? where id = ?").bind(JSON.stringify(rows), sid).run();
}

afterEach(() => vi.restoreAllMocks());

describe("site domains on write (B148)", () => {
  it("patch_rejects_legacy_fields_with_hint", async () => {
    const { patch, token, workspaceId } = await owner();
    const { id: sid } = await createSite(token, workspaceId);
    for (const [field, value] of [["allowedOrigins", ["https://www.example.com"]], ["hosts", ["www.example.com"]], ["domain", "www.example.com"]] as const) {
      const r = await patch(sid, { [field]: value });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe("legacy_domain_fields");
      expect(r.body.path).toEqual([field]);
      expect(r.body.hint).toContain("domains");
      expect(typeof r.body.message).toBe("string");
    }
    // 新しい欄と一緒に送っても旧い欄を断る
    const both = await patch(sid, { domains: ["www.example.com"], hosts: ["www.example.com"] });
    expect(both.body.error).toBe("legacy_domain_fields");
  });

  it("patch_domains_rewrites_derived_columns_and_cookie_groups", async () => {
    const { patch, token, workspaceId } = await owner();
    const { id: sid } = await createSite(token, workspaceId);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Mode A のサイトに 2 行。判定はしない(Mode A)
    const r = await patch(sid, { domains: ["www.example.com", "form.example.com"] });
    expect(r.status).toBe(200);
    expect(r.body.domain).toBe("www.example.com");
    expect(r.body.allowedOrigins).toEqual(["https://www.example.com", "https://form.example.com"]);
    expect(r.body.cookieGroups).toEqual([{ domain: "example.com", hosts: ["www.example.com", "form.example.com"] }]);
    expect(r.body.domains).toEqual([row("www.example.com", "unknown"), row("form.example.com", "unknown")]);
    expect(r.body).toMatchObject({ edgeDomains: [], outsideDomains: [], uncheckedDomains: [] }); // Mode A は 3 つとも空
    expect(r.body).not.toHaveProperty("hosts");
    expect(fetchSpy).toHaveBeenCalledTimes(0); // Mode A は fetch が 0 回
    // KV の設定の記録の形は変わらない(allowedOrigins・hosts)
    const kv = JSON.parse((await env.CONFIG_KV.get(kvKeys.settings(sid)))!);
    expect(kv.allowedOrigins).toEqual(["https://www.example.com", "https://form.example.com"]);
    expect(kv.hosts).toEqual([]);
  });

  it("create_and_patch_accept_default_ports", async () => {
    // 既定のポート付きの入力も保存できる(Origin の正規形にそろえる。core の設定の検査で 422 にならない)
    const { create, patch } = await owner();
    const created = await create({ name: "s", domains: ["https://www.example.com:443", "http://localhost:80"] });
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    expect(created.body.domains).toEqual([row("www.example.com", "unknown"), row("http://localhost", "dev")]);
    expect(created.body.allowedOrigins).toEqual(["https://www.example.com", "http://localhost"]);
    await expectDerived(sid);
    const saved = await patch(sid, { domains: ["www.example.com", "http://127.0.0.1:80", "form.example.com:443"] });
    expect(saved.status).toBe(200);
    expect(saved.body.allowedOrigins).toEqual(["https://www.example.com", "http://127.0.0.1", "https://form.example.com"]);
    await expectDerived(sid);
  });

  it("patch_domains_normalizes_input_and_keeps_previous_verdicts", async () => {
    const { patch, token, workspaceId } = await owner();
    const { id: sid } = await createSite(token, workspaceId, { domains: ["www.example.com"] });
    expect((await patch(sid, { mode: "B" })).status).toBe(200);
    await setVerdicts(sid, [row("www.example.com", "edge"), { value: "shop.example.com", verdict: "outside", checkedAt: 100, triedAt: 100 }]);
    // B148 Task 4: Mode B の保存は判定する。ここでは前の判定を保つことを見るので、確かめられない(429 = unknown)ようにする
    for (const h of ["www.example.com", "shop.example.com", "new.example.com"]) fakeEdgePing.set(h, () => new Response("", { status: 429 }));
    const r = await patch(sid, { domains: [" HTTPS://WWW.Example.com/ ", "shop.example.com", "new.example.com", "http://localhost:8080"] });
    expect(r.status).toBe(200);
    // 同じ値の前の行は判定と checkedAt を保つ(unknown は triedAt だけ進む)。新しい行は unknown、開発用は dev
    const tried = expect.any(Number);
    expect(r.body.domains).toEqual([
      { value: "www.example.com", verdict: "edge", checkedAt: null, triedAt: tried },
      { value: "shop.example.com", verdict: "outside", checkedAt: 100, triedAt: tried },
      { value: "new.example.com", verdict: "unknown", checkedAt: null, triedAt: tried },
      row("http://localhost:8080", "dev"),
    ]);
    expect(r.body.domainChecks).toEqual({ changes: [], deferred: [], unknown: ["www.example.com", "shop.example.com", "new.example.com"] });
    expect(r.body).toMatchObject({ edgeDomains: ["www.example.com"], outsideDomains: ["shop.example.com"], uncheckedDomains: ["new.example.com"] });
    expect(r.body.allowedOrigins).toEqual(["https://www.example.com", "https://shop.example.com", "https://new.example.com", "http://localhost:8080"]);
    // edge の行はホストとして持つ(site_hosts と KV のホストのキー)
    expect(await env.CONFIG_KV.get(kvKeys.host("www.example.com"))).toBe(sid);
    expect((await env.DB.prepare("select site_id from site_hosts where host = 'www.example.com'").first<{ site_id: string }>())?.site_id).toBe(sid);
    await expectDerived(sid);
  });

  it("derived_columns_match_domains_after_every_write", async () => {
    const { patch, create, token, workspaceId } = await owner();
    // 作成
    const created = await create({ name: "s", domains: ["www.example.com", "http://localhost:3000"] });
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    await expectDerived(sid);
    // PATCH(domains)
    expect((await patch(sid, { domains: ["shop.example.com", "www.example.com"] })).status).toBe(200);
    await expectDerived(sid);
    expect((await siteRow(sid)).domain).toBe("shop.example.com"); // 代表は先頭の行
    // Mode の切り替え(A → B → A)。edge の行が無ければ hosts は空、edge の行があれば Mode B の間だけ hosts に載る
    expect((await patch(sid, { mode: "B" })).status).toBe(200);
    await expectDerived(sid);
    await setVerdicts(sid, [row("shop.example.com", "edge"), row("www.example.com", "unknown")]);
    expect((await patch(sid, { name: "一般の節だけ" })).status).toBe(200); // 一般の節だけの保存
    await expectDerived(sid);
    expect(JSON.parse((await siteRow(sid)).hosts_json)).toEqual(["shop.example.com"]);
    expect((await patch(sid, { mode: "A" })).status).toBe(200);
    await expectDerived(sid);
    expect(JSON.parse((await siteRow(sid)).hosts_json)).toEqual([]);
    expect((await env.DB.prepare("select count(*) as n from site_hosts where site_id = ?").bind(sid).first<{ n: number }>())!.n).toBe(0);
    // createSite の既定(1 行)
    const other = await createSite(token, workspaceId);
    await expectDerived(other.id);
  });

  it("invalid_domains_returns_japanese_message_per_row", async () => {
    const { patch, token, workspaceId } = await owner();
    const { id: sid } = await createSite(token, workspaceId);
    const r = await patch(sid, { domains: ["www.example.com", "www.example.com/form", "*.example.com", "ex ample.com", "https://www.example.com"] });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("invalid_domains");
    const at = (i: number) => r.body.issues!.find((x) => x.path.join(".") === `domains.${i}`)!.message;
    expect(at(1)).toMatch(/パス/);
    expect(at(2)).toMatch(/\*/);
    expect(at(3)).toMatch(/ドメイン/);
    expect(at(4)).toMatch(/同じ/);
    expect(r.body.path).toEqual(["domains", 1]);
    expect(typeof r.body.message).toBe("string");
    expect(JSON.stringify(r.body)).not.toMatch(/Invalid string|must match pattern|Too (big|small)/);
    // 行に結び付かないもの
    const empty = await patch(sid, { domains: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.issues).toEqual([{ path: ["domains"], message: expect.stringMatching(/1 つ以上/) }]);
    const many = await patch(sid, { domains: Array.from({ length: 51 }, (_, i) => `h${i}.example.com`) });
    expect(many.status).toBe(422);
    expect(many.body.issues).toEqual([{ path: ["domains"], message: "50 行までです。使っていない行を消してください" }]);
    // 50 行は通る
    expect((await patch(sid, { domains: Array.from({ length: 50 }, (_, i) => `h${i}.example.com`) })).status).toBe(200);
  });

  it("public_suffix_row_is_422_when_sharing_on", async () => {
    const { patch, token, workspaceId } = await owner();
    const { id: sid } = await createSite(token, workspaceId); // 共有オン
    const r = await patch(sid, { domains: ["www.example.com", "co.jp"] });
    expect(r.status).toBe(422);
    expect(r.body.issues!.find((i) => i.path.join(".") === "domains.1")!.message).toMatch(/公開の接尾辞/);
    // 開発用・IP・localhost は当たらない
    expect((await patch(sid, { domains: ["www.example.com", "localhost", "127.0.0.1", "http://localhost:8080"] })).status).toBe(200);
    expect((await patch(sid, { shareSubdomains: false, domains: ["www.example.com", "co.jp"] })).status).toBe(200);
  });

  it("create_takes_domains_and_rejects_domain", async () => {
    const { create } = await owner();
    const ok = await create({ name: "s", domains: ["www.example.com"] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ domain: "www.example.com", allowedOrigins: ["https://www.example.com"], domains: [row("www.example.com", "unknown")] });
    const legacy = await create({ name: "s", domain: "www.example.com" });
    expect(legacy.status).toBe(422);
    expect(legacy.body.error).toBe("legacy_domain_fields");
    expect(legacy.body.path).toEqual(["domain"]);
    // domains が無い・不正な行
    expect((await create({ name: "s" })).body.error).toBe("validation_failed");
    const bad = await create({ name: "s", domains: ["www.example.com/a"] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("invalid_domains");
    expect(bad.body.issues![0]!.path).toEqual(["domains", 0]);
  });

  it("get_returns_domains_and_read_only_derived_values", async () => {
    const { token, workspaceId } = await owner();
    const { id: sid } = await createSite(token, workspaceId, { domains: ["www.example.com", "form.example.com"] });
    const got = await json<Body>(await call("GET", `/sites/${sid}`, { token }));
    expect(got).toMatchObject({
      domain: "www.example.com",
      allowedOrigins: ["https://www.example.com", "https://form.example.com"],
      domains: [row("www.example.com", "unknown"), row("form.example.com", "unknown")],
      edgeDomains: [],
      outsideDomains: [],
      uncheckedDomains: [],
    });
    expect(got).not.toHaveProperty("hosts");
  });

  it("sharing_turned_on_rejects_public_suffix_rows", async () => {
    // 共有をオンにする保存は、domains を送らなくても公開の接尾辞の行を断る(一覧を送った保存と同じ 422)
    const { patch, token, workspaceId } = await owner();
    const { id: sid } = await createSite(token, workspaceId);
    expect((await patch(sid, { shareSubdomains: false, domains: ["www.example.com", "co.jp"] })).status).toBe(200);
    const r = await patch(sid, { shareSubdomains: true });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("invalid_domains");
    expect(r.body.issues!.find((i) => i.path.join(".") === "domains.1")!.message).toMatch(/公開の接尾辞/);
    // オフのままの保存は通る
    expect((await patch(sid, { name: "renamed" })).status).toBe(200);
  });
});

// B148 Task 4: 保存と作成で Cloudflare 経由かを確かめる(偽の edge = test/helpers.ts の installFakeEdge)

const kvHostKey = (h: string) => env.CONFIG_KV.get(kvKeys.host(h));
const hostOwner = async (h: string) => (await env.DB.prepare("select site_id from site_hosts where host = ?").bind(h).first<{ site_id: string }>())?.site_id ?? null;
const status = (code: number) => () => new Response("", { status: code });

/** /__ab/ping への fetch の回数を数える(偽の edge の上に spy を重ねる) */
function pingCounter() {
  const spy = vi.spyOn(globalThis, "fetch");
  return () => spy.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).endsWith("/__ab/ping")).length;
}

/** KV の put の鍵を記録する(envOverride の CONFIG_KV に渡す) */
function recordingKv() {
  const puts: string[] = [];
  const kv = new Proxy(env.CONFIG_KV, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (p === "put")
        return (key: string, ...rest: unknown[]) => {
          puts.push(key);
          return (v as (...a: unknown[]) => unknown).apply(t, [key, ...rest]);
        };
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as KVNamespace;
  return { puts, kv };
}

/** 判定の fetch を止める門。arrivals 回着いたら reached が解け、release() の後で偽の edge の既定の応答を返す */
function gate(arrivals = 1) {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const opened = new Promise<void>((r) => (open = r));
  let n = 0;
  const handler = async () => {
    if (++n === arrivals) reach();
    await opened;
    return fakeEdgeResponse();
  };
  return { handler, reached, release: () => open() };
}

describe("site domains are checked on save and mode B create (B148 Task 4)", () => {
  it("patch_with_domains_on_mode_b_probes_and_saves_edge", async () => {
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string;
    fakeEdgePing.set("form.example.com", status(404));
    const r = await patch(sid, { domains: ["www.example.com", "form.example.com"] });
    expect(r.status).toBe(200);
    expect(r.body.edgeDomains).toEqual(["www.example.com"]);
    expect(r.body.outsideDomains).toEqual(["form.example.com"]);
    expect(r.body.domainChecks).toEqual({ changes: [{ domain: "form.example.com", from: "unknown", to: "outside" }], deferred: [], unknown: [] });
    expect(await kvHostKey("www.example.com")).toBe(sid);
    expect(await kvHostKey("form.example.com")).toBeNull();
    expect(await hostOwner("www.example.com")).toBe(sid);
    await expectDerived(sid);
  });

  it("patch_without_domains_does_not_probe", async () => {
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string;
    const pings = pingCounter();
    const r = await patch(sid, { name: "renamed" });
    expect(r.status).toBe(200);
    expect(pings()).toBe(0);
    expect(r.body.domainChecks).toBeNull();
    expect(r.body.edgeDomains).toEqual(["www.example.com"]);
    // Mode A は domains を送っても確かめない
    const a = (await create({ name: "a", domains: ["www.a-site.com"] })).body.id as string;
    const ra = await patch(a, { domains: ["www.a-site.com", "shop.a-site.com"] });
    expect(ra.status).toBe(200);
    expect(ra.body.domainChecks).toBeNull();
    expect(pings()).toBe(0);
  });

  it("switch_a_to_b_probes_even_without_domains", async () => {
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com", "form.example.com"] })).body.id as string;
    fakeEdgePing.set("form.example.com", status(404));
    const pings = pingCounter();
    const r = await patch(sid, { mode: "B" });
    expect(r.status).toBe(200);
    expect(pings()).toBe(2);
    expect(r.body).toMatchObject({ edgeDomains: ["www.example.com"], outsideDomains: ["form.example.com"], uncheckedDomains: [] });
    expect(await kvHostKey("www.example.com")).toBe(sid);
    expect(await hostOwner("www.example.com")).toBe(sid);
  });

  it("switch_b_to_a_releases_hosts_without_probe", async () => {
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string;
    expect(await kvHostKey("www.example.com")).toBe(sid);
    const pings = pingCounter();
    const r = await patch(sid, { mode: "A" });
    expect(r.status).toBe(200);
    expect(pings()).toBe(0);
    expect(r.body.domainChecks).toBeNull();
    expect(await kvHostKey("www.example.com")).toBeNull();
    expect(await hostOwner("www.example.com")).toBeNull();
  });

  it("switch_back_to_b_does_not_trust_verdicts_from_before_mode_a", async () => {
    // B → A → B: A の間は確かめないので、A の前の edge を確かめずに使わない。確かめられなければ(429)未確認
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string;
    expect((await patch(sid, { mode: "A" })).status).toBe(200);
    fakeEdgePing.set("www.example.com", status(429));
    const r = await patch(sid, { mode: "B" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ edgeDomains: [], uncheckedDomains: ["www.example.com"] });
    expect(r.body.domainChecks).toEqual({ changes: [], deferred: [], unknown: ["www.example.com"] });
    expect(await kvHostKey("www.example.com")).toBeNull();
    expect(await hostOwner("www.example.com")).toBeNull();
    // 確かめられれば edge に戻る
    fakeEdgePing.delete("www.example.com");
    const again = await patch(sid, { domains: ["www.example.com"] });
    expect(again.body.edgeDomains).toEqual(["www.example.com"]);
    expect(await kvHostKey("www.example.com")).toBe(sid);
  });

  it("patch_keeps_previous_edge_when_probe_unknown", async () => {
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string;
    fakeEdgePing.set("www.example.com", status(429));
    const r = await patch(sid, { domains: ["www.example.com"] });
    expect(r.status).toBe(200);
    expect(r.body.edgeDomains).toEqual(["www.example.com"]);
    expect(r.body.domainChecks).toEqual({ changes: [], deferred: [], unknown: ["www.example.com"] });
    expect(await kvHostKey("www.example.com")).toBe(sid);
    expect(await hostOwner("www.example.com")).toBe(sid);
  });

  it("default_https_port_row_is_a_normal_row_probed_and_shared_on_mode_b", async () => {
    // r2 CX-Medium-3: https の既定のポート(:443)は外して通常の行にする。開発用(dev)にせず、Mode B では確かめ、共有の範囲にも入る
    const { patch, create } = await owner();
    const pings = pingCounter();
    const created = await create({ name: "s", domains: ["www.example.com:443"], mode: "B" });
    expect(created.status).toBe(201);
    const sid = created.body.id as string;
    expect(pings()).toBe(1);
    expect(created.body.domains).toEqual([{ value: "www.example.com", verdict: "edge", checkedAt: expect.any(Number), triedAt: expect.any(Number) }]);
    expect(created.body.edgeDomains).toEqual(["www.example.com"]);
    const shared = await patch(sid, { shareSubdomains: true });
    expect(shared.status).toBe(200);
    expect(shared.body.cookieGroups).toEqual([{ domain: "example.com", hosts: ["www.example.com"] }]);
    expect(await kvHostKey("www.example.com")).toBe(sid);
    const before = (JSON.parse((await siteRow(sid)).domains_json) as DomainRow[])[0]!;

    // 既に通常の行として持っている値に :443 付きで送り直しても、同じ行として前の判定と checkedAt を保つ(確かめられない 429 でも edge のまま)
    fakeEdgePing.set("www.example.com", status(429));
    const again = await patch(sid, { domains: ["https://www.example.com:443", "shop.example.com:443"] });
    expect(again.status).toBe(200);
    expect(again.body.domains[0]).toEqual({ value: "www.example.com", verdict: "edge", checkedAt: before.checkedAt, triedAt: expect.any(Number) });
    expect(again.body.domains[1]).toMatchObject({ value: "shop.example.com", verdict: "edge" });
    expect(again.body.edgeDomains).toEqual(["www.example.com", "shop.example.com"]);
    expect(again.body.cookieGroups).toEqual([{ domain: "example.com", hosts: ["www.example.com", "shop.example.com"] }]);
    expect(await kvHostKey("www.example.com")).toBe(sid);
    await expectDerived(sid);
  });

  it("removing_edge_domain_releases_host", async () => {
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string;
    expect((await patch(sid, { domains: ["www.example.com", "shop.example.com"] })).body.edgeDomains).toEqual(["www.example.com", "shop.example.com"]);
    expect(await kvHostKey("shop.example.com")).toBe(sid);
    const r = await patch(sid, { domains: ["www.example.com"] });
    expect(r.status).toBe(200);
    expect(await kvHostKey("shop.example.com")).toBeNull();
    expect(await hostOwner("shop.example.com")).toBeNull();
    expect(await kvHostKey("www.example.com")).toBe(sid);
  });

  it("edge_row_taken_by_another_site_is_409_host_in_use", async () => {
    const { patch, create } = await owner();
    const first = (await create({ name: "s1", domains: ["www.taken.com"], mode: "B" })).body.id as string;
    expect(await hostOwner("www.taken.com")).toBe(first);
    const second = (await create({ name: "s2", domains: ["www.other.com"], mode: "B" })).body.id as string;
    const r = await patch(second, { domains: ["www.other.com", "www.taken.com"] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("host_in_use");
    // 取られた側も保存しようとした側も変わらない
    expect(await hostOwner("www.taken.com")).toBe(first);
    expect(await kvHostKey("www.taken.com")).toBe(first);
    expect((JSON.parse((await siteRow(second)).domains_json) as DomainRow[]).map((d) => d.value)).toEqual(["www.other.com"]);
  });

  it("create_mode_b_probes_the_first_row", async () => {
    const { create } = await owner();
    const pings = pingCounter();
    const r = await create({ name: "s", domains: ["www.example.com", "shop.example.com"], mode: "B" });
    expect(r.status).toBe(201);
    expect(pings()).toBe(1);
    expect(r.body).toMatchObject({ edgeDomains: ["www.example.com"], uncheckedDomains: ["shop.example.com"] });
    // 2 行目以降は作成では確かめず、次の保存で確かめる行(deferred)として返す
    expect(r.body.domainChecks).toEqual({ changes: [{ domain: "www.example.com", from: "unknown", to: "edge" }], deferred: ["shop.example.com"], unknown: [] });
    const sid = r.body.id as string;
    // 開発用の行は deferred に入れない
    const dev = await create({ name: "d", domains: ["www.dev-site.com", "http://localhost:3000", "shop.dev-site.com"], mode: "B" });
    expect(dev.body.domainChecks.deferred).toEqual(["shop.dev-site.com"]);
    expect(await kvHostKey("www.example.com")).toBe(sid);
    expect(await hostOwner("www.example.com")).toBe(sid);
    await expectDerived(sid);
    // Mode A の作成は確かめない
    const a = await create({ name: "a", domains: ["www.a-site.com"] });
    expect(a.status).toBe(201);
    expect(a.body.domainChecks).toBeNull();
    expect(pings()).toBe(2);
  });

  it("free_plan_defers_rows_over_40", async () => {
    const { patch, create } = await owner();
    await writeInstanceSettings(getDb(env), { cloudflarePlan: "free" }, null);
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string;
    const domains = ["www.example.com", ...Array.from({ length: 44 }, (_, i) => `h${i}.example.com`)];
    const pings = pingCounter();
    const r = await patch(sid, { domains });
    expect(r.status).toBe(200);
    expect(pings()).toBe(40);
    // 確かめたことのない行(triedAt が null)が先。作成で確かめた www と、残りの 4 行が次の保存に回る
    expect(r.body.domainChecks.deferred).toEqual(["www.example.com", "h40.example.com", "h41.example.com", "h42.example.com", "h43.example.com"]);
    expect(r.body.edgeDomains).toHaveLength(41); // www は前の edge を保つ
  });

  it("save_writes_kv_host_keys_only_for_new_edge_hosts", async () => {
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string; // 導入の印もここで作られる
    const add = recordingKv();
    expect((await patch(sid, { domains: ["www.example.com", "shop.example.com"] }, { CONFIG_KV: add.kv })).status).toBe(200);
    // 前回 edge だった www はもう書かない(put の回数 = 記録 1 + 新しいホストの数)
    expect(add.puts).toEqual([kvKeys.settings(sid), kvKeys.host("shop.example.com")]);
    const rename = recordingKv();
    expect((await patch(sid, { name: "renamed" }, { CONFIG_KV: rename.kv })).status).toBe(200);
    expect(rename.puts).toEqual([kvKeys.settings(sid)]);
    expect(await kvHostKey("www.example.com")).toBe(sid);
    expect(await kvHostKey("shop.example.com")).toBe(sid);
  });

  it("domain_growth_commits_claims_before_kv", async () => {
    // 2 つのサイトが同じ登録ドメイン(shared-test.com)の行を同時に足す。どちらも衝突の検査を通った後で判定を待たせ、
    // 共有の予約に負けた側(422)の設定は KV に一度も書かれない
    const { patch, create } = await owner();
    const a = (await create({ name: "a", domains: ["www.aa-site.com"], mode: "B" })).body.id as string;
    const b = (await create({ name: "b", domains: ["www.bb-site.com"], mode: "B" })).body.id as string;
    const g = gate(2);
    fakeEdgePing.set("a.shared-test.com", g.handler);
    fakeEdgePing.set("b.shared-test.com", g.handler);
    const ka = recordingKv();
    const kb = recordingKv();
    const pa = patch(a, { domains: ["www.aa-site.com", "a.shared-test.com"] }, { CONFIG_KV: ka.kv });
    const pb = patch(b, { domains: ["www.bb-site.com", "b.shared-test.com"] }, { CONFIG_KV: kb.kv });
    await g.reached;
    g.release();
    const [ra, rb] = await Promise.all([pa, pb]);
    expect([ra.status, rb.status].sort()).toEqual([200, 422]);
    const [loser, loserKv, loserRes] = ra.status === 422 ? [a, ka, ra] : [b, kb, rb];
    expect(loserRes.body.error).toBe("sharing_conflict");
    expect(loserKv.puts.filter((k) => k === kvKeys.settings(loser) || k.startsWith("host:"))).toEqual([]);
    const kv = JSON.parse((await env.CONFIG_KV.get(kvKeys.settings(loser)))!);
    expect(kv.allowedOrigins).toHaveLength(1);
  });

  it("concurrent_save_during_probe_does_not_revert_other_fields", async () => {
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string;
    const g = gate();
    fakeEdgePing.set("new.example.com", g.handler);
    const first = patch(sid, { domains: ["www.example.com", "new.example.com"] });
    await g.reached;
    // 判定の fetch を止めている間に、別の保存が名前と保持期間を変える(こちらは判定しない)
    const other = await patch(sid, { name: "renamed", retentionDays: 120 });
    expect(other.status).toBe(200);
    g.release();
    const r = await first;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "renamed", retentionDays: 120, edgeDomains: ["www.example.com", "new.example.com"] });
    const saved = await siteRow(sid);
    expect(saved.name).toBe("renamed");
    expect(saved.retention_days).toBe(120);
    const kv = JSON.parse((await env.CONFIG_KV.get(kvKeys.settings(sid)))!);
    expect(kv.retentionDays).toBe(120);
    expect(kv.hosts).toEqual(["www.example.com", "new.example.com"]);
  });

  it("retention_shrink_check_uses_the_row_read_after_probe", async () => {
    // 保存 1 は保持期間 30 のまま(縮めない)で domains を送り、判定を待つ。その間に保存 2 が 90 に延ばし、60 日の条件を持つオーディエンスができる。
    // 保存 1 を進めると、当て直した patch は 90 → 30 の短縮になるので、読み直した行と比べて 422 にする(黙って縮めない)
    const { patch, create, token } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B", retentionDays: 30 })).body.id as string;
    const g = gate();
    fakeEdgePing.set("new.example.com", g.handler);
    const first = patch(sid, { domains: ["www.example.com", "new.example.com"], retentionDays: 30 });
    await g.reached;
    expect((await patch(sid, { retentionDays: 90 })).status).toBe(200);
    expect((await call("POST", `/sites/${sid}/goals`, { token, body: { id: "g_lead", name: "資料請求", type: "CUSTOM", config: {} } })).status).toBe(201);
    const aud = await call("POST", `/sites/${sid}/audiences`, { token, body: { id: "aud_60", name: "60 日", definition: { hist: "converted", goal: "g_lead", withinDays: 60 } } });
    expect(aud.status).toBe(201);
    g.release();
    const r = await first;
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("within_days_exceeds_retention");
    expect((await siteRow(sid)).retention_days).toBe(90);
  });

  it("edge_to_outside_change_is_reported", async () => {
    const { patch, create } = await owner();
    const sid = (await create({ name: "s", domains: ["www.example.com"], mode: "B" })).body.id as string;
    fakeEdgePing.set("www.example.com", status(404));
    const r = await patch(sid, { domains: ["www.example.com"] });
    expect(r.status).toBe(200);
    expect(r.body.domainChecks.changes).toEqual([{ domain: "www.example.com", from: "edge", to: "outside" }]);
    expect(r.body).toMatchObject({ edgeDomains: [], outsideDomains: ["www.example.com"] });
    expect(await kvHostKey("www.example.com")).toBeNull();
    expect(await hostOwner("www.example.com")).toBeNull();
  });
});
