import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_ANALYTICS } from "@wtt/core";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import { DomainsSection } from "@/components/settings/DomainsSection";
import { SiteSettingsForm } from "@/components/settings/SiteSettingsForm";
import { sectionOfField } from "@/components/settings/sections";
import {
  checkOf,
  compactRows,
  domainsChanged,
  edgeLost,
  previewNormalized,
  shouldSendDomains,
  verdictLabel,
} from "@/components/settings/domains-view";
import { ApiClientError, fieldErrors } from "@/lib/client";
import type { DomainRow, Site } from "@/lib/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/w1/sites/s1/settings",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ wid: "w1", sid: "s1" }),
}));

const row = (value: string, verdict: DomainRow["verdict"], checkedAt: number | null = 1, triedAt: number | null = 1): DomainRow => ({ value, verdict, checkedAt, triedAt });

test("preview_matches_server_normalizing", () => {
  expect(previewNormalized("HTTPS://WWW.Example.com/")).toBe("www.example.com");
  expect(previewNormalized("www.example.com")).toBeNull(); // 変わらないときは出さない
});

test("verdict_labels", () => {
  expect(verdictLabel({ value: "a", verdict: "edge", checkedAt: 1, triedAt: 1 }, "B", "probed").label).toBe("Cloudflare 経由(edge が応答しました)");
  expect(verdictLabel({ value: "a", verdict: "outside", checkedAt: 1, triedAt: 1 }, "B", "probed").note).toContain("Route を足したら、もう一度保存");
  expect(verdictLabel({ value: "a", verdict: "unknown", checkedAt: null, triedAt: 1 }, "B", "unknown").label).toBe("確かめられませんでした");
  expect(verdictLabel({ value: "a", verdict: "edge", checkedAt: 1, triedAt: 2 }, "B", "unknown").label).toBe("確かめられませんでした(前回: Cloudflare 経由)");
  expect(verdictLabel({ value: "a", verdict: "edge", checkedAt: 1, triedAt: 1 }, "B", "deferred").note).toBe("次の保存で確かめます");
  expect(verdictLabel({ value: "a", verdict: "edge", checkedAt: 1, triedAt: 1 }, "A", null).label).toBe(""); // Mode A は札を出さない
});

test("other_section_save_omits_domains", () => {
  expect(shouldSendDomains("general", false, false)).toBe(false);
  expect(shouldSendDomains("domains", false, false)).toBe(true); // 変更が無くても保存で確かめ直す
  expect(shouldSendDomains("naming", true, false)).toBe(true); // 一覧を変えたまま別の節で保存しても落とさない
  expect(shouldSendDomains("general", false, true)).toBe(true);
});

