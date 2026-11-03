import { describe, expect, it } from "vitest";
import { backLabel, SITE_NAV, activeSegment, nextRemembered, originLabel, originOfPath, resolveOrigin, screenName, settingsEntryHref, settingsGroups, settingsPageOf, sidebarContext, switchSettingsHref } from "@/lib/nav";
import type { Role, WorkspaceSummary } from "@/lib/types";

/** ws1 に site s1 / s2 を持つ summary。role だけ変えて使う */
const wsOf = (role: Role): WorkspaceSummary[] => [
  {
    id: "ws1",
    name: "ワークスペース1",
    role,
    memberCount: 3,
    sites: [
      { id: "s1", name: "サイト1", domain: "a.example", runningCount: 0 },
      { id: "s2", name: "サイト2", domain: "b.example", runningCount: 1 },
    ],
  },
];
const scopes = (gs: ReturnType<typeof settingsGroups>) => gs.map((g) => g.scope);

describe("nav", () => {
  it("lists the site menu in the designed order with the glossary labels", () => {
    // B60: サイト設定は設定のメニューへ移し、公開履歴は上部バーの版の札から開くので、サイトのメニューには置かない
    expect(SITE_NAV.map((n) => n.label)).toEqual(["エクスペリエンス", "目標", "オーディエンス"]);
    expect(SITE_NAV.map((n) => n.segment)).toEqual(["", "goals", "audiences"]);
  });

  it("names the screen from the pathname", () => {
    expect(screenName("/w/ws1/sites/s1")).toBe("エクスペリエンス");
    expect(screenName("/w/ws1/sites/s1/experiments/exp_a")).toBe("エクスペリエンス");
    expect(screenName("/w/ws1/sites/s1/goals")).toBe("目標");
    expect(screenName("/w/ws1/sites/s1/audiences/aud_x")).toBe("オーディエンス");
    expect(screenName("/w/ws1/sites/s1/publish")).toBe("公開");
    expect(screenName("/w/ws1/sites/s1/settings")).toBe("サイト設定"); // B60 D7: PageHeader と同じ名前(SITE_NAV のラベルとは別)
    expect(screenName("/w/ws1/sites/s1/history")).toBe("公開履歴"); // B60: メニューから外しても、パンくずの末尾は画面の見出しと同じ名前
    expect(screenName("/w/ws1")).toBeNull();
  });

  it("marks the active menu item (publish has no menu item of its own)", () => {
    expect(activeSegment("/w/ws1/sites/s1/experiments/exp_a")).toBe("");
    expect(activeSegment("/w/ws1/sites/s1/publish")).toBeNull();
    expect(activeSegment("/w/ws1/sites/s1/history")).toBeNull(); // B60: 公開履歴はメニューに無い
    expect(activeSegment("/w/ws1/members")).toBeNull();
  });

  it("decides the sidebar context from the pathname", () => {
    expect(sidebarContext("/w")).toEqual({ kind: "home" });
    expect(sidebarContext("/w/")).toEqual({ kind: "home" });
    expect(sidebarContext("/w/me/api-keys")).toEqual({ kind: "settings", page: { kind: "me", path: "/w/me/api-keys" } });
    expect(sidebarContext("/w/me/workspaces")).toEqual({ kind: "settings", page: { kind: "me", path: "/w/me/workspaces" } });
    expect(sidebarContext("/w/me")).toEqual({ kind: "home" }); // 画面は無い。ホームの形で描く
    expect(sidebarContext("/w/ws1")).toEqual({ kind: "workspace", wid: "ws1" });
    // B60: メンバー・メンバーの API キー・サイト設定は設定のメニューで描く
    expect(sidebarContext("/w/ws1/members")).toEqual({ kind: "settings", page: { kind: "members", wid: "ws1" } });
    expect(sidebarContext("/w/ws1/api-keys")).toEqual({ kind: "settings", page: { kind: "member-api-keys", wid: "ws1" } });
    expect(sidebarContext("/w/ws1/sites/s1/settings")).toEqual({ kind: "settings", page: { kind: "site", wid: "ws1", sid: "s1" } });
    expect(sidebarContext("/w/ws1/sites/s1")).toEqual({ kind: "site", wid: "ws1", sid: "s1" });
    expect(sidebarContext("/w/ws1/sites/s1/experiments/e1")).toEqual({ kind: "site", wid: "ws1", sid: "s1" });
  });

  it("settings_page_of_classifies_paths", () => {
    expect(settingsPageOf("/w/ws1/sites/s1/settings")).toEqual({ kind: "site", wid: "ws1", sid: "s1" });
    expect(settingsPageOf("/w/ws1/members")).toEqual({ kind: "members", wid: "ws1" });
    expect(settingsPageOf("/w/ws1/api-keys")).toEqual({ kind: "member-api-keys", wid: "ws1" });
    expect(settingsPageOf("/w/me/api-keys")).toEqual({ kind: "me", path: "/w/me/api-keys" });
    expect(settingsPageOf("/w/ws1/sites/s1/goals")).toBeNull();
    expect(settingsPageOf("/w/ws1")).toBeNull();
    expect(settingsPageOf("/w")).toBeNull();
  });

  it("origin_of_path_classifies_paths", () => {
    expect(originOfPath("/w")).toEqual({ kind: "home" });
    expect(originOfPath("/w/ws1")).toEqual({ kind: "workspace", wid: "ws1" });
    expect(originOfPath("/w/ws1/members?x=1")).toEqual({ kind: "workspace", wid: "ws1" });
    expect(originOfPath("/w/ws1/sites/s1")).toEqual({ kind: "site", wid: "ws1", sid: "s1" });
    expect(originOfPath("/w/ws1/sites/s1/goals?a=b")).toEqual({ kind: "site", wid: "ws1", sid: "s1" });
    expect(originOfPath("/w/me/api-keys")).toBeNull();
  });

  it("resolve_settings_origin_keeps_remembered_site", () => {
    const remembered = { origin: { kind: "site", wid: "ws1", sid: "s1" }, backHref: "/w/ws1/sites/s1/goals" } as const;
    expect(resolveOrigin({ kind: "members", wid: "ws1" }, remembered)).toBe(remembered);
    expect(resolveOrigin({ kind: "me", path: "/w/me/display" }, remembered)).toBe(remembered);
  });

  it("resolve_settings_origin_falls_back_to_path", () => {
    expect(resolveOrigin({ kind: "members", wid: "ws1" }, null)).toEqual({ origin: { kind: "workspace", wid: "ws1" }, backHref: "/w/ws1" });
    const site = { origin: { kind: "site", wid: "ws1", sid: "s1" }, backHref: "/w/ws1/sites/s1/goals" } as const;
    expect(resolveOrigin({ kind: "members", wid: "ws2" }, site)).toEqual({ origin: { kind: "workspace", wid: "ws2" }, backHref: "/w/ws2" });
    const ws = { origin: { kind: "workspace", wid: "ws1" }, backHref: "/w/ws1" } as const;
    expect(resolveOrigin({ kind: "site", wid: "ws1", sid: "s1" }, ws)).toEqual({ origin: { kind: "site", wid: "ws1", sid: "s1" }, backHref: "/w/ws1/sites/s1" });
    expect(resolveOrigin({ kind: "me", path: "/w/me/api-keys" }, null)).toEqual({ origin: { kind: "home" }, backHref: "/w" });
    // 別のサイトの設定を開いたら、覚えた場所は使わない
    expect(resolveOrigin({ kind: "site", wid: "ws1", sid: "s2" }, site).origin).toEqual({ kind: "site", wid: "ws1", sid: "s2" });
  });

  it("next_remembered_records_previous_screen", () => {
    expect(nextRemembered(null, "/w/ws1/sites/s1/experiments/e1", "/w/ws1/sites/s1/settings")).toEqual({
      origin: { kind: "site", wid: "ws1", sid: "s1" },
      backHref: "/w/ws1/sites/s1/experiments/e1",
    });
    // 戻り先は search を含む
    expect(nextRemembered(null, "/w/ws1?tab=x", "/w/ws1/members")).toEqual({ origin: { kind: "workspace", wid: "ws1" }, backHref: "/w/ws1?tab=x" });
    expect(nextRemembered(null, "/w", "/w/me/display")).toEqual({ origin: { kind: "home" }, backHref: "/w" });
    // 最初の描画(fromPath なし)は toPath から決まる縮んだ形
    expect(nextRemembered(null, null, "/w/ws1/members")).toEqual({ origin: { kind: "workspace", wid: "ws1" }, backHref: "/w/ws1" });
    expect(nextRemembered(null, null, "/w/me/api-keys")).toEqual({ origin: { kind: "home" }, backHref: "/w" });
  });

  it("next_remembered_switches_site_inside_settings", () => {
    const s1 = { origin: { kind: "site", wid: "ws1", sid: "s1" }, backHref: "/w/ws1/sites/s1/goals" } as const;
    expect(nextRemembered(s1, "/w/ws1/sites/s1/settings", "/w/ws1/sites/s2/settings?section=tag")).toEqual({
      origin: { kind: "site", wid: "ws1", sid: "s2" },
      backHref: "/w/ws1/sites/s2",
    });
    const ws = { origin: { kind: "workspace", wid: "ws1" }, backHref: "/w/ws1" } as const;
    expect(nextRemembered(ws, "/w/ws1/members", "/w/ws1/sites/s1/settings")?.origin).toEqual({ kind: "site", wid: "ws1", sid: "s1" });
    expect(nextRemembered(s1, "/w/ws1/sites/s1/settings", "/w/ws1/members")).toBe(s1);
    // 同じサイトの節の切り替え(search だけ変わる)では保つ
    expect(nextRemembered(s1, "/w/ws1/sites/s1/settings", "/w/ws1/sites/s1/settings?section=tag")).toBe(s1);
    // B60 Task 5: 設定の中の切り替えの枠で、メンバーの画面から別のワークスペースのサイトを選ぶ(ユーザーの決定 5)→ そのサイトが起点
    expect(nextRemembered(s1, "/w/ws1/members", "/w/ws2/sites/s9/settings")?.origin).toEqual({ kind: "site", wid: "ws2", sid: "s9" });
  });

  it("switch_settings_href_keeps_page", () => {
    // サイト設定の画面からは同じ節のまま、移り先のサイトのサイト設定へ(一般は ? を付けない)
    const site = { kind: "site", wid: "ws1", sid: "s1" } as const;
    expect(switchSettingsHref(site, "tag", { wid: "ws1", sid: "s2" })).toBe("/w/ws1/sites/s2/settings?section=tag");
    expect(switchSettingsHref(site, "general", { wid: "ws2", sid: "s9" })).toBe("/w/ws2/sites/s9/settings");
    // ほかの設定の画面(メンバー・メンバーの API キー・個人・システム)からは、移り先のサイトのサイト設定の一般へ(ユーザーの決定 5)
    expect(switchSettingsHref({ kind: "members", wid: "ws1" }, "general", { wid: "ws2", sid: "s9" })).toBe("/w/ws2/sites/s9/settings");
    expect(switchSettingsHref({ kind: "member-api-keys", wid: "ws1" }, "general", { wid: "ws1", sid: "s2" })).toBe("/w/ws1/sites/s2/settings");
    // 節の値はサイト設定の画面のときだけ使う(ほかの画面で残っていた値が混ざらない)
    expect(switchSettingsHref({ kind: "me", path: "/w/me/api-keys" }, "tag", { wid: "ws1", sid: "s2" })).toBe("/w/ws1/sites/s2/settings");
  });

  it("next_remembered_without_memory_inside_settings_uses_the_shrunk_form", () => {
    // (c) 設定の中で覚えた値が無いとき(prev = null)は、サイト設定以外も縮んだ形を覚える(描画が使う形と一致させる)
    expect(nextRemembered(null, "/w/me/display", "/w/ws1/members")).toEqual({ origin: { kind: "workspace", wid: "ws1" }, backHref: "/w/ws1" });
    expect(nextRemembered(null, "/w/ws1/members", "/w/me/display")).toEqual({ origin: { kind: "home" }, backHref: "/w" });
    expect(nextRemembered(null, "/w/ws1/members", "/w/ws1/sites/s1/settings")).toEqual({ origin: { kind: "site", wid: "ws1", sid: "s1" }, backHref: "/w/ws1/sites/s1" });
  });

  it("next_remembered_clears_outside_settings", () => {
    const s1 = { origin: { kind: "site", wid: "ws1", sid: "s1" }, backHref: "/w/ws1/sites/s1/goals" } as const;
    expect(nextRemembered(s1, "/w/ws1/members", "/w/ws1/sites/s1/goals")).toBeNull();
  });

  it("settings_groups_order_by_origin", () => {
    const ctx = { workspaces: wsOf("admin"), instanceAdmin: false };
    expect(scopes(settingsGroups({ kind: "site", wid: "ws1", sid: "s1" }, ctx))).toEqual(["site", "workspace", "personal"]);
    expect(scopes(settingsGroups({ kind: "workspace", wid: "ws1" }, ctx))).toEqual(["workspace", "personal"]);
    expect(scopes(settingsGroups({ kind: "home" }, ctx))).toEqual(["personal"]);
    const sys = { workspaces: wsOf("admin"), instanceAdmin: true };
    expect(scopes(settingsGroups({ kind: "site", wid: "ws1", sid: "s1" }, sys))).toEqual(["site", "workspace", "personal", "system"]);
    expect(scopes(settingsGroups({ kind: "home" }, sys))).toEqual(["personal", "system"]);
  });

  it("settings_groups_hide_workspace_below_admin", () => {
    const ctx = { workspaces: wsOf("editor"), instanceAdmin: false };
    expect(scopes(settingsGroups({ kind: "site", wid: "ws1", sid: "s1" }, ctx))).toEqual(["site", "personal"]);
    expect(scopes(settingsGroups({ kind: "workspace", wid: "ws1" }, ctx))).toEqual(["personal"]);
  });

  it("settings_groups_site_items", () => {
    const origin = { kind: "site", wid: "ws1", sid: "s1" } as const;
    const owner = settingsGroups(origin, { workspaces: wsOf("owner"), instanceAdmin: false })[0]!;
    expect(owner.heading).toBe("サイト設定");
    expect(owner.name).toBe("サイト1");
    expect(owner.items.map((i) => i.label)).toEqual(["一般", "ドメイン", "導入タグ", "訪問者 ID", "外部計測の名前", "外部 ID", "危険な操作"]);
    expect(owner.items[0]!.href).toBe("/w/ws1/sites/s1/settings");
    expect(owner.items[0]!.href).not.toContain("?");
    expect(owner.items[1]!.href).toBe("/w/ws1/sites/s1/settings?section=domains");
    expect(owner.items[2]!.href).toBe("/w/ws1/sites/s1/settings?section=tag");
    expect(owner.items.map((i) => i.icon)).toEqual(["gear", "gear", "gear", "gear", "gear", "gear", "dot"]);
    const admin = settingsGroups(origin, { workspaces: wsOf("admin"), instanceAdmin: false })[0]!;
    expect(admin.items).toHaveLength(6);
    expect(admin.items.map((i) => i.label)).not.toContain("危険な操作");
    // summary に無いサイト・ワークスペースは節を出さない
    expect(scopes(settingsGroups({ kind: "site", wid: "ws1", sid: "nope" }, { workspaces: wsOf("admin"), instanceAdmin: false }))).toEqual(["workspace", "personal"]);
    expect(scopes(settingsGroups({ kind: "workspace", wid: "nope" }, { workspaces: wsOf("admin"), instanceAdmin: false }))).toEqual(["personal"]);
  });

  it("settings_groups_workspace_and_personal_items", () => {
    const gs = settingsGroups({ kind: "workspace", wid: "ws1" }, { workspaces: wsOf("admin"), instanceAdmin: true });
    expect(gs.map((g) => [g.heading, g.name])).toEqual([["ワークスペース", "ワークスペース1"], ["個人", null], ["システム", null]]);
    expect(gs[0]!.items.map((i) => i.href)).toEqual(["/w/ws1/members", "/w/ws1/api-keys"]);
    expect(gs[1]!.items.map((i) => i.href)).toEqual(["/w/me/api-keys", "/w/me/display"]);
    expect(gs[2]!.items.map((i) => i.href)).toEqual(["/w/me/instance-admins", "/w/me/workspaces", "/w/me/usage", "/w/me/static-delivery"]);
  });

  it("settings_entry_href_per_origin", () => {
    const admin = { workspaces: wsOf("admin"), instanceAdmin: false };
    const editor = { workspaces: wsOf("editor"), instanceAdmin: false };
    expect(settingsEntryHref({ kind: "site", wid: "ws1", sid: "s1" }, admin)).toBe("/w/ws1/sites/s1/settings");
    expect(settingsEntryHref({ kind: "workspace", wid: "ws1" }, admin)).toBe("/w/ws1/members");
    expect(settingsEntryHref({ kind: "workspace", wid: "ws1" }, editor)).toBe("/w/me/api-keys");
    expect(settingsEntryHref({ kind: "home" }, admin)).toBe("/w/me/api-keys");
  });

  it("origin_label_names_the_place", () => {
    const ws = wsOf("admin");
    expect(originLabel({ kind: "site", wid: "ws1", sid: "s2" }, ws)).toBe("サイト2");
    expect(originLabel({ kind: "workspace", wid: "ws1" }, ws)).toBe("ワークスペース1");
    expect(originLabel({ kind: "home" }, ws)).toBe("ホーム");
  });

  it("settings_groups_keep_usage_prefetch_off", () => {
    const gs = settingsGroups({ kind: "home" }, { workspaces: [], instanceAdmin: true });
    const usage = gs.find((g) => g.scope === "system")!.items.find((i) => i.label === "Cloudflare 使用状況");
    expect(usage?.prefetch).toBe(false);
    // prefetch を止めるのは使用状況と配信ファイルだけ(ほかの設定の画面は先読みしてよい)
    const all = settingsGroups({ kind: "site", wid: "ws1", sid: "s1" }, { workspaces: wsOf("owner"), instanceAdmin: true }).flatMap((g) => g.items);
    expect(all.filter((i) => i.prefetch !== undefined).map((i) => i.href)).toEqual(["/w/me/usage", "/w/me/static-delivery"]);
  });

  // 7o K14: 配信ファイルの画面はシステムの節の最後。先読みでデプロイ専用の Worker を呼ばない(使用状況と同じ)
  it("settings_groups_static_delivery_last_in_system_and_admin_only", () => {
    const sys = settingsGroups({ kind: "home" }, { workspaces: [], instanceAdmin: true }).find((g) => g.scope === "system")!;
    expect(sys.items.at(-1)).toEqual({ key: "/w/me/static-delivery", href: "/w/me/static-delivery", label: "配信ファイル", icon: "upload", prefetch: false });
    const notAdmin = settingsGroups({ kind: "site", wid: "ws1", sid: "s1" }, { workspaces: wsOf("owner"), instanceAdmin: false }).flatMap((g) => g.items);
    expect(notAdmin.map((i) => i.href)).not.toContain("/w/me/static-delivery");
  });

  it("next_remembered_aligns_origin_with_destination_and_keeps_it", () => {
    const ws = wsOf("admin");
    // ホーム → メンバー: 起点はメンバーの画面に合わせ、戻り先はホームのまま
    const m = nextRemembered(null, "/w", "/w/ws1/members")!;
    expect(m).toEqual({ origin: { kind: "workspace", wid: "ws1" }, backHref: "/w" });
    expect(backLabel(m, ws)).toBe("ホーム");
    // さらに個人の画面へ移っても跳ねない
    expect(nextRemembered(m, "/w/ws1/members", "/w/me/display")).toBe(m);
    // サイト s1 の画面 → s2 の設定: s2 が起点、戻り先は s1 の画面
    const s2 = nextRemembered(null, "/w/ws1/sites/s1/goals", "/w/ws1/sites/s2/settings")!;
    expect(s2).toEqual({ origin: { kind: "site", wid: "ws1", sid: "s2" }, backHref: "/w/ws1/sites/s1/goals" });
    expect(backLabel(s2, ws)).toBe("サイト1");
    // メンバーへ移っても s2 のまま(s1 が復活しない)
    expect(nextRemembered(s2, "/w/ws1/sites/s2/settings", "/w/ws1/members")).toBe(s2);
    // 設定の中で合わなくなった記憶は縮んだ形に直す(ホーム → メンバーの記憶のまま別ワークスペースのメンバーへ)
    expect(nextRemembered(m, "/w/ws1/members", "/w/ws2/members")?.origin).toEqual({ kind: "workspace", wid: "ws2" });
  });
});
