import { describe, expect, it } from "vitest";
import { EDITOR_TABS, draftOf, tabsFor, draftValueErrors, experimentPatchBody, failedTab, hasSteps, isDirty, isTrafficSent, acceptSavedDraft, reconcileServerUpdate, saveSteps, targetingBody, discardTarget, savedAfter, type Draft } from "@/lib/experiment-draft";
import type { Experiment } from "@/lib/types";

const EXP = {
  id: "exp_a", siteId: "s", name: "Hero", kind: "test", status: "draft", publishedStatus: null, urlMatch: { op: "equals", value: "/" }, targeting: { ctx: "device", op: "in", value: ["mobile"] },
  trafficPercentage: 100, persistAssignment: false, analytics: { overrides: { experimentName: "hero_test" }, extra: { team: "growth" } },
  createdBy: "u", updatedBy: "u", createdAt: 1, updatedAt: 2, unpublished: true, runId: null, description: "仮説: 無料体験を前に出す",
  variants: [
    { id: "a", name: "A", weight: 50, original: true, description: "", analytics: null, changes: [] },
    { id: "b", name: "B", weight: 50, original: false, description: "", analytics: null, changes: [] },
  ],
} as Experiment;

describe("experiment draft", () => {
  it("builds the form state from the experiment", () => {
    const d = draftOf(EXP);
    expect(d.name).toBe("Hero");
    expect(d.targeting).toEqual({ kind: "form", form: { logic: "and", rows: [{ id: "r1", kind: "cond", type: "device", neg: false, values: ["mobile"] }] } });
    expect(d.traffic).toBe(100);
    expect(d.expName).toBe("hero_test");
    expect(d.extra).toEqual({ team: "growth" });
    expect(d.variants.map((v) => v.id)).toEqual(["a", "b"]);
    expect(d.description).toBe("仮説: 無料体験を前に出す");
  });
  it("uses empty values when the experiment has none", () => {
    const d = draftOf({ ...EXP, targeting: null, analytics: null, variants: undefined });
    expect(d.targeting).toEqual({ kind: "form", form: { logic: "and", rows: [] } });
    expect(d.expName).toBe("");
    expect(d.extra).toEqual({});
    expect(d.variants).toEqual([]);
  });
  it("is dirty only when something differs from the initial state", () => {
    const initial = draftOf(EXP);
    expect(isDirty(initial, draftOf(EXP))).toBe(false);
    expect(isDirty(initial, { ...initial, name: "Hero 2" })).toBe(true);
    expect(isDirty(initial, { ...initial, variants: initial.variants.map((v) => (v.id === "b" ? { ...v, weight: 40 } : v)) })).toBe(true);
    const reverted = { ...initial, name: "Hero 2" };
    expect(isDirty(initial, { ...reverted, name: "Hero" })).toBe(false); // 元に戻せば未保存ではない
  });
  it("maps a failed save stage to the tab that holds the field", () => {
    expect(failedTab("patch", "name")).toBe("overview");
    expect(failedTab("patch", "urlMatch")).toBe("overview");
    expect(failedTab("patch", undefined)).toBe("overview");
    expect(failedTab("patch", "analytics")).toBe("overview"); // B77 K16: 外部計測は基本設定タブの下部のカード
    expect(failedTab("variants", "0")).toBe("variants");
    expect(failedTab("changes", "payload")).toBe("variants");
    expect(EDITOR_TABS).toEqual(["overview", "variants", "plan", "results", "history"]); // ?tab=analytics は pickParam の既定で基本設定に落ちる
  });
  it("history_tab_order(テストは 5 つ・パーソナライズは 3 つ。変更履歴は最後で、パーソナライズでも残る。B129 spec §7.1)", () => {
    // D9 ③ Task 14・15: 評価計画と結果のタブはテストだけ(パーソナライズの ?tab=plan / ?tab=results は基本設定に落ちる)
    expect(tabsFor("test")).toEqual(["overview", "variants", "plan", "results", "history"]);
    expect(tabsFor("single")).toEqual(["overview", "variants", "history"]);
  });
  it("experiment_form_keeps_unrepresentable_targeting(画面で表せない保存値は JSON のまま持ち、保存では送らない = ほかの欄の保存を止めない)", () => {
    const legacy = draftOf({ ...EXP, targeting: { hist: "visited", pattern: "p_pricing" } });
    expect(legacy.targeting).toEqual({ kind: "raw", json: { hist: "visited", pattern: "p_pricing" } });
    expect(targetingBody(legacy.targeting)).toEqual({});
    expect(targetingBody(draftOf(EXP).targeting)).toEqual({ targeting: { ctx: "device", op: "in", value: ["mobile"] } });
    expect(targetingBody(draftOf({ ...EXP, targeting: null }).targeting)).toEqual({ targeting: null });
  });
  it("想定外の保存値(スカラー・入れ子の null・未知のフィールド・不完全なページの一致)も raw にし、例外を出さず、保存では送らない(plan ② P16)", () => {
    for (const t of [false, 42, { and: [null] }, { ctx: "time", days: ["mon"], extra: 1 }, { hist: "visited", page: {} }]) {
      const d = draftOf({ ...EXP, targeting: t as never });
      expect(d.targeting).toEqual({ kind: "raw", json: t });
      expect(targetingBody(d.targeting)).toEqual({}); // 名前だけを保存しても PATCH の本文に targeting は含まれない
    }
  });
});