describe("domains view helpers (B148)", () => {
  test("preview_copies_every_server_rule", () => {
    expect(previewNormalized("http://Localhost:8080/")).toBe("http://localhost:8080"); // 開発用は Origin の形
    expect(previewNormalized("www.example.com:8443")).toBe("https://www.example.com:8443"); // scheme の無い port 付きは https
    expect(previewNormalized("www.example.com.")).toBe("www.example.com"); // 末尾の .
    expect(previewNormalized("  www.example.com  ")).toBeNull(); // 前後の空白だけの違いは知らせない
    // 保存で断られる行には出さない(エラーはサーバーの文で行の下に出る)
    expect(previewNormalized("www.example.com/form")).toBeNull();
    expect(previewNormalized("*.example.com")).toBeNull();
    expect(previewNormalized("ftp://example.com")).toBeNull();
    expect(previewNormalized("a..b")).toBeNull();
    expect(previewNormalized("example.com:70000")).toBeNull();
    expect(previewNormalized("日本.jp")).toBeNull();
    expect(previewNormalized("")).toBeNull();
  });

  test("preview_drops_default_ports_like_the_server", () => {
    // 既定のポートは落とす(control の normalizeDomainInput と同じ。core の Origin の検査に合う形)
    expect(previewNormalized("http://localhost:80")).toBe("http://localhost");
    expect(previewNormalized("https://www.example.com:443")).toBe("www.example.com"); // 既定のポートを落とすと通常の行
    expect(previewNormalized("www.example.com:443")).toBe("www.example.com");
    expect(previewNormalized("http://localhost:443")).toBe(null); // 既定でないポートは残る(入力のまま)
    expect(previewNormalized("https://localhost:80")).toBe(null);
    // URL が別の形に書き直すホストは保存で断られるので出さない
    expect(previewNormalized("http://0x7f.1:8080")).toBeNull();
    expect(previewNormalized("1.2.3")).toBeNull();
  });

  test("verdict_labels_without_a_save_in_this_screen", () => {
    // この画面で保存する前(check = null)は、保存済みの行から決める
    expect(verdictLabel(row("a", "outside"), "B", null)).toMatchObject({ label: "Cloudflare 外(edge が応答しません)", tone: "gray" });
    expect(verdictLabel(row("a", "edge"), "B", null)).toMatchObject({ label: "Cloudflare 経由(edge が応答しました)", tone: "ok", note: null });
    expect(verdictLabel(row("a", "unknown", null, null), "B", null).label).toBe("保存すると確かめます"); // 移行した行・まだ確かめていない行
    expect(verdictLabel(row("a", "unknown", null, 5), "B", null).label).toBe("確かめられませんでした");
    // 前回の判定を保った行(最後に確かめに行った時刻が判定の時刻より新しい)は、再読み込みの後も前回の値を添える
    expect(verdictLabel(row("a", "outside", 1, 9), "B", null).label).toBe("確かめられませんでした(前回: Cloudflare 外)");
    expect(verdictLabel(row("a", "edge", null, 9), "B", null).label).toBe("確かめられませんでした(前回: Cloudflare 経由)");
    expect(verdictLabel(row("http://localhost:8080", "dev", null, null), "B", null).label).toBe("開発用(確かめません)");
    expect(verdictLabel(row("a", "unknown", null, 1), "B", "unknown")).toMatchObject({ tone: "warn" });
    expect(verdictLabel(row("a", "unknown", null, 1), "B", "unknown").note).toContain("もう一度保存すると確かめ直します");
    // 札の注記は警告の色を使わない(灰色の小さな文字。色は札だけ)。deferred の行は前回の札のまま
    expect(verdictLabel(row("a", "outside"), "B", "deferred")).toMatchObject({ label: "Cloudflare 外(edge が応答しません)", note: "次の保存で確かめます" });
    expect(verdictLabel(row("a", "outside"), "A", "probed")).toEqual({ label: "", note: null, tone: "gray" });
  });

  test("check_of_a_row_from_the_last_save", () => {
    const checks = { changes: [], deferred: ["b.example.com"], unknown: ["c.example.com"] };
    expect(checkOf("a.example.com", checks)).toBe("probed");
    expect(checkOf("b.example.com", checks)).toBe("deferred");
    expect(checkOf("c.example.com", checks)).toBe("unknown");
    expect(checkOf("a.example.com", null)).toBeNull();
  });

  test("domains_changed_compares_normalized_rows", () => {
    const saved = [row("www.example.com", "edge"), row("http://localhost:8080", "dev")];
    expect(domainsChanged(["WWW.example.com", "http://localhost:8080/", ""], saved)).toBe(false);
    expect(domainsChanged(["http://localhost:8080", "www.example.com"], saved)).toBe(true); // 並び(代表)が変わった
    expect(domainsChanged(["www.example.com"], saved)).toBe(true);
    expect(domainsChanged(["www.example.com", "http://localhost:8080", "bad/path"], saved)).toBe(true);
  });

  test("compact_rows_drops_blank_rows", () => {
    expect(compactRows([" a.example.com ", "", "  ", "b.example.com"])).toEqual(["a.example.com", "b.example.com"]);
  });

  test("edge_lost_lists_only_rows_that_left_edge", () => {
    expect(
      edgeLost({
        changes: [
          { domain: "a.example.com", from: "edge", to: "outside" },
          { domain: "b.example.com", from: "unknown", to: "edge" },
        ],
        deferred: [],
        unknown: [],
      }),
    ).toEqual([{ domain: "a.example.com", from: "edge", to: "outside" }]);
    expect(edgeLost(null)).toEqual([]);
  });

  test("domain_and_mode_fields_belong_to_the_domains_section", () => {
    expect(sectionOfField("domains")).toBe("domains");
    expect(sectionOfField("domains.3")).toBe("domains");
    expect(sectionOfField("mode")).toBe("domains");
    // 旧い欄の 422(legacy_domain_fields)が来ても、ドメインの節を開く
    expect(sectionOfField("allowedOrigins")).toBe("domains");
    expect(sectionOfField("hosts")).toBe("domains");
    expect(sectionOfField("domain")).toBe("domains");
  });
});

