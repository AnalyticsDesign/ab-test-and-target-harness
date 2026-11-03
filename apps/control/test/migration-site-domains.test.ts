import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { compile } from "@wtt/core";
import { edgeOrigin } from "../src/capabilities";
import { getDb } from "../src/db";
import { deriveDomainColumns, type DomainRow } from "../src/domains";
import type { Env } from "../src/env";
import { migrateSharing } from "../src/sharing-conflict";
import { genOf, requestStaticDeploy } from "../src/static-delivery";
import { inspectStaticHealth } from "../src/static-health";
import { fakeDeployer, siteRow, staticInputOf, testEnv, type FakeStaticInput } from "./helpers";

/** B148(P7・P9・P11・r2 の CX-High-9): site_domains のマイグレーションが、今の 3 列から domains_json を作り、3 列を一覧から導いた値に書き直す */

type Seed = {
  id: string;
  domain: string;
  mode?: "A" | "B";
  hosts?: string[];
  origins?: string[];
  share?: 0 | 1;
  pending?: 0 | 1;
  cookie?: string;
};
type Row = { id: string; domain: string; mode: "A" | "B"; allowed_origins_json: string; hosts_json: string; domains_json: string; share_subdomains: number; share_migration_pending: number };

const T = 1_700_000_000_000;
const row = (value: string, verdict: DomainRow["verdict"]): DomainRow => ({ value, verdict, checkedAt: null, triedAt: null });

