import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  STATIC_HEALTH_POLL_MS,
  STATIC_HEALTH_REFRESH_EVENT,
  nextStaticHealth,
  rebuildConfirmParagraphs,
  rebuildResultLines,
  runRebuild,
  staticHealthBannerText,
  staticHealthRows,
  staticStaleText,
  type StaticHealthState,
} from "@/lib/static-health";
import type { RebuildResult, StaticHealthView } from "@/lib/types";

// 7o K14: システム管理者の全ページの帯・配信ファイルの画面・サイトの警告帯の文言と、状態の取り直しの考え方

const healthy: StaticHealthView = {
  pendingSites: [],
  removingSites: [],
  lastError: null,
  failures: 0,
  lastDeployedAt: 1_761_000_000_000,
  mismatchSites: [],
  unknownSites: [],
  undeliveredSites: [],
  publishedSites: 5,
  unpublishedWithFiles: 0,
  removingInD1: 0,
  needsAttention: false,
};
const view = (o: Partial<StaticHealthView>): StaticHealthView => ({ ...healthy, ...o });
const st = (v: StaticHealthView | null, unreachable = 0): StaticHealthState => ({ view: v, unreachable });

describe("constants", () => {
  it("5 分ごとに取り直し、作り直しの後の取り直しは window のイベントで知らせる", () => {
    expect(STATIC_HEALTH_POLL_MS).toBe(300_000);
    expect(STATIC_HEALTH_REFRESH_EVENT).toBe("wtt:static-health-refresh");
  });
});

describe("staticHealthBannerText", () => {
  it("最後のエラーがあれば、更新が止まっている旨とエラーを出す", () => {
    expect(staticHealthBannerText(st(view({ lastError: "deploy_failed: 10000 Authentication error", failures: 193, needsAttention: true })))).toBe(
      "設置タグの配信ファイルの更新が止まっています(最後のエラー: deploy_failed: 10000 Authentication error)",
    );
  });
  it("エラーが無く記録が食い違っていれば、食い違い・記録に無い・依頼が届いていないの合計のサイト数で出す", () => {
    expect(staticHealthBannerText(st(view({ mismatchSites: ["a", "b"], unknownSites: ["c"], needsAttention: true })))).toBe(
      "設置タグの配信ファイルの記録が食い違っています(3 サイト)。公開中の全サイトの配信ファイルを作り直してください",
    );
    expect(staticHealthBannerText(st(view({ mismatchSites: ["a"], unknownSites: ["b"], undeliveredSites: ["c"], needsAttention: true })))).toBe(
      "設置タグの配信ファイルの記録が食い違っています(3 サイト)。公開中の全サイトの配信ファイルを作り直してください",
    );
  });
  it("状態を 2 回続けて取得できなければ、取得できない旨を出す(直前の状態より優先)", () => {
    const text = "設置タグの配信ファイルの状態を取得できません。デプロイ専用の Worker がデプロイされているかを確かめてください";
    expect(staticHealthBannerText(st(null, 2))).toBe(text);
    expect(staticHealthBannerText(st(view({ mismatchSites: ["a"], needsAttention: true }), 3))).toBe(text);
  });
  it("1 回だけ取れなかった・まだ取れていない・確かめることが無いときは出さない", () => {
    expect(staticHealthBannerText(st(null, 1))).toBeNull();
    expect(staticHealthBannerText(st(null))).toBeNull();
    expect(staticHealthBannerText(st(view({ needsAttention: false })))).toBeNull();
    // 更新待ち・削除の消え残りだけでは帯を出さない(Q5。needsAttention が false)
    expect(staticHealthBannerText(st(view({ pendingSites: ["a"], removingSites: ["b"], needsAttention: false })))).toBeNull();
  });
  it("needsAttention でも、エラーの文も食い違いのサイトも無ければ「0 サイト」の文は出さない", () => {
    expect(staticHealthBannerText(st(view({ failures: 2, needsAttention: true })))).toBeNull();
  });
});