const modeB: Site = {
  id: "s1", workspaceId: "w1", name: "S", mode: "B", idSource: "ab",
  domains: [row("www.example.com", "edge"), row("form.example.com", "outside"), row("shop.example.com", "unknown", null, null)],
  domain: "www.example.com", allowedOrigins: ["https://www.example.com", "https://form.example.com", "https://shop.example.com"],
  edgeDomains: ["www.example.com"], outsideDomains: ["form.example.com"], uncheckedDomains: ["shop.example.com"],
  retentionDays: 90, consentMode: "implicit", forgetOnRevoke: true, resultsEnabled: false, resultsRetentionDays: 90, newProfileBudgetPerDay: null,
  timezone: "Asia/Tokyo", decisionTimeoutMs: 1000, visitorCookieName: "_wtt_vid", uuidCookieEnabled: false, uuidCookieName: "_wtt_uuid",
  previousCookieNames: [], shareSubdomains: true, cookieGroups: [{ domain: "example.com", hosts: ["www.example.com", "form.example.com", "shop.example.com"] }],
  analytics: DEFAULT_ANALYTICS, ga4PropertyId: null, bigqueryDataset: null,
  activeVersion: null, activeKvStale: false, staticStale: false, staticRemoving: false, lastActivatedAt: null, contentUpdatedAt: 1, createdAt: 1, updatedAt: 1,
};

type SectionProps = Parameters<typeof DomainsSection>[0];
function renderSection(over: Partial<SectionProps> = {}): string {
  const props: SectionProps = {
    site: modeB,
    mode: "B",
    rows: modeB.domains.map((r) => r.value),
    fields: {},
    disabled: false,
    canAdmin: true,
    domainChecks: null,
    className: "card",
    hidden: false,
    onModeChange: () => {},
    onRowsChange: () => {},
    onListEdited: () => {},
    ...over,
  };
  return renderToStaticMarkup(createElement(DomainsSection, props));
}