describe("saveSteps(B77 K17。保存の段を差分で決める)", () => {
  const TEXT = { id: "c1", type: "TEXT" as const, selector: "#cta", payload: { text: "B" } };
  const initial = draftOf(EXP);
  const withVariant = (d: Draft, id: string, patch: Partial<Draft["variants"][number]>): Draft => ({ ...d, variants: d.variants.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
  const NONE = { patchExperiment: false, experimentMemo: false, putVariants: false, variantMemos: [], putChanges: [], putPlan: false };

  it("何も変えていなければ何も送らない", () => {
    expect(saveSteps(initial, draftOf(EXP), "draft")).toEqual(NONE);
  });
  it("エクスペリエンスのメモだけ → experimentMemo のみ", () => {
    expect(saveSteps(initial, { ...initial, description: "仮説 2" }, "draft")).toEqual({ ...NONE, experimentMemo: true });
  });
  it("パターンのメモだけ → variantMemos のみ", () => {
    expect(saveSteps(initial, withVariant(initial, "b", { description: "メモ" }), "draft")).toEqual({ ...NONE, variantMemos: ["b"] });
  });
  it("名前と b の変更 → patchExperiment と putChanges [\"b\"]", () => {
    expect(saveSteps(initial, withVariant({ ...initial, name: "Hero 2" }, "b", { changes: [TEXT] }), "draft")).toEqual({ ...NONE, patchExperiment: true, putChanges: ["b"] });
  });
  it("エクスペリエンスの外部計測・配信の欄はどれでも patchExperiment(メモは載せない)", () => {
    expect(saveSteps(initial, { ...initial, expName: "x" }, "running").patchExperiment).toBe(true);
    expect(saveSteps(initial, { ...initial, extra: {} }, "running").patchExperiment).toBe(true);
    expect(saveSteps(initial, { ...initial, traffic: 50 }, "paused").patchExperiment).toBe(true);
    expect(saveSteps(initial, { ...initial, persist: true }, "draft").patchExperiment).toBe(true);
    expect(saveSteps(initial, { ...initial, urlMatch: { op: "equals", value: "/x" } } as Draft, "draft").patchExperiment).toBe(true);
  });
  it("オリジナルの切り替えだけでも、下書きなら putVariants", () => {
    expect(saveSteps(initial, withVariant(initial, "a", { original: false }), "draft")).toEqual({ ...NONE, putVariants: true });
  });
  it("パターンの集合(並び・名前・重み・外部計測)が変わったら putVariants。下書きでなければ送らない", () => {
    expect(saveSteps(initial, { ...initial, variants: [...initial.variants].reverse() }, "draft").putVariants).toBe(true);
    expect(saveSteps(initial, withVariant(initial, "b", { weight: 40 }), "draft").putVariants).toBe(true);
    expect(saveSteps(initial, withVariant(initial, "b", { name: "Blue" }), "draft").putVariants).toBe(true);
    expect(saveSteps(initial, withVariant(initial, "b", { analytics: { overrides: { variantName: "blue" } } }), "draft").putVariants).toBe(true);
    expect(saveSteps(initial, withVariant(initial, "b", { weight: 40 }), "running").putVariants).toBe(false);
  });
  it("オリジナルのパターンの変更は送らない", () => {
    expect(saveSteps(initial, withVariant(initial, "a", { changes: [TEXT] }), "draft").putChanges).toEqual([]);
  });
  it("新しいパターンは集合の更新で作り、メモと変更があればその後に送る", () => {
    const added = { ...initial, variants: [...initial.variants, { id: "c", name: "C", weight: 0, original: false, description: "新案", analytics: null, changes: [TEXT] }] };
    expect(saveSteps(initial, added, "draft")).toEqual({ ...NONE, putVariants: true, variantMemos: ["c"], putChanges: ["c"] });
    const empty = { ...initial, variants: [...initial.variants, { id: "c", name: "C", weight: 0, original: false, description: "", analytics: null, changes: [] }] };
    expect(saveSteps(initial, empty, "draft")).toEqual({ ...NONE, putVariants: true });
  });
  it("配信中でもメモと変更は送る", () => {
    expect(saveSteps(initial, withVariant({ ...initial, description: "途中の記録" }, "b", { description: "m", changes: [TEXT] }), "running")).toEqual({ ...NONE, experimentMemo: true, variantMemos: ["b"], putChanges: ["b"] });
  });
  it("終了したエクスペリエンスでメモ以外は対象にしない", () => {
    const edited = withVariant({ ...initial, name: "Hero 2", description: "結果の記録" }, "b", { description: "勝ち", changes: [TEXT] });
    expect(saveSteps(initial, edited, "archived")).toEqual({ ...NONE, experimentMemo: true, variantMemos: ["b"] });
  });
  it("draftValueErrors: エクスペリエンスと各パターンの外部計測を、保存済みの値と比べて検査する(B77 K17 (1))", () => {
    const initial = draftOf({ ...EXP, analytics: { overrides: { experimentName: "旧\t名前" } } });
    expect(draftValueErrors(initial, initial)).toEqual([]); // 変えていない古い値では止めない
    const current: Draft = {
      ...initial,
      extra: { team: "" },
      variants: [
        ...initial.variants.map((v) => (v.id === "b" ? { ...v, analytics: { overrides: { variantName: "b\nb" } } } : v)),
        { id: "c", name: "C", weight: 0, original: false, description: "", analytics: { extra: { k: "x".repeat(101) } }, changes: [] }, // 新しいパターンは保存済みの値が無い
      ],
    };
    expect(draftValueErrors(initial, current).map((e) => [e.path, e.code])).toEqual([
      [["analytics", "extra", "team"], "empty"],
      [["variants", "b", "analytics", "overrides", "variantName"], "invalid_char"],
      [["variants", "c", "analytics", "extra", "k"], "too_long"],
    ]);
  });
});

describe("B173 第 1 段 Task 7: 変えた欄だけを送る・評価計画をまとめる・新しいサーバーの値の扱い(spec §6.1)", () => {
  it("name-only change sends only { name }", () => {
    const a = draftOf(EXP);
    expect(experimentPatchBody(a, { ...a, name: "x" })).toEqual({ name: "x" });
  });
  it("isTrafficSent は experimentPatchBody が trafficPercentage を載せる条件と同じ(B173 第 2 段)", () => {
    const a = draftOf(EXP);
    for (const current of [a, { ...a, name: "x" }, { ...a, traffic: a.traffic + 1 }, { ...a, traffic: a.traffic - 1 }]) {
      expect(isTrafficSent(a, current)).toBe("trafficPercentage" in experimentPatchBody(a, current));
    }
    expect(isTrafficSent(a, a)).toBe(false);
    expect(isTrafficSent(a, { ...a, traffic: a.traffic + 1 })).toBe(true);
  });
  it("traffic-only change sends only trafficPercentage", () => {
    const a = draftOf(EXP);
    expect(experimentPatchBody(a, { ...a, traffic: 20 })).toEqual({ trafficPercentage: 20 });
  });
  it("each body field maps to its PATCH key", () => {
    const a = draftOf(EXP);
    expect(experimentPatchBody(a, { ...a, urlMatch: { op: "equals", value: "/x" } })).toEqual({ urlMatch: { op: "equals", value: "/x" } });
    expect(experimentPatchBody(a, { ...a, persist: true })).toEqual({ persistAssignment: true });
    expect(experimentPatchBody(a, { ...a, targeting: { kind: "form", form: { logic: "and", rows: [] } } })).toEqual({ targeting: null });
    expect(experimentPatchBody(a, a)).toEqual({}); // 変えていなければ空
    // メモ・パターンは本体の PATCH に載せない(別の段)
    expect(experimentPatchBody(a, { ...a, description: "x", variants: [] })).toEqual({});
  });
  it("raw targeting is never sent", () => {
    const a = draftOf({ ...EXP, targeting: { hist: "visited", pattern: "p_pricing" } });
    expect(a.targeting.kind).toBe("raw");
    const body = experimentPatchBody(a, { ...a, name: "renamed" });
    expect(body).toEqual({ name: "renamed" });
    expect("targeting" in body).toBe(false);
  });
  it("changing expName sends the whole analytics object", () => {
    const a = draftOf(EXP);
    expect(experimentPatchBody(a, { ...a, expName: "n" })).toEqual({ analytics: { overrides: { experimentName: "n" }, extra: { team: "growth" } } });
    expect(experimentPatchBody(a, { ...a, extra: {} })).toEqual({ analytics: { overrides: { experimentName: "hero_test" } } });
    expect(experimentPatchBody(a, { ...a, expName: "", extra: {} })).toEqual({ analytics: null }); // 両方空なら null
  });
  it("plan-only save sends only the plan PUT", () => {
    const a = draftOf(EXP);
    expect(saveSteps(a, a, "running", { dirty: true })).toEqual({ patchExperiment: false, experimentMemo: false, putVariants: false, variantMemos: [], putChanges: [], putPlan: true });
  });
  it("plan-only save is not treated as nothing-to-send", () => {
    const a = draftOf(EXP);
    expect(hasSteps(saveSteps(a, a, "running", { dirty: true }))).toBe(true);
    expect(hasSteps(saveSteps(a, a, "running", { dirty: false }))).toBe(false);
    expect(hasSteps(saveSteps(a, a, "running"))).toBe(false);
    expect(hasSteps(saveSteps(a, { ...a, description: "m" }, "running"))).toBe(true);
  });
  it("failedTab maps the plan stage to the plan tab", () => {
    expect(failedTab("plan", undefined)).toBe("plan");
    expect(failedTab("plan", "plan")).toBe("plan");
  });
  it("server update while clean replaces base and draft", () => {
    const a = draftOf(EXP);
    const s = { ...a, traffic: 20 };
    expect(reconcileServerUpdate({ base: a, draft: a, server: s })).toEqual({ base: s, draft: s, notice: false });
  });
  it("server update while dirty keeps the draft and shows the notice", () => {
    const a = draftOf(EXP);
    const d = { ...a, name: "mine" };
    const s = { ...a, traffic: 20 };
    expect(reconcileServerUpdate({ base: a, draft: d, server: s })).toEqual({ base: a, draft: d, notice: true });
  });
  it("server update while dirty with the same server value shows no notice", () => {
    const a = draftOf(EXP);
    const d = { ...a, name: "mine" };
    expect(reconcileServerUpdate({ base: a, draft: d, server: draftOf(EXP) })).toEqual({ base: a, draft: d, notice: false });
  });
  it("own save: after onWritten the refreshed server value replaces the draft without a notice, including other users' changes", () => {
    const sent = { ...draftOf(EXP), name: "mine" };
    const s = { ...sent, traffic: 20 };
    expect(reconcileServerUpdate({ base: sent, draft: sent, server: s })).toEqual({ base: s, draft: s, notice: false });
  });
  // B189: A を表示 → B を保存(成功)→ 読み直しが時間切れ(props は A のまま)→ C に編集 → 破棄 = B に戻り、次の PATCH も B が基準
  it("discard after an own save whose refresh timed out goes back to the sent value, until a newer server value arrives", () => {
    const shownA = draftOf(EXP);
    const sentB = { ...shownA, name: "B" };
    // 新しいサーバーの値がまだ届いていない(saved = 送った値): 破棄先は B
    const back = discardTarget({ server: shownA, saved: sentB });
    expect(back).toBe(sentB);
    expect(isDirty(back, { ...sentB, name: "C" })).toBe(true);
    expect(isDirty(back, sentB)).toBe(false);
    // 次の PATCH は B を基準に組む(メモだけ変えたら名前は載らない)
    expect(experimentPatchBody(back, { ...sentB, description: "memo" })).toEqual({});
    expect(saveSteps(back, { ...sentB, description: "memo" }, "draft", { dirty: false }).patchExperiment).toBe(false);
    // 届いた後(外枠が saved を null に戻す)は、届いたサーバーの値
    const newer = { ...sentB, traffic: 20 };
    expect(discardTarget({ server: newer, saved: null })).toBe(newer);
  });
  // B189 最終レビュー M4: 外枠の出来事の順(written → 読み直し → serverArrived)をたどり、新しいサーバーの値が届いたら送った値を捨てる
  it("savedAfter: a newer server value replaces the sent value as the discard target", () => {
    const shownA = draftOf(EXP);
    const sentB = { ...shownA, name: "B" };
    let saved = savedAfter(null, { kind: "written", sent: sentB });
    // 読み直しが時間切れ: 持ち続ける(props は A のまま)
    saved = savedAfter(saved, { kind: "refreshed", timedOut: true });
    expect(discardTarget({ server: shownA, saved })).toBe(sentB);
    // 後から新しいサーバーの値(ほかの人の配信率の変更も入った B')が届く: 捨てて、届いた値が戻り先
    const arrived = { ...sentB, traffic: 20 };
    saved = savedAfter(saved, { kind: "serverArrived" });
    expect(saved).toBeNull();
    expect(discardTarget({ server: arrived, saved })).toBe(arrived);
    // 書き込みの成功より前に届いた読み直しは、後の written が送った値を持ち直す(取り違えない)
    const early = savedAfter(savedAfter(null, { kind: "serverArrived" }), { kind: "written", sent: sentB });
    expect(discardTarget({ server: shownA, saved: early })).toBe(sentB);
  });
  // B189 最終レビュー M1: 評価計画だけの保存は、サーバーの値の鍵を変えない(serverArrived が来ない)。読み直しが反映されたら捨てる
  it("savedAfter: a refresh that landed drops the sent value even when the server key did not change", () => {
    // 未保存のまま新しい値 A' が届いて注記が出た後、本体の入力を元に戻し(base = A = draft)、評価計画だけを保存した
    const a = draftOf(EXP);
    const aNewer = { ...a, traffic: 20 };
    let saved = savedAfter(null, { kind: "written", sent: a });
    saved = savedAfter(saved, { kind: "refreshed", timedOut: false });
    expect(saved).toBeNull();
    // 破棄は、古い A ではなく届いている A' に戻る
    expect(discardTarget({ server: aNewer, saved })).toBe(aNewer);
  });
});

describe("保存の途中に届いた下書きの変更(I2)", () => {
  const withImage = (src: string): Draft => {
    const a = draftOf(EXP);
    return { ...a, variants: a.variants.map((v) => (v.id === "b" ? { ...v, changes: [{ id: "c_img", type: "IMAGE", selector: "img.hero", payload: { src } }] } : v)) } as Draft;
  };
  it("upload finished after save started: the later src stays as an unsaved change", () => {
    const saved = withImage("https://assets.example.com/sites/s/images/asset_old.png");
    const sent = { ...saved, name: "保存する名前" }; // 未保存の下書きで保存を始めた
    // 保存の途中にアップロードが終わり、欄の src を新しい画像にした
    const current = { ...sent, variants: withImage("https://assets.example.com/sites/s/images/asset_new.png").variants };
    const after = acceptSavedDraft(sent, current);
    expect(after.base).toBe(sent);
    expect(after.draft).toBe(current);
    expect(isDirty(after.base, after.draft)).toBe(true); // 保存の帯・離れる前の確認は未保存のまま
    // 読み直しで届いた値(= 送った内容)でも、新しい src は消えず、注記も出ない
    expect(reconcileServerUpdate({ base: after.base, draft: after.draft, server: sent })).toEqual({ base: sent, draft: current, notice: false });
  });
  it("no change during save: the sent draft becomes the base and nothing is unsaved", () => {
    const sent = { ...draftOf(EXP), name: "mine" };
    const after = acceptSavedDraft(sent, sent);
    expect(after).toEqual({ base: sent, draft: sent });
    expect(isDirty(after.base, after.draft)).toBe(false);
  });
});