describe("staticHealthRows", () => {
  const labels = [
    "更新待ちのサイト",
    "削除を受け付けたが、まだ消えていないサイト",
    "最後のエラー",
    "連続の失敗",
    "最後に成功した時刻",
    "記録が食い違っているサイト",
    "デプロイ専用の Worker の記録に無い公開中のサイト",
    "更新の依頼が届いていないサイト",
  ];
  it("8 行をモックの順に並べ、最後に「更新の依頼が届いていないサイト」を足す", () => {
    const rows = staticHealthRows(healthy);
    expect(rows.map((r) => r.label)).toEqual(labels);
  });
  it("件数 0 は ok の「なし」、1 以上は warn の「<n> サイト」", () => {
    const zero = staticHealthRows(healthy);
    for (const i of [0, 1, 5, 6, 7]) expect(zero[i]!.state, labels[i]).toEqual({ kind: "ok", text: "なし" });
    const many = staticHealthRows(view({ pendingSites: ["a", "b", "c"], removingSites: ["d"], mismatchSites: ["e", "f"], unknownSites: ["g"], undeliveredSites: ["h"] }));
    expect([0, 1, 5, 6, 7].map((i) => many[i]!.state)).toEqual([
      { kind: "warn", text: "3 サイト" },
      { kind: "warn", text: "1 サイト" },
      { kind: "warn", text: "2 サイト" },
      { kind: "warn", text: "1 サイト" },
      { kind: "warn", text: "1 サイト" },
    ]);
  });
  it("エラーがあれば danger の「失敗中」と、トークンを入れ直す案内", () => {
    const rows = staticHealthRows(view({ lastError: "deploy_failed: 10000 Authentication error", failures: 193 }));
    expect(rows[2]!.state).toEqual({ kind: "danger", text: "失敗中" });
    expect(rows[2]!.description).toBe("トークンの問題(Authentication error など)なら、デプロイ用のトークンを入れ直すと、次の再試行(1 時間以内)で配置されます。");
    expect(rows[3]!.state).toEqual({ kind: "text", text: "193 回" });
    expect(rows[3]!.description).toBe("最後に成功してからの失敗の回数です。");
    expect(rows[4]!.description).toBe("この時刻より後の公開は、配信ファイルに入っていません。");
  });
  it("エラーが無ければ「なし」と、説明は —", () => {
    const rows = staticHealthRows(healthy);
    expect(rows[2]).toMatchObject({ state: { kind: "ok", text: "なし" }, description: "—" });
    expect(rows[3]).toMatchObject({ state: { kind: "text", text: "0 回" }, description: "—" });
    expect(rows[4]!.description).toBe("—");
  });
  it("成功した時刻が無ければ —(時刻はブラウザのタイムゾーンで画面が描く)", () => {
    expect(staticHealthRows(view({ lastDeployedAt: null }))[4]!.state).toEqual({ kind: "text", text: "—" });
    expect(staticHealthRows(healthy)[4]!.state.kind).toBe("text");
  });
  it("件数の行の説明はモックの文、8 行目は定期処理が依頼し直す旨", () => {
    const rows = staticHealthRows(healthy);
    expect(rows[0]!.description).toBe("公開した内容がまだ配信ファイルになっていないサイト。訪問者には前の配信ファイルが届きます。自動で再試行します。");
    expect(rows[1]!.description).toBe("削除したサイト・ワークスペースの配信ファイルが残っていて、訪問者にはまだ届きます。自動で再試行します。");
    expect(rows[5]!.description).toBe("データベースを過去の時点に戻した後などに起きます。下の「公開中の全サイトの配信ファイルを作り直す」で直ります。");
    expect(rows[6]!.description).toBe("デプロイ専用の Worker を作り直した後などに起きます。このままでは次の公開で配信ファイルが消えます。作り直しで直ります。");
    expect(rows[7]!.description).toBe("データベースでは内容が新しくなっているのに、デプロイ専用の Worker に更新の依頼が届いていないサイト。15 分ごとの定期処理が依頼し直します。");
  });
});

describe("staticStaleText", () => {
  const removing = "このサイトの削除が途中で止まっています。もう一度削除するか、「配信ファイルを作り直す」で配信を戻してください。";
  const mismatch = "このサイトの配信ファイルの記録が食い違っています(データベースを過去の時点に戻した後などに起きます)。今の公開内容で作り直してください。";
  const pending =
    "設置タグの配信ファイルが最新の公開内容になっていません。前に作った配信ファイルがあれば訪問者にはそれが届き、初めての公開でまだ無ければタグは読み込まれません。配信ファイルを更新する仕組みが設定されていれば、自動で再試行します。";
  it("削除の途中 → 食い違い → 今の文言の順に選ぶ", () => {
    expect(staticStaleText({ staticRemoving: true, staticMismatch: true })).toBe(removing);
    expect(staticStaleText({ staticRemoving: false, staticMismatch: true })).toBe(mismatch);
    expect(staticStaleText({ staticRemoving: false, staticMismatch: false })).toBe(pending);
    expect(staticStaleText({ staticRemoving: false })).toBe(pending);
  });
});