describe("domains section (B148)", () => {
  test("renders_rows_with_badges_and_derived_values_in_mode_b", () => {
    const html = renderSection();
    expect(html).toContain("Cloudflare 経由(edge が応答しました)");
    expect(html).toContain("Cloudflare 外(edge が応答しません)");
    expect(html).toContain("Route を足したら、もう一度保存");
    expect(html).toContain("保存すると確かめます");
    expect(html).toContain("代表");
    expect(html).toContain("この一覧から決まる値");
    expect(html).toContain('id="route-steps"');
    // Route の手順のワイルドカードの補足(spec の文のまま)
    expect(html).toContain("apex の <code>example.com</code> は含まないので、apex にも置くなら <code>example.com/__ab/*</code> を別に足す");
    expect(html).toContain("この画面の一覧には、ワイルドカードではなくドメインを 1 つずつ書く");
    expect(html).toContain("Safari では、Cloudflare 外のドメインだけに来る訪問者の ID は Mode A と同じ扱い");
  });

  test("mode_a_hides_badges_route_steps_and_outside_explanation", () => {
    const html = renderSection({ mode: "A", site: { ...modeB, mode: "A", edgeDomains: [], outsideDomains: [], uncheckedDomains: [] } });
    expect(html).not.toContain("Cloudflare 経由(edge");
    expect(html).not.toContain("保存すると確かめます");
    expect(html).not.toContain('id="route-steps"');
    expect(html).not.toContain("Cloudflare 外のドメインは、");
  });

  test("shows_preview_of_the_saved_form_while_typing", () => {
    const html = renderSection({ rows: ["HTTPS://Edge.Example.com/"] });
    expect(html).toContain("保存すると <code>edge.example.com</code> になります");
  });

  test("row_errors_from_control_show_under_the_row_and_open_the_domains_section", () => {
    // control の 422 invalid_domains → fieldErrors のキー domains.<n> → その行の下・ドメインの節
    const err = new ApiClientError(422, "invalid_domains", {
      message: "パスは書けません",
      issues: [{ path: ["domains", 1], message: "パスは書けません。ドメインだけを書きます" }],
    });
    const fields = fieldErrors(err);
    expect(fields).toEqual({ "domains.1": "パスは書けません。ドメインだけを書きます" });
    expect(sectionOfField(Object.keys(fields)[0]!)).toBe("domains");
    const html = renderSection({ rows: ["www.example.com", "www.example.com/form"], fields });
    const second = html.indexOf('name="domains.1"');
    expect(second).toBeGreaterThan(0);
    expect(html.indexOf("パスは書けません。ドメインだけを書きます")).toBeGreaterThan(second);
  });

  test("deferred_rows_keep_the_next_save_note_from_the_last_save", () => {
    const html = renderSection({ domainChecks: { changes: [], deferred: ["form.example.com"], unknown: [] } });
    expect(html).toContain("次の保存で確かめます");
  });

  test("warns_about_rows_that_left_edge_and_when_no_edge_domain_is_left", () => {
    const html = renderSection({
      site: { ...modeB, edgeDomains: [], domains: [row("www.example.com", "outside")] },
      rows: ["www.example.com"],
      domainChecks: { changes: [{ domain: "www.example.com", from: "edge", to: "outside" }], deferred: [], unknown: [] },
    });
    expect(html).toContain("Cloudflare 経由ではなくなりました");
    expect(html).toContain(
      "Cloudflare 経由のドメインが無いので、どのドメインも Mode A と同じ動きになります(Safari では ID が弱くなります)。Route を足してから保存すると Cloudflare 経由になります",
    );
  });
});

describe("site settings form with the domains section (B148)", () => {
  const render = (initialSection: "identity" | "general" | "domains") =>
    renderToStaticMarkup(
      createElement(
        ConfirmProvider,
        null,
        createElement(SiteSettingsForm, {
          site: modeB, canAdmin: true, canDelete: true, tagOrigin: null, initialSection,
          resultsStore: false, edgeOrigin: null, runningTests: 0, runningRecordedTests: 0,
        }),
      ),
    );

  test("general_and_identity_no_longer_hold_the_domain_fields", () => {
    const html = render("general");
    expect(html).not.toContain('name="domain"');
    expect(html).not.toContain('name="allowedOrigins"');
    expect(html).not.toContain('name="hosts"');
    // 導入の形はドメインの節に 1 つだけ
    expect(html.match(/name="mode"/g)?.length).toBe(1);
    expect(html).toContain("導入の形(Mode)と Mode B の設置手順は");
  });

  test("save_bar_says_that_saving_checks_again_on_the_domains_section", () => {
    expect(render("domains")).toContain("保存すると、ドメインごとに edge が応答するかを確かめ直します");
    expect(render("general")).not.toContain("保存すると、ドメインごとに edge が応答するかを確かめ直します");
  });
});
