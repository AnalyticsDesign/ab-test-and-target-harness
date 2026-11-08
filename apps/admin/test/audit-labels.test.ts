import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_VIAS } from "@wtt/core";
import { AUDIT_ACTION_JA, AUDIT_VIA_JA, auditActionLabel, auditActorLabel, auditDetailLine, auditTargetLabel, auditViaLabel, type AuditEventView } from "@/lib/audit-labels";

/**
 * B129(spec §7.1・§7.3): 操作の記録の 1 行の日本語(操作・ログイン方法・内容)。
 * 変更履歴のタブ(エクスペリエンス)と設定の「操作の記録」(ワークスペース・導入全体)が同じ部品を使う
 */
const ev = (action: string, detail: Record<string, unknown> = {}, over: Partial<AuditEventView> = {}): AuditEventView => ({
  id: "1",
  at: 0,
  category: "content",
  action,
  workspaceId: "w",
  siteId: "s",
  experimentId: "e",
  via: "google",
  actor: { userId: "u", name: "田中 花子", email: null },
  apiKey: null,
  target: null,
  detail,
  ...over,
});

describe("audit labels", () => {
  it("every_action_has_label(すべての action と via に日本語がある)", () => {
    for (const a of AUDIT_ACTIONS) {
      expect(AUDIT_ACTION_JA[a], a).toMatch(/\S/);
      expect(auditActionLabel(ev(a)), a).not.toMatch(/^操作\(/);
    }
    for (const v of AUDIT_VIAS) expect(AUDIT_VIA_JA[v], v).toMatch(/\S/);
    // 表の鍵が一覧と同じ(古い action の消し忘れ・足し忘れが無い)
    expect(Object.keys(AUDIT_ACTION_JA).sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(Object.keys(AUDIT_VIA_JA).sort()).toEqual([...AUDIT_VIAS].sort());
  });

  it("unknown_action_falls_back(新しい control と古い管理画面の組み合わせ)", () => {
    expect(auditActionLabel(ev("future.thing"))).toBe("操作(future.thing)");
    expect(auditDetailLine(ev("future.thing", { a: 1 }))).toBe("");
    expect(auditViaLabel(ev("site.create", {}, { via: "carrier_pigeon" }))).toEqual({ text: "不明", warn: false });
  });

  it("revert_labels_are_distinct(戻し・取り消し・失敗は通常の操作と同じ表示にしない)", () => {
    expect(auditActionLabel(ev("publish.publish", { version: 3, reason: "reverted" }))).toBe("公開を戻した");
    expect(auditActionLabel(ev("publish.publish", { version: 3, superseded: false }))).toBe(AUDIT_ACTION_JA["publish.publish"]);
    expect(auditActionLabel(ev("site.update", { reason: "reverted" }))).toBe("保存を戻した");
    expect(auditActionLabel(ev("site.update", { fields: ["name"] }))).toBe(AUDIT_ACTION_JA["site.update"]);
    expect(auditActionLabel(ev("site.delete", { reason: "create_failed" }))).toBe("作成の取り消し");
    expect(auditActionLabel(ev("site.delete", { domain: "example.com" }))).toBe(AUDIT_ACTION_JA["site.delete"]);
    const distinct = new Set([
      auditActionLabel(ev("publish.publish", { reason: "reverted" })),
      auditActionLabel(ev("publish.publish", {})),
      auditActionLabel(ev("site.update", { reason: "reverted" })),
      auditActionLabel(ev("site.update", {})),
      auditActionLabel(ev("site.delete", { reason: "create_failed" })),
      auditActionLabel(ev("site.delete", {})),
    ]);
    expect(distinct.size).toBe(6);
    // outcome = failed(操作の前に書いた記録の後に、操作が失敗した)
    expect(auditActionLabel(ev("api_key.create", { outcome: "failed" }))).toBe("API キーの発行を試みたが失敗");
    expect(auditActionLabel(ev("member.reset_link", { outcome: "failed" }))).toBe("パスワードの再設定リンクの発行を試みたが失敗");
    expect(auditActionLabel(ev("break_glass.reset_link", { outcome: "failed" }))).toBe("非常口からの再設定リンクの発行を試みたが失敗");
    for (const a of AUDIT_ACTIONS) expect(auditActionLabel(ev(a, { outcome: "failed" })), a).toMatch(/を試みたが失敗$/);
    // 操作の前に書く行(失敗すると後に失敗の行が付く)は「…の発行を受け付け」で揃える(「発行」→「失敗」の 2 行が並ばない)
    expect(auditActionLabel(ev("member.reset_link", {}))).toBe("パスワードの再設定リンクの発行を受け付け");
    expect(auditActionLabel(ev("break_glass.reset_link", {}))).toBe("非常口からの再設定リンクの発行を受け付け");
    // 配信ファイルの作り直しも始める前に書く行(成功・失敗の行は付かない)
    expect(auditActionLabel(ev("static.rebuild", { after: null }))).toBe("すべてのサイトの配信ファイルの作り直しを受け付け");
    // API キーの発行は、受け付けの行と、発行に成功した行(鍵の ID を持つ)を言い分ける
    expect(auditActionLabel(ev("api_key.create", { outcome: "succeeded" }))).toBe("API キーを発行");
    expect(auditActionLabel(ev("api_key.create", {}))).toBe("API キーの発行を受け付け");
  });

  it("names the variant in the action of a variant's changes and memo", () => {
    expect(auditActionLabel(ev("experiment.changes", { variant: "B", from: 3, to: 4, types: {} }))).toBe("パターン「B」の変更を保存");
    expect(auditActionLabel(ev("experiment.variant_memo", { variant: "B" }))).toBe("パターン「B」のメモを保存");
    // 名前が取れない(長さで切った・形が違う)ときは名前なしで出す
    expect(auditActionLabel(ev("experiment.changes", { from: 0, to: 1 }))).toBe("パターンの変更を保存");
    expect(auditActionLabel(ev("experiment.variant_memo", { variant: null }))).toBe("パターンのメモを保存");
  });
});

describe("audit detail line", () => {
  it("experiment.update: changed fields, short values before and after, and the save without field changes (R30・R64)", () => {
    expect(auditDetailLine(ev("experiment.update", { fields: ["trafficPercentage"], trafficPercentage: { from: 50, to: 100 } }))).toBe("配信率 50% → 100%");
    expect(auditDetailLine(ev("experiment.update", { fields: ["name", "urlMatch"], name: { from: "旧", to: "新" } }))).toBe("名前「旧」→「新」、対象 URL");
    // B69: audit_label_old_url_match。前後を持つ記録では、新しい形は要約の文、古い形(行の形に変わる前の記録)は JSON。例外を出さない
    const newShape = { include: [{ page: { part: "path", op: "startsWith", value: "/lp/" } }], exclude: [{ page: { part: "path", op: "contains", value: "/old/" } }] };
    expect(auditDetailLine(ev("experiment.update", { fields: ["urlMatch"], urlMatch: { from: { part: "path", op: "startsWith", value: "/lp/" }, to: newShape } }))).toBe(
      '対象 URL {"part":"path","op":"startsWith","value":"/lp/"} → パス が「/lp/」で始まる(ただし パス が「/old/」を含む を除く)',
    );
    for (const from of [{ op: "equals" }, { part: "zzz", op: "equals", value: "/" }, null, "x", { include: [] }])
      expect(() => auditDetailLine(ev("experiment.update", { fields: ["urlMatch"], urlMatch: { from, to: newShape } }))).not.toThrow();
    expect(auditDetailLine(ev("experiment.update", { fields: ["persistAssignment"], persistAssignment: { from: false, to: true } }))).toBe("割当の固定 オフ → オン");
    // 記録は値が変わった欄だけを持つ(R64)。変わった欄が無い保存は fields: []
    expect(auditDetailLine(ev("experiment.update", { fields: [] }))).toBe("項目の変更なしの保存");
    // R64 の前に書かれた記録(送った欄をすべて持ち、同じ値の送り直しは from = to)も壊れずに読む: from = to の欄は外す
    expect(auditDetailLine(ev("experiment.update", { fields: ["trafficPercentage"], trafficPercentage: { from: 50, to: 50 } }))).toBe("項目の変更なしの保存");
    expect(auditDetailLine(ev("experiment.update", { fields: ["name", "trafficPercentage"], name: { from: "旧", to: "新" }, trafficPercentage: { from: 50, to: 50 } }))).toBe("名前「旧」→「新」");
    expect(auditDetailLine(ev("experiment.update", { fields: ["targeting", "analytics"] }))).toBe("配信条件、外部計測");
    // 知らない欄の名前は識別子を括弧で併記する
    expect(auditDetailLine(ev("experiment.update", { fields: ["somethingNew"] }))).toBe("項目(somethingNew)");
  });

  it("experiment.status / variants / changes / evaluation_plan / create (R30・R31・R33)", () => {
    expect(auditDetailLine(ev("experiment.status", { from: "running", to: "paused" }))).toBe("配信中 → 一時停止");
    expect(auditDetailLine(ev("experiment.variants", { from: ["A", "B"], to: ["A", "B", "C"], weights: { from: [50, 50], to: [34, 33, 33] } }))).toBe(
      "パターン 2 件(A・B) → 3 件(A・B・C)、重み 50・50 → 34・33・33",
    );
    expect(auditDetailLine(ev("experiment.variants", { from: ["A", "B"], to: ["A", "B"], weights: { from: [50, 50], to: [50, 50] } }))).toBe("パターン 2 件(A・B)(変わらず)、重み 50・50(変わらず)");
    expect(auditDetailLine(ev("experiment.changes", { variant: "B", from: 3, to: 4, types: { HTML: 2, CSS: 1, TEXT: 1 } }))).toBe("変更 3 件 → 4 件(HTML 2・CSS 1・TEXT 1)");
    expect(auditDetailLine(ev("experiment.changes", { variant: "B", from: 2, to: 2, types: { TEXT: 2 } }))).toBe("変更 2 件(変わらず)(TEXT 2)");
    expect(auditDetailLine(ev("experiment.changes", { variant: "B", from: 1, to: 0, types: {} }))).toBe("変更 1 件 → 0 件");
    expect(auditDetailLine(ev("experiment.evaluation_plan", { fields: ["minDays", "maxWeeks"] }))).toBe("最低期間、最大期間");
    // 下書きの同じ計画の送り直し(R31)
    expect(auditDetailLine(ev("experiment.evaluation_plan", { fields: [] }))).toBe("項目の変更なしの保存");
    expect(auditDetailLine(ev("experiment.create", { kind: "test" }))).toBe("テスト");
    expect(auditDetailLine(ev("experiment.create", { kind: "single" }))).toBe("パーソナライズ");
    // 複製元は ID だけを持つ(元が消えていることもある)ので、ID と分かる言い方で出す
    expect(auditDetailLine(ev("experiment.duplicate", { source: "exp_old" }))).toBe("複製元 エクスペリエンス(ID: exp_old)");
    expect(auditDetailLine(ev("experiment.memo"))).toBe("");
    expect(auditDetailLine(ev("experiment.variant_memo", { variant: "B" }))).toBe("");
  });

  it("experiment.adoption names the adopted variant when the screen knows it", () => {
    expect(auditDetailLine(ev("experiment.adoption", { variant: "v_b" }), { variantNames: { v_b: "B" } })).toBe("採用 B");
    // 名前が分からない(消えたパターン・設定の「操作の記録」はパターンの名前を読まない)ときは ID と分かる言い方
    expect(auditDetailLine(ev("experiment.adoption", { variant: "v_gone" }), { variantNames: {} })).toBe("採用 パターン(ID: v_gone)");
    expect(auditDetailLine(ev("experiment.adoption", { variant: "v_b" }))).toBe("採用 パターン(ID: v_b)");
    expect(auditDetailLine(ev("experiment.adoption", { variant: null }))).toBe("採用なし");
  });

  it("site, goal, audience, asset and publish rows (R35〜R38)", () => {
    expect(auditDetailLine(ev("site.create", { domain: "example.com" }))).toBe("example.com");
    expect(auditDetailLine(ev("site.delete", { domain: "example.com" }))).toBe("example.com");
    expect(auditDetailLine(ev("site.delete", { reason: "create_failed" }))).toBe("");
    expect(auditDetailLine(ev("site.update", { fields: ["resultsRetentionDays", "domains"], resultsRetentionDays: { from: 90, to: 30 } }))).toBe("参加者ごとの記録を残す日数 90 日 → 30 日、タグを置くドメイン");
    expect(auditDetailLine(ev("site.update", { fields: ["resultsEnabled"], resultsEnabled: { from: false, to: true } }))).toBe("結果を記録する オフ → オン");
    // R64 の前の記録の from = to の欄は外す(前後を持たない欄は名前のまま残る)
    expect(auditDetailLine(ev("site.update", { fields: ["resultsEnabled", "domains"], resultsEnabled: { from: true, to: true } }))).toBe("タグを置くドメイン");
    // 選択肢の値(英語の識別子)は前後を出さず、欄の名前だけにする
    expect(auditDetailLine(ev("site.update", { fields: ["mode"], mode: { from: "A", to: "B" } }))).toBe("導入の形");
    expect(auditDetailLine(ev("site.update", { reason: "reverted" }))).toBe("");
    expect(auditDetailLine(ev("site.update", { fields: [] }))).toBe("項目の変更なしの保存");
    expect(auditDetailLine(ev("goal.create"))).toBe("");
    expect(auditDetailLine(ev("goal.update", { fields: ["name", "config"] }))).toBe("名前、達成の条件");
    expect(auditDetailLine(ev("audience.update", { fields: ["definition"] }))).toBe("条件");
    expect(auditDetailLine(ev("audience.update", { fields: [] }))).toBe("項目の変更なしの保存");
    // B68 の前の記録は experiment を持つ(読まない)。B68 の後は bytes・type だけ
    expect(auditDetailLine(ev("asset.upload", { bytes: 2048, type: "image/png", experiment: "e" }))).toBe("image/png・2.0 KB");
    expect(auditDetailLine(ev("asset.upload", { bytes: 2048, type: "image/png" }))).toBe("image/png・2.0 KB");
    expect(auditDetailLine(ev("asset.rename", { from: "hero.png", to: "トップ.png" }))).toBe("「hero.png」→「トップ.png」");
    expect(auditDetailLine(ev("asset.rename", { from: null, to: "トップ.png" }))).toBe("");
    expect(auditDetailLine(ev("asset.delete"))).toBe("");
    expect(auditDetailLine(ev("publish.publish", { version: 14, superseded: false }))).toBe("版 14");
    expect(auditDetailLine(ev("publish.publish", { version: 15, superseded: true }))).toBe("版 15(後の公開に追い越されたため、配信中にしていません)");
    expect(auditDetailLine(ev("publish.publish", { version: 15, reason: "reverted" }))).toBe("版 15");
  });

  it("people and access rows", () => {
    expect(auditDetailLine(ev("member.role_change", { from: "editor", to: "admin" }))).toBe("編集者 → 管理者");
    expect(auditDetailLine(ev("member.remove", { role: "admin", revokedKeys: 1 }))).toBe("管理者・API キー 1 件を失効");
    expect(auditDetailLine(ev("member.remove", { role: "viewer", revokedKeys: 0 }))).toBe("閲覧者");
    expect(auditDetailLine(ev("invitation.create", { role: "editor", extended: false }))).toBe("編集者");
    expect(auditDetailLine(ev("invitation.create", { role: "editor", extended: true }))).toBe("編集者(既存のリンクの期限を延長)");
    expect(auditDetailLine(ev("invitation.accept", { role: "viewer", signUp: true }))).toBe("閲覧者(アカウントを作成)");
    expect(auditDetailLine(ev("invitation.cancel", { role: "admin" }))).toBe("管理者");
    expect(auditDetailLine(ev("api_key.create", { scope: "workspace", workspaceId: "w", roleCap: "editor", expiresAt: null }))).toBe("1 つのワークスペース・編集者まで");
    expect(auditDetailLine(ev("api_key.create", { scope: "full", workspaceId: null, roleCap: null, expiresAt: null, outcome: "succeeded" }))).toBe("すべてのワークスペース");
    expect(auditDetailLine(ev("api_key.revoke_member", { owner: "jiro@example.com" }))).toBe("持ち主 jiro@example.com");
    // 管理者未満の見え方ではメールアドレスの値が null になっている
    expect(auditDetailLine(ev("api_key.revoke_member", { owner: null }))).toBe("");
    expect(auditDetailLine(ev("instance_admin.revoke", { restore: true, revokedKeys: 2 }))).toBe("元のロールに戻す・API キー 2 件を失効");
    expect(auditDetailLine(ev("instance_admin.revoke", { restore: false, revokedKeys: 0 }))).toBe("すべてのワークスペースから外す");
    expect(auditDetailLine(ev("workspace.delete", { sites: 3 }))).toBe("サイト 3 件");
    expect(auditDetailLine(ev("break_glass.sweep", { passwords: 1, sessions: 4 }))).toBe("パスワード 1 件・ログイン状態 4 件を削除");
    expect(auditDetailLine(ev("static.rebuild", { after: null }))).toBe("");
    expect(auditDetailLine(ev("static.rebuild", { after: "site_b" }))).toBe("サイト(ID: site_b)の次から");
  });

  it("usage.settings_change shows each changed setting, and {} as the save without changes (R20・R64)", () => {
    expect(auditDetailLine(ev("usage.settings_change", { cloudflarePlan: { from: "free", to: "paid" } }))).toBe("Cloudflare のプラン Free → Paid");
    // R64 の前の記録(送った項目をすべて持つ)の from = to の項目は外す
    expect(auditDetailLine(ev("usage.settings_change", { cloudflarePlan: { from: "paid", to: "paid" } }))).toBe("項目の変更なしの保存");
    expect(auditDetailLine(ev("usage.settings_change", { cloudflarePlan: { from: "paid", to: "paid" }, showPaidReference: { from: false, to: true } }))).toBe("月額 $5 に含まれる量と比べる オフ → オン");
    expect(auditDetailLine(ev("usage.settings_change", { usageVisibility: { from: "members", to: "instance_admins" }, showPaidReference: { from: true, to: false } }))).toBe(
      "使用状況を見られる人 すべてのメンバー → システム管理者のみ、月額 $5 に含まれる量と比べる オン → オフ",
    );
    expect(auditDetailLine(ev("usage.settings_change", {}))).toBe("項目の変更なしの保存");
  });

  it("does not throw on a detail of an unexpected shape (truncated, wrong types)", () => {
    expect(auditDetailLine(ev("experiment.update", { truncated: true }))).toBe("(内容が長いため省略)");
    for (const a of AUDIT_ACTIONS) {
      for (const detail of [{}, { fields: "x", from: { a: 1 }, to: [1], types: "x", weights: 3, variant: 5, version: "x" }]) {
        expect(() => auditDetailLine(ev(a, detail)), a).not.toThrow();
        expect(() => auditActionLabel(ev(a, detail)), a).not.toThrow();
      }
    }
  });
});

describe("audit actor and via", () => {
  it("the login method: password is warned, an API key carries its name", () => {
    expect(auditViaLabel(ev("site.create", {}, { via: "google" }))).toEqual({ text: "Google", warn: false });
    expect(auditViaLabel(ev("site.create", {}, { via: "password" }))).toEqual({ text: "パスワード", warn: true });
    expect(auditViaLabel(ev("site.create", {}, { via: "break_glass" }))).toEqual({ text: "非常口", warn: true });
    expect(auditViaLabel(ev("site.create", {}, { via: "api_key", apiKey: { id: "k", name: "分析エージェント" } }))).toEqual({ text: "API キー「分析エージェント」", warn: false });
    expect(auditViaLabel(ev("site.create", {}, { via: "api_key", apiKey: { id: "k", name: null } }))).toEqual({ text: "API キー", warn: false });
  });

  it("the person: name and email when the response has it, the token or the scheduled job when nobody operated", () => {
    expect(auditActorLabel(ev("site.create", {}, { actor: { userId: "u", name: "田中 花子", email: "hanako@example.com" } }))).toEqual({ name: "田中 花子", email: "hanako@example.com" });
    expect(auditActorLabel(ev("site.create", {}, { actor: { userId: "u", name: "田中 花子", email: null } }))).toEqual({ name: "田中 花子", email: null });
    expect(auditActorLabel(ev("site.create", {}, { actor: { userId: "u", name: null, email: null } }))).toEqual({ name: "(名前なし)", email: null });
    expect(auditActorLabel(ev("break_glass.reset_link", {}, { actor: null, via: "break_glass" }))).toEqual({ name: "非常用トークン", email: null });
    expect(auditActorLabel(ev("break_glass.sweep", {}, { actor: null, via: "system" }))).toEqual({ name: "定期処理", email: null });
    expect(auditActorLabel(ev("setup.complete", {}, { actor: null, via: "setup" }))).toEqual({ name: "初期設定", email: null });
  });

  // B129 Task 11(spec §7.2): 操作の記録の「操作と対象」の対象。人と招待はメールアドレス(または名前)をそのまま、ほかは種類を添える
  it("target_label_names_the_kind", () => {
    const t = (type: string, label: string | null, id: string | null = "x") => auditTargetLabel(ev("site.create", {}, { target: { type, id, label } }));
    expect(t("user", "jiro@example.com")).toBe("jiro@example.com");
    expect(t("invitation", "guest@example.net")).toBe("guest@example.net");
    expect(t("site", "example.com")).toBe("サイト「example.com」");
    expect(t("experiment", "ボタンの色")).toBe("エクスペリエンス「ボタンの色」");
    expect(t("variant", "B")).toBe("パターン「B」");
    expect(t("workspace", "キャンペーン")).toBe("ワークスペース「キャンペーン」");
    expect(t("api_key", "分析エージェント")).toBe("API キー「分析エージェント」");
    expect(t("goal", "購入")).toBe("目標「購入」");
    expect(t("audience", "新規")).toBe("オーディエンス「新規」");
    expect(t("asset", "hero.png")).toBe("画像「hero.png」");
    // 導入全体の操作(使用状況の設定・作り直し・掃除)は対象を出さない
    expect(t("instance", null, null)).toBe("");
    // 名前の無い対象は ID、どちらも無ければ種類だけ。知らない種類は名前だけ
    expect(t("site", null, "site_a")).toBe("サイト「site_a」");
    expect(t("api_key", null, null)).toBe("API キー");
    expect(t("galaxy", "x")).toBe("x");
    expect(auditTargetLabel(ev("site.create", {}, { target: null }))).toBe("");
  });

  it("no label speaks of an audit log (the screen calls it 操作の記録 / 変更履歴)", () => {
    const all = [...Object.values(AUDIT_ACTION_JA), ...Object.values(AUDIT_VIA_JA)];
    for (const s of all) expect(s).not.toMatch(/監査|audit/i);
  });
});