describe("nextStaticHealth", () => {
  const prev = st(view({ mismatchSites: ["a"], needsAttention: true }), 1);
  it("正しい形の data なら新しい値にし、取れなかった回数を 0 に戻す", () => {
    const fresh = view({ lastError: "x", needsAttention: true });
    expect(nextStaticHealth(prev, { ok: true, data: fresh })).toEqual({ view: fresh, unreachable: 0 });
  });
  it("形が違う data と、それ以外の失敗は直前の値を保つ(帯は直前の表示のまま)", () => {
    expect(nextStaticHealth(prev, { ok: true, data: null })).toBe(prev);
    expect(nextStaticHealth(prev, { ok: true, data: { ...healthy, failures: "1" } })).toBe(prev);
    expect(nextStaticHealth(prev, { ok: true, data: { ...healthy, mismatchSites: [1] } })).toBe(prev);
    expect(nextStaticHealth(prev, { ok: false, reason: "other" })).toBe(prev);
  });
  it("届かない失敗は値を保って回数を足し、2 回続くと帯が取得できない旨になる", () => {
    const one = nextStaticHealth(st(null), { ok: false, reason: "unreachable" });
    expect(one).toEqual({ view: null, unreachable: 1 });
    expect(staticHealthBannerText(one)).toBeNull();
    const two = nextStaticHealth(one, { ok: false, reason: "unreachable" });
    expect(two).toEqual({ view: null, unreachable: 2 });
    expect(staticHealthBannerText(two)).toBe("設置タグの配信ファイルの状態を取得できません。デプロイ専用の Worker がデプロイされているかを確かめてください");
    const kept = nextStaticHealth(prev, { ok: false, reason: "unreachable" });
    expect(kept.view).toBe(prev.view);
    expect(kept.unreachable).toBe(2);
  });
  it("仕組みが設定されていない失敗は何回続いても回数を 0 にする(帯を出さない)", () => {
    let s = st(null, 1);
    for (let i = 0; i < 3; i++) s = nextStaticHealth(s, { ok: false, reason: "not_configured" });
    expect(s).toEqual({ view: null, unreachable: 0 });
    expect(staticHealthBannerText(s)).toBeNull();
    expect(nextStaticHealth(prev, { ok: false, reason: "not_configured" })).toEqual({ view: prev.view, unreachable: 0 });
  });
});

describe("rebuildConfirmParagraphs", () => {
  it("公開中のサイトの数と、削除の途中のサイトの数(1 以上のとき)を入れる", () => {
    expect(rebuildConfirmParagraphs(view({ publishedSites: 5, removingInD1: 1 }))).toEqual([
      "公開中の全サイト(5 サイト)の配信ファイルを、今の公開内容で作り直します。デプロイ専用の Worker を作り直した後や、データベースを過去の時点に戻した後に使います。",
      "削除の途中のサイト(1 サイト)は対象外です。公開の内容と訪問者の割り当ては変わりません。",
    ]);
    expect(rebuildConfirmParagraphs(view({ publishedSites: 5, removingInD1: 0 }))[1]).toBe("削除の途中のサイトは対象外です。公開の内容と訪問者の割り当ては変わりません。");
  });
  it("未公開か、データベースに無いのに配信ファイルが残っているサイトがあれば、消す旨を足す", () => {
    const ps = rebuildConfirmParagraphs(view({ publishedSites: 5, unpublishedWithFiles: 2 }));
    expect(ps).toHaveLength(3);
    expect(ps[1]).toBe("データベースでは未公開か、データベースに無いのに配信ファイルが残っている 2 サイトは、配信ファイルを消します。");
  });
});