/** このマイグレーションより前までを当て、古い形の行を入れてから残りを当てる */
async function migrateWith(seeds: Seed[], beforeRest?: () => Promise<void>): Promise<Record<string, Row>> {
  const mine = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_site_domains.sql"))!.name;
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < mine));
  await env.DB.batch([
    env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values ('w1', 'W', 'ws-1', '2026-09-01T00:00:00.000Z')`),
    ...seeds.flatMap((s) => [
      env.DB.prepare(
        `insert into sites (id, workspace_id, name, domain, mode, site_salt, allowed_origins_json, hosts_json, visitor_cookie_name, share_subdomains, share_migration_pending, content_updated_at, created_at, updated_at)
         values (?1, 'w1', ?1, ?2, ?3, 'salt', ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9)`,
      ).bind(s.id, s.domain, s.mode ?? "A", JSON.stringify(s.origins ?? []), JSON.stringify(s.hosts ?? []), s.cookie ?? "_ab_vid", s.share ?? 1, s.pending ?? 0, T),
      ...(s.hosts ?? []).map((h) => env.DB.prepare("insert into site_hosts (host, site_id) values (?, ?)").bind(h, s.id)),
    ]),
  ]);
  await beforeRest?.();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const rows = (await env.DB.prepare("select id, domain, mode, allowed_origins_json, hosts_json, domains_json, share_subdomains, share_migration_pending from sites").all<Row>()).results;
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

/** 旧い 3 列 = domains_json から導いた値(deriveDomainColumns と同じ規則) */
function expectDerived(r: Row): void {
  const d = deriveDomainColumns(JSON.parse(r.domains_json) as DomainRow[], r.mode);
  expect({ domain: r.domain, allowedOrigins: JSON.parse(r.allowed_origins_json), hosts: JSON.parse(r.hosts_json) }).toEqual(d);
}

describe("migration site_domains (B148)", () => {
  it("site_domains_migration_builds_domains_from_domain_hosts_and_origins", async () => {
    const rows = await migrateWith([
      {
        id: "s_b",
        domain: "www.example.com",
        mode: "B",
        hosts: ["www.example.com", "shop.example.com"],
        origins: ["https://www.example.com", "https://form.example.com", "http://localhost:8080"],
      },
    ]);
    const r = rows.s_b!;
    // domain は hosts にあるので先頭(www・shop・form・localhost の順)
    expect(JSON.parse(r.domains_json)).toEqual([
      row("www.example.com", "edge"),
      row("shop.example.com", "edge"),
      row("form.example.com", "unknown"),
      row("http://localhost:8080", "dev"),
    ]);
    expectDerived(r);
    // Mode B の hosts_json は変わらない。allowed_origins_json は hosts を含む形に広がる
    expect(JSON.parse(r.hosts_json)).toEqual(["www.example.com", "shop.example.com"]);
    expect(JSON.parse(r.allowed_origins_json)).toEqual(["https://www.example.com", "https://shop.example.com", "https://form.example.com", "http://localhost:8080"]);
    // Mode B の site_hosts は残る
    const owned = (await env.DB.prepare("select host from site_hosts where site_id = 's_b' order by host").all<{ host: string }>()).results.map((x) => x.host);
    expect(owned).toEqual(["shop.example.com", "www.example.com"]);
  });

  it("site_domains_migration_keeps_host_set_but_order_may_change", async () => {
    // domain が hosts の先頭でないサイト: 移行で domain を先頭に並べ替えるので hosts_json の順は変わる(集合は同じ)。
    // 配信ファイルの入力の digest は順を含むので変わるが、配信の確かめが digest を比べるのは static_stale = 1 の行だけで、移行は印を立てない
    const before = { hosts: ["shop.example.com", "www.example.com"] };
    const rows = await migrateWith([{ id: "s_b", domain: "www.example.com", mode: "B", hosts: before.hosts, origins: ["https://shop.example.com"] }]);
    const after = JSON.parse(rows.s_b!.hosts_json) as string[];
    expect(new Set(after)).toEqual(new Set(before.hosts));
    expect(after).toEqual(["www.example.com", "shop.example.com"]);
    const stale = await env.DB.prepare("select static_stale from sites where id = 's_b'").first<{ static_stale: number }>();
    expect(stale?.static_stale).toBe(0);
    expectDerived(rows.s_b!);
  });

  it("site_domains_migration_stale_published_site_needs_explicit_redeploy", async () => {
    // r2 CX-Medium-1: 移行の前から配信待ち(static_stale = 1)の公開中のサイト。デプロイ専用の Worker は移行の前の入力を、
    // D1 と同じ世代で受け付けている。その配置が済んでも、移行の後の D1 から作る入力の digest とは合わない
    // (s_order = Mode B の hosts の順が変わる / s_share = 共有オンで、別の登録ドメインの cookieDomains の順が変わる)。
    // 移行の前の入力は、今の control では移行の前の行から作れない(domains_json が無い)ので、移行の後の入力の順を前の順に戻して作る
    const sites = ["s_order", "s_share"];
    await migrateWith(
      [
        { id: "s_order", domain: "www.example.com", mode: "B", hosts: ["shop.example.com", "www.example.com"], origins: ["https://shop.example.com"], share: 0 },
        { id: "s_share", domain: "www.example.com", mode: "A", origins: ["https://www.other-site.net", "https://www.example.com"], share: 1 },
      ],
      async () => {
        for (const id of sites) {
          const config = compile({ siteId: id, siteSalt: "salt", version: 1, goals: [], experiments: [] });
          await env.DB.batch([
            env.DB.prepare(`insert into publishes (id, site_id, version, status, config_json, published_by, created_at, activated_at) values (?1, ?2, 1, 'active', ?3, 'u1', ?4, ?4)`).bind(
              `pub_${id}`,
              id,
              JSON.stringify(config),
              T,
            ),
            env.DB.prepare("update sites set active_version = 1, last_activated_at = ?2, static_seq = 1, static_stale = 1 where id = ?1").bind(id, T),
          ]);
        }
      },
    );
    const db = getDb(env as unknown as Env);
    const fake = fakeDeployer();
    const e = { ...testEnv, DEPLOYER: fake } as Env;
    const apiBase = edgeOrigin(testEnv);
    const after = { s_order: await staticInputOf("s_order"), s_share: await staticInputOf("s_share") };
    const settingsOf = (i: FakeStaticInput) => i.settings as { hosts: string[]; cookieDomains: string[] };
    expect(settingsOf(after.s_order).hosts).toEqual(["www.example.com", "shop.example.com"]);
    expect(settingsOf(after.s_share).cookieDomains).toHaveLength(2);
    const before: Record<string, FakeStaticInput> = {
      s_order: { ...after.s_order, settings: { ...settingsOf(after.s_order), hosts: ["shop.example.com", "www.example.com"] } },
      s_share: { ...after.s_share, settings: { ...settingsOf(after.s_share), cookieDomains: [...settingsOf(after.s_share).cookieDomains].reverse() } },
    };
    // 移行の前に受け付けた配置が、同じ世代で済んだ
    for (const id of sites) {
      const g = genOf(await siteRow(id));
      fake.setSite(id, { accepted: g, deployed: g, input: before[id] });
    }
    const first = await inspectStaticHealth(db, await fake.instanceStatus(), Date.now(), apiBase);
    expect(first.health.pendingSites).toEqual([]);
    expect(first.health.mismatchSites).toEqual(sites);
    expect(first.health.needsAttention).toBe(true);
    // 自動の依頼し直しも印の解除もしない(待っても直らない)
    expect(first.rerequest).toEqual([]);
    expect(first.toClear).toEqual([]);

    // 明示の作り直し(POST /sites/:sid/static/redeploy が呼ぶものと同じ)で、新しい世代を今の入力で配る
    for (const id of sites) expect((await requestStaticDeploy(e, db, id, { force: true, recover: true })).state).toBe("deployed");
    const second = await inspectStaticHealth(db, await fake.instanceStatus(), Date.now(), apiBase);
    expect(second.health.mismatchSites).toEqual([]);
    expect(second.health.pendingSites).toEqual([]);
    for (const id of sites) expect((await siteRow(id)).static_stale).toBe(0);
  });

  it("site_domains_migration_moves_domain_to_front_and_dedupes", async () => {
    const rows = await migrateWith([
      // domain が hosts の 2 つ目、origins に同じホストと https のポート付き(開発用)
      { id: "s_order", domain: "www.example.com", mode: "B", hosts: ["shop.example.com", "www.example.com"], origins: ["https://shop.example.com", "https://www.example.com:8443"] },
    ]);
    const r = rows.s_order!;
    expect(JSON.parse(r.domains_json)).toEqual([row("www.example.com", "edge"), row("shop.example.com", "edge"), row("https://www.example.com:8443", "dev")]);
    expectDerived(r);
  });

  it("site_domains_migration_skips_unused_domain", async () => {
    const rows = await migrateWith([{ id: "s_u", domain: "www.example.com", origins: ["https://other.net"] }]);
    const rowU = rows.s_u!;
    // domains は other.net の 1 行だけ、代表は other.net(P7)
    expect(JSON.parse(rowU.domains_json)).toEqual([row("other.net", "unknown")]);
    expect(rowU.domain).toBe("other.net");
    expectDerived(rowU);
  });

  it("site_domains_migration_dev_first_row_becomes_representative_host", async () => {
    const rows = await migrateWith([{ id: "s_dev", domain: "www.example.com", origins: ["http://localhost:8080", "https://form.example.com"] }]);
    const r = rows.s_dev!;
    expect(JSON.parse(r.domains_json)).toEqual([row("http://localhost:8080", "dev"), row("form.example.com", "unknown")]);
    expect(r.domain).toBe("localhost");
    expectDerived(r);
  });

  it("site_domains_migration_mode_a_hosts_are_released", async () => {
    // Mode A のサイトに hosts が残っている(今の API は Mode A でも hosts の PATCH を通す)
    const rows = await migrateWith([{ id: "s_a", domain: "www.example.com", mode: "A", hosts: ["www.example.com", "shop.example.com"], origins: ["https://www.example.com"] }]);
    const r = rows.s_a!;
    // 一覧には入る(判定は unknown)、hosts_json は空、site_hosts の行は消える
    expect(JSON.parse(r.domains_json)).toEqual([row("www.example.com", "unknown"), row("shop.example.com", "unknown")]);
    expect(JSON.parse(r.hosts_json)).toEqual([]);
    expectDerived(r);
    expect((await env.DB.prepare("select count(*) as n from site_hosts where site_id = 's_a'").first<{ n: number }>())!.n).toBe(0);
    // 別のサイトがそのホストを取れる
    await env.DB.prepare(
      `insert into sites (id, workspace_id, name, domain, mode, site_salt, content_updated_at, created_at, updated_at) values ('s_other', 'w1', 'O', 'shop.example.com', 'B', 'salt', 1, 1, 1)`,
    ).run();
    await env.DB.prepare("insert into site_hosts (host, site_id) values ('shop.example.com', 's_other')").run();
  });

  it("site_domains_migration_mode_a_site_has_no_edge_rows", async () => {
    const rows = await migrateWith([{ id: "s_a", domain: "www.example.com", mode: "A", hosts: ["www.example.com"], origins: ["https://www.example.com", "https://form.example.com"] }]);
    const rowA = rows.s_a!;
    // Mode A(hosts = [])の行は edge にならない
    expect(JSON.parse(rowA.domains_json).every((d: { verdict: string }) => d.verdict !== "edge")).toBe(true);
    expectDerived(rowA);
  });

  it("site_domains_migration_keeps_all_rows_over_50", async () => {
    const origins = Array.from({ length: 60 }, (_, i) => `https://h${i}.example.com`);
    const rows = await migrateWith([{ id: "s_60", domain: "h0.example.com", origins }]);
    const row60 = rows.s_60!;
    // 60 行 → 60 行を残す(P9。50 行以下を求めるのはドメインの節の保存のときだけ)
    expect(JSON.parse(row60.domains_json)).toHaveLength(60);
    expectDerived(row60);
  });

  it("site_domains_migration_empty_sites_get_domain_row", async () => {
    const rows = await migrateWith([
      { id: "s_on", domain: "www.example.com", share: 1, pending: 0 },
      { id: "s_user_off", domain: "www.off-site.com", share: 0, pending: 0 },
      { id: "s_pending", domain: "www.pending-site.com", share: 0, pending: 1 },
      { id: "s_has", domain: "www.has-site.com", share: 1, pending: 0, origins: ["https://www.has-site.com"] },
    ]);
    for (const id of ["s_on", "s_user_off", "s_pending"]) {
      expect(JSON.parse(rows[id]!.domains_json)).toEqual([row(rows[id]!.domain, "unknown")]);
      expectDerived(rows[id]!);
    }
    // 両方とも空・共有オンのサイトだけ、共有をオフにして移行の印を立てる(P11)
    expect(rows.s_on).toMatchObject({ share_subdomains: 0, share_migration_pending: 1 });
    // 利用者がオフにしたサイト(オフ・印 0)はそのまま
    expect(rows.s_user_off).toMatchObject({ share_subdomains: 0, share_migration_pending: 0 });
    expect(rows.s_pending).toMatchObject({ share_subdomains: 0, share_migration_pending: 1 });
    // 一覧が空でないサイトの共有は変えない
    expect(rows.s_has).toMatchObject({ share_subdomains: 1, share_migration_pending: 0 });
  });

  it("site_domains_migration_hands_empty_sites_to_sharing_migration", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = await migrateWith(
      [
        // 衝突する組: 両方とも空・共有オンの s_empty と、同じ Cookie 名で example.com を共有する s_shared
        { id: "s_empty", domain: "www.example.com", share: 1 },
        { id: "s_shared", domain: "form.example.com", origins: ["https://form.example.com"], share: 1 },
        // 衝突の無い組
        { id: "s_free", domain: "www.free-site.com", share: 1 },
        // 利用者がオフにしたサイト
        { id: "s_user_off", domain: "www.off-site.com", share: 0, pending: 0 },
      ],
      async () => {
        // s_shared は既に共有している(予約がある)
        await env.DB.batch([
          env.DB.prepare("insert into sharing_claims (domain, cookie_name, site_id, until) values ('example.com', '_ab_vid', 's_shared', null)"),
          env.DB.prepare("insert into sharing_claims (domain, cookie_name, site_id, until) values ('example.com', '_ab_vid_js', 's_shared', null)"),
        ]);
      },
    );
    // 移行の直後は共有オフ・印 1
    expect(rows.s_empty).toMatchObject({ share_subdomains: 0, share_migration_pending: 1 });
    expect(rows.s_free).toMatchObject({ share_subdomains: 0, share_migration_pending: 1 });
    expect(rows.s_user_off).toMatchObject({ share_subdomains: 0, share_migration_pending: 0 });
    // KV に導入の印があっても、移行待ちのサイトがあれば処理する
    await env.CONFIG_KV.put("meta:install", "existing-marker");
    const result = await migrateSharing(testEnv, env.DB, nowSec);
    expect(result).toEqual({ done: true, turnedOn: ["s_free"] });
    const after = Object.fromEntries(
      (await env.DB.prepare("select id, share_subdomains, share_migration_pending from sites").all<{ id: string; share_subdomains: number; share_migration_pending: number }>()).results.map((r) => [r.id, r]),
    );
    // 衝突する s_empty は Cron の後もオフのまま
    expect(after.s_empty).toMatchObject({ share_subdomains: 0, share_migration_pending: 0 });
    // 衝突の無い組はオンになり、予約が入る
    expect(after.s_free).toMatchObject({ share_subdomains: 1, share_migration_pending: 0 });
    const claims = (await env.DB.prepare("select domain from sharing_claims where site_id = 's_free'").all<{ domain: string }>()).results;
    expect(claims.map((c) => c.domain)).toEqual(["free-site.com", "free-site.com"]);
    // 利用者がオフにしたサイトは印 0 のまま・オフのまま
    expect(after.s_user_off).toMatchObject({ share_subdomains: 0, share_migration_pending: 0 });
    // 導入の印は書き換えない
    expect(await env.CONFIG_KV.get("meta:install")).toBe("existing-marker");
  });
});
