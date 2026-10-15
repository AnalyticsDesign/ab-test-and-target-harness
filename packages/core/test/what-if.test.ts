import { describe, it, expect } from "vitest";
import { decide, evaluateWhatIf, type Experiment, type PageContext, type WhatIfInput } from "../src/index";

const ctx: PageContext = { url: "https://site.test/lp/", query: { utm: "x" }, device: "desktop", referrer: "" };

function exp(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: "exp_001",
    name: "Hero",
    urlMatch: { op: "contains", value: "/lp/" },
    trafficPercentage: 100,
    persistAssignment: false,
    variants: [
      { id: "a", name: "A", weight: 50, changes: [] },
      { id: "b", name: "B", weight: 50, changes: [] },
    ],
    ...overrides,
  };
}
const running = (e: Experiment): WhatIfInput => ({ experiment: e, status: "running", published: true });

describe("evaluateWhatIf (spec §13.10 / 決定 39 (2) (7))", () => {
  it("what_if_reason_precedence_is_id_independent_first", () => {
    // 非 running が最優先(draft: false のとき)。ID を渡しても reason は変わらない
    expect(evaluateWhatIf([{ experiment: exp(), status: "paused", published: false }], ctx, { visitorId: "v1" })[0]).toMatchObject({
      eligible: false,
      reason: "not_running",
      status: "paused",
      published: false,
    });
    // draft: true なら draft / paused は running として評価する
    expect(evaluateWhatIf([{ experiment: exp(), status: "paused", published: false }], ctx, { draft: true })[0]).toMatchObject({ eligible: true });
    // archived は draft: true でも復帰しない(§13.8)
    expect(evaluateWhatIf([{ experiment: exp(), status: "archived", published: false }], ctx, { draft: true })[0]!.reason).toBe("not_running");

    // status は running だが公開 config に無い = not_published(決定 39 (7))。not_running の次・url_mismatch の前に判定する
    expect(evaluateWhatIf([{ experiment: exp(), status: "running", published: false }], ctx, { visitorId: "v1" })[0]).toMatchObject({
      eligible: false,
      reason: "not_published",
      status: "running",
      published: false,
    });
    // URL が一致しなくても not_published が先(公開されていないことが先に分かる)
    expect(
      evaluateWhatIf([{ experiment: exp({ urlMatch: { op: "contains", value: "/other/" } }), status: "running", published: false }], ctx)[0]!.reason,
    ).toBe("not_published");
    // draft: true では published を見ない(D1 の現状を評価するため)
    expect(evaluateWhatIf([{ experiment: exp(), status: "running", published: false }], ctx, { draft: true })[0]!.eligible).toBe(true);

    // URL 不一致
    expect(evaluateWhatIf([running(exp({ urlMatch: { op: "contains", value: "/other/" } }))], ctx)[0]!.reason).toBe("url_mismatch");

    // 履歴条件があるのに history が無い
    const hist = exp({ targeting: { hist: "visited", pattern: "p_pricing" } });
    expect(evaluateWhatIf([running(hist)], ctx)[0]!.reason).toBe("needs_history");
    // history を渡せば普通に評価される(false なら targeting_false)
    expect(evaluateWhatIf([running(hist)], ctx, { history: { goals: {}, pages: {} } })[0]!.reason).toBe("targeting_false");
    expect(evaluateWhatIf([running(hist)], ctx, { history: { goals: {}, pages: { p_pricing: { count: 1 } } } })[0]!.eligible).toBe(true);

    // targeting false
    expect(evaluateWhatIf([running(exp({ targeting: { ctx: "device", op: "in", value: ["mobile"] } }))], ctx)[0]!.reason).toBe("targeting_false");

    // traffic は visitorId が無ければ判定しない(ID 非依存の段で止まる)
    const narrow = exp({ trafficPercentage: 1 });
    const noId = evaluateWhatIf([running(narrow)], ctx)[0]!;
    expect(noId).toMatchObject({ eligible: true, weights: [{ variantId: "a", weight: 50 }, { variantId: "b", weight: 50 }] });
    expect(noId.variantId).toBeUndefined();
    expect(noId.reason).toBeUndefined();
    // visitorId を渡すと traffic_excluded まで進む(1% で除外される ID を探す)
    const excluded = ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"].find(
      (id) => evaluateWhatIf([running(narrow)], ctx, { visitorId: id })[0]!.reason === "traffic_excluded",
    );
    expect(excluded, "1% の traffic で除外される ID が見つからない").toBeDefined();
  });

  it("what_if_matches_decide_for_eligible_experiments", () => {
    // what-if は本番と同じ割当を返す(別の分岐を持たない)
    const items = [running(exp()), running(exp({ id: "exp_002", trafficPercentage: 50 }))];
    const config = { needsProfile: false, experiments: items.map((i) => i.experiment) };
    for (const visitorId of ["visitor-1", "visitor-2", "visitor-3", "visitor-4"]) {
      const whatIf = evaluateWhatIf(items, ctx, { visitorId }).filter((r) => r.eligible);
      const real = decide(config, ctx, visitorId, null);
      expect(whatIf.map((r) => ({ experimentId: r.experimentId, variantId: r.variantId }))).toEqual(real);
    }

    // needsProfile: true でも history(= profile 非 null)を渡せば一致する(decide() の config 全体 fail-closed は
    // profile === null のときだけの話なので、profile が与えられている限りこのケースには影響しない。what-if.ts の
    // doc コメント参照 — 一致するのはこの「history あり」の条件下のみ)
    const profileItems = [running(exp()), running(exp({ id: "exp_002", trafficPercentage: 50 }))];
    const profileConfig = { needsProfile: true, experiments: profileItems.map((i) => i.experiment) };
    const history = { goals: {}, pages: {} };
    for (const visitorId of ["visitor-1", "visitor-2", "visitor-3", "visitor-4"]) {
      const whatIf = evaluateWhatIf(profileItems, ctx, { visitorId, history }).filter((r) => r.eligible);
      const real = decide(profileConfig, ctx, visitorId, history);
      expect(whatIf.map((r) => ({ experimentId: r.experimentId, variantId: r.variantId }))).toEqual(real);
    }
  });

  it("weights は Variant の定義順で常に返る(eligible でなくても)", () => {
    const r = evaluateWhatIf([{ experiment: exp(), status: "draft", published: false }], ctx)[0]!;
    expect(r.weights).toEqual([{ variantId: "a", weight: 50 }, { variantId: "b", weight: 50 }]);
  });
});

describe("evaluateWhatIf: input_missing(決定 49)", () => {
  it("配信条件が使う入力が欠けていれば input_missing(本番では対象外)", () => {
    const experiment = {
      id: "e", name: "e", urlMatch: { op: "contains" as const, value: "/" }, trafficPercentage: 100, persistAssignment: false,
      targeting: { ctx: "viewport" as const, minWidth: 768 },
      variants: [{ id: "vA", name: "A", weight: 50, changes: [] }, { id: "vB", name: "B", weight: 50, changes: [] }],
    };
    const ctx = { url: "https://a.example/", query: {}, device: "desktop" as const, referrer: "" };
    expect(evaluateWhatIf([{ experiment, status: "running", published: true }], ctx)[0]).toMatchObject({ eligible: false, reason: "input_missing" });
    expect(evaluateWhatIf([{ experiment, status: "running", published: true }], { ...ctx, viewportWidth: 1024 })[0]).toMatchObject({ eligible: true });
  });
});