describe("rebuildResultLines", () => {
  const base = { requested: 5, removed: 0, skippedRemoving: 0, failed: [] as RebuildResult["failed"] };
  it("受け付けたサイトの数を 1 行目に出す", () => {
    expect(rebuildResultLines(base)).toEqual([
      "公開中の 5 サイトの配信ファイルの作り直しを受け付けました。配置は 1 分ほどで終わり、訪問者に届くまでさらに 1 分ほどかかります。上の表で状態を確かめてください。",
    ]);
  });
  it("削除を頼んだサイトがあるときだけ、その行を足す", () => {
    expect(rebuildResultLines({ ...base, removed: 2 })).toContain("データベースでは未公開か、データベースに無い 2 サイトの配信ファイルの削除を頼みました。");
    expect(rebuildResultLines(base).some((l) => l.includes("削除を頼みました"))).toBe(false);
  });
  it("失敗は、時間をおいて押せば直るものと、公開し直すものの 2 行に分け、それぞれに該当の ID だけを入れる", () => {
    const lines = rebuildResultLines({
      ...base,
      failed: [
        { siteId: "s_unavail", reason: "unavailable" },
        { siteId: "s_norecord", reason: "no_publish_record" },
        { siteId: "s_rejected", reason: "rejected" },
      ],
    });
    const retry = lines.find((l) => l.includes("受け付けられませんでした"))!;
    const republish = lines.find((l) => l.includes("公開履歴が無いため作り直せませんでした"))!;
    expect(retry).toBe("次のサイトは受け付けられませんでした: s_unavail、s_rejected。時間をおいてもう一度押してください。");
    expect(republish).toBe("次のサイトは公開履歴が無いため作り直せませんでした: s_norecord。そのサイトを公開し直してください。");
    expect(retry).not.toContain("s_norecord");
    expect(republish).not.toContain("s_unavail");
  });
  it("削除の途中で対象外にしたサイトがあればその行を足す", () => {
    expect(rebuildResultLines({ ...base, skippedRemoving: 1 })).toContain("削除の途中の 1 サイトは対象外にしました。");
  });
});

describe("runRebuild", () => {
  it("next が null になるまで続きを頼み、結果を合計する", async () => {
    const pages: RebuildResult[] = [
      { requested: 25, removed: 1, skippedRemoving: 1, failed: [{ siteId: "s1", reason: "unavailable" }], next: "s25" },
      { requested: 2, removed: 0, skippedRemoving: 0, failed: [{ siteId: "s26", reason: "no_publish_record" }], next: null },
    ];
    const call = vi.fn(async (_after: string | null) => pages.shift()!);
    const progress: number[] = [];
    const total = await runRebuild(call, (n) => progress.push(n));
    expect(call.mock.calls.map((c) => c[0])).toEqual([null, "s25"]);
    expect(total).toEqual({
      requested: 27,
      removed: 1,
      skippedRemoving: 1,
      failed: [
        { siteId: "s1", reason: "unavailable" },
        { siteId: "s26", reason: "no_publish_record" },
      ],
    });
    expect(progress).toEqual([25, 27]);
  });
  it("続きの ID が進まなければ止める(同じ頁を頼み続けない)", async () => {
    const call = vi.fn(async () => ({ requested: 1, removed: 0, skippedRemoving: 0, failed: [], next: "s1" }) satisfies RebuildResult);
    await expect(runRebuild(call, () => {})).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("途中の失敗は投げる", async () => {
    const call = vi.fn(async (after: string | null) => {
      if (after === null) return { requested: 25, removed: 0, skippedRemoving: 0, failed: [], next: "s25" } satisfies RebuildResult;
      throw new Error("boom");
    });
    await expect(runRebuild(call, () => {})).rejects.toThrow("boom");
  });
});

// capabilities.test.ts の「capabilities banners structure」と同じ読み方(コメントを除いて形を見る)
describe("static health banner structure", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (f: string) => strip(readFileSync(path.join(import.meta.dirname, "..", f), "utf8"));
  it("帯は startCapabilitiesPoll を 5 分の間隔で使い、/capabilities は取りに行かない", () => {
    const src = read("components/StaticHealthBanner.tsx");
    expect(src).toMatch(/startCapabilitiesPoll\(/);
    expect(src).toMatch(/intervalMs:\s*STATIC_HEALTH_POLL_MS/);
    // 取りに行く先の文字列(import の "@/lib/capabilities-poll" は当たらない)
    expect(src).not.toMatch(/["'`]\/capabilities["'`?]/);
    expect(src).toMatch(/\/static\/status/);
  });
  it("layout は帯をシステム管理者の条件の中だけに、CapabilitiesBanners の後に置く", () => {
    const layout = read("app/w/layout.tsx");
    expect(layout.match(/<StaticHealthBanner\b/g)).toHaveLength(1);
    expect(layout).toMatch(/instanceAdmin\s*\?\s*<StaticHealthBanner\b/);
    expect(layout.indexOf("<StaticHealthBanner")).toBeGreaterThan(layout.indexOf("<CapabilitiesBanners"));
  });
});
