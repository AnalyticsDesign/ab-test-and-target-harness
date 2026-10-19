import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN, type EvaluationPlan } from "@wtt/stats";
import {
  baselineNote,
  cautionMessage,
  draftEvaluationEstimate,
  editableFields,
  extensionErrors,
  notRecordingNotice,
  planCautionsOf,
  planFormErrors,
  planFormState,
  planDirty,
  planMode,
  planPutBody,
  syncPlanState,
  PLAN_MODE_NOTICE,
  sampleSizeEstimate,
} from "@/lib/evaluation-plan";

const PLAN: EvaluationPlan = { ...DEFAULT_PLAN, primaryGoalId: "g_buy", baselineVariantId: "a" };
const view = (plan: EvaluationPlan = PLAN) => ({ plan });

describe("evaluation plan form (D9 ③ Task 14、設計書 §5.1)", () => {
  it("planFormState: 数は文字列の入力にし、目標参加者数・同等とみなす幅が無ければ空欄", () => {
    expect(planFormState(view())).toEqual({
      primaryGoalId: "g_buy",
      baselineVariantId: "a",
      minDays: "14",
      maxWeeks: "8",
      targetPerVariant: "",
      delta: "0",
      rope: "",
      threshold: "95",
    });
    expect(planFormState(view({ ...PLAN, targetPerVariant: 1200, rope: 0.5 }))).toMatchObject({ targetPerVariant: "1200", rope: "0.5" });
  });

  it("planPutBody: 変えた項目だけを送る(集計の定義は送らない)。空欄の目標参加者数・同等の幅は null", () => {
    const form = { ...planFormState(view()), minDays: "21", targetPerVariant: "1500" };
    expect(planPutBody(form, PLAN)).toEqual({ plan: { minDays: 21, targetPerVariant: 1500 } });
    expect(planPutBody(planFormState(view()), PLAN)).toEqual({ plan: {} });
    const cleared = { ...planFormState(view({ ...PLAN, targetPerVariant: 1200, rope: 0.5 })), targetPerVariant: "", rope: " " };
    expect(planPutBody(cleared, { ...PLAN, targetPerVariant: 1200, rope: 0.5 })).toEqual({ plan: { targetPerVariant: null, rope: null } });
    expect(planPutBody({ ...planFormState(view()), primaryGoalId: "g_other" }, PLAN).plan).not.toHaveProperty("definition");
  });

  it("planPutBody: 理由は空白だけなら送らない", () => {
    const form = { ...planFormState(view()), maxWeeks: "10" };
    expect(planPutBody(form, PLAN, "  ")).toEqual({ plan: { maxWeeks: 10 } });
    expect(planPutBody(form, PLAN, " 季節の変動を含めるため ")).toEqual({ plan: { maxWeeks: 10 }, reason: "季節の変動を含めるため" });
  });

  it("planFormErrors: 日数・週数・人数は整数だけ(control は整数を求める)", () => {
    expect(planFormErrors(planFormState(view()))).toEqual({});
    const bad = { ...planFormState(view()), minDays: "7.5", maxWeeks: "", targetPerVariant: "abc", delta: "", threshold: "x" };
    const e = planFormErrors(bad);
    expect(e.minDays).toBe("最低期間は日数を整数で入力してください");
    expect(e.maxWeeks).toBe("最大期間は週数を整数で入力してください");
    expect(e.targetPerVariant).toBe("目標参加者数は人数を整数で入力してください(設けないときは空欄にします)");
    expect(e.delta).toBe("最小改善幅は数で入力してください");
    expect(e.threshold).toBe("確率のしきい値は数で入力してください");
    expect(planFormErrors({ ...planFormState(view()), rope: "" })).toEqual({});
  });
});

describe("plan mode and editable fields after the start (設計書 §5.4・§10)", () => {
  it("editableFields: 固定前はすべて、評価時点の前は延ばす 3 項目だけ、評価時点の後は無し", () => {
    expect([...editableFields(false, false)].sort()).toEqual(["baselineVariantId", "delta", "maxWeeks", "minDays", "primaryGoalId", "rope", "targetPerVariant", "threshold"]);
    expect([...editableFields(true, false)].sort()).toEqual(["maxWeeks", "minDays", "targetPerVariant"]);
    expect(editableFields(true, true).size).toBe(0);
  });

  it("planMode: 下書き / 延ばすだけ / 評価時点の後 / 結果を記録しないで開始 / 終了 / 閲覧者", () => {
    const fixed = { fixed: true, evaluation: { evaluationAt: 1_000 } };
    expect(planMode({ status: "draft", canEdit: true, view: { fixed: false, evaluation: null }, now: 0 })).toBe("draft");
    expect(planMode({ status: "running", canEdit: true, view: fixed, now: 999 })).toBe("extend");
    expect(planMode({ status: "paused", canEdit: true, view: fixed, now: 999 })).toBe("extend");
    expect(planMode({ status: "running", canEdit: true, view: fixed, now: 1_000 })).toBe("evaluated");
    // 時刻が分かる前(マウント前)は延ばす入力を出さない(評価時点の後かもしれない)
    expect(planMode({ status: "running", canEdit: true, view: fixed, now: null })).toBe("readonly");
    expect(planMode({ status: "running", canEdit: true, view: { fixed: false, evaluation: null }, now: 0 })).toBe("unfixed");
    expect(planMode({ status: "archived", canEdit: true, view: fixed, now: 0 })).toBe("archived");
    expect(planMode({ status: "draft", canEdit: false, view: { fixed: false, evaluation: null }, now: 0 })).toBe("readonly");
  });

  it("PLAN_MODE_NOTICE: 開始後の各場面の案内", () => {
    expect(PLAN_MODE_NOTICE.extend).toBe("開始後は、評価時点の前に最低期間・最大期間を延ばす変更と、目標参加者数を増やす(新しく設ける)変更だけができます。変更は記録され、結果の画面に表示されます");
    expect(PLAN_MODE_NOTICE.evaluated).toBe("評価時点を過ぎたので、評価計画は変えられません。続けて確かめるときは複製して新しいテストにしてください");
    expect(PLAN_MODE_NOTICE.unfixed).toBe("このテストは結果を記録しないで開始したので、評価計画を判定に使いません。評価計画を使うときは、結果を記録するサイトで複製して開始してください");
    // 終了したテストの文はエディタの上部の帯だけに出す(タブで同じ文を重ねない。fix r1)
    expect(PLAN_MODE_NOTICE).not.toHaveProperty("archived");
  });

  it("extensionErrors: 開始後は延ばす向きだけ受ける(短くする・減らす・外すは欄の下に理由)", () => {
    const fixedPlan = { ...PLAN, targetPerVariant: 1000 };
    const base = planFormState(view(fixedPlan));
    expect(extensionErrors(fixedPlan, { ...base, minDays: "21", maxWeeks: "10", targetPerVariant: "1500" })).toEqual({});
    expect(extensionErrors(fixedPlan, { ...base, minDays: "7" })).toEqual({ minDays: "開始後は最低期間を短くできません(今は 14 日)" });
    expect(extensionErrors(fixedPlan, { ...base, maxWeeks: "6" })).toEqual({ maxWeeks: "開始後は最大期間を短くできません(今は 8 週)" });
    expect(extensionErrors(fixedPlan, { ...base, targetPerVariant: "800" })).toEqual({ targetPerVariant: "開始後は目標参加者数を減らしたり外したりできません(今は 1,000 人)" });
    expect(extensionErrors(fixedPlan, { ...base, targetPerVariant: "" })).toEqual({ targetPerVariant: "開始後は目標参加者数を減らしたり外したりできません(今は 1,000 人)" });
    // 目標参加者数の無い計画に新しく設けるのは受ける
    expect(extensionErrors(PLAN, { ...planFormState(view()), targetPerVariant: "500" })).toEqual({});
  });
});

describe("cautions (設計書 §5.1・§10、planCautions)", () => {
  it("cautionMessage: 14 日未満・7 日未満・95 未満・目標参加者数なし", () => {
    expect(cautionMessage({ key: "min_days_short", params: { minDays: 10 } })).toEqual({ tone: "info", text: "14 日未満のため、曜日による変動を 2 週分ならして見られません" });
    expect(cautionMessage({ key: "min_days_very_short", params: { minDays: 5 } })).toEqual({ tone: "warn", text: "7 日未満のため、曜日が 1 周しません。曜日で CVR が変わるサイトでは、結果が偏ります" });
    expect(cautionMessage({ key: "threshold_low", params: { threshold: 90 } })).toEqual({ tone: "warn", text: "確率のしきい値を 95% 未満にすると、誤って勝ちと出る率が上がります" });
    expect(cautionMessage({ key: "no_target" })).toEqual({
      tone: "info",
      text: "目標参加者数を決めないと、人数に関係なく最低期間の終わりに判定します。必要な人数の目安を使って決めることをお勧めします",
    });
  });
  it("planCautionsOf: 入力中の値から出す(数にできない欄は保存済みの値で見る)", () => {
    const keys = (f: ReturnType<typeof planFormState>) => planCautionsOf(f, PLAN).map((c) => c.key);
    expect(keys(planFormState(view()))).toEqual(["no_target"]);
    expect(keys({ ...planFormState(view()), minDays: "10", threshold: "90", targetPerVariant: "500" })).toEqual(["min_days_short", "threshold_low"]);
    expect(keys({ ...planFormState(view()), minDays: "3", targetPerVariant: "500" })).toEqual(["min_days_very_short"]);
    expect(keys({ ...planFormState(view()), minDays: "", targetPerVariant: "500" })).toEqual([]);
  });
});

describe("sample size helper (補助計算、@wtt/stats の sampleSize)", () => {
  it("2 パターンの目安と、最大期間に収まるか", () => {
    const r = sampleSizeEstimate({ cvrPercent: 5, diffPoints: 1, perDay: 500, activeVariants: 2, threshold: 95, maxWeeks: 8 });
    expect(r).not.toBeNull();
    expect(r!.perVariant).toBe(8158);
    expect(r!.total).toBe(16316);
    expect(r!.days).toBe(33);
    expect(r!.text).toBe("5% → 6% の差を見つけるには、1 パターンあたり約 8,158 人(2 つで合計約 16,316 人)。1 日 500 人なら約 33 日かかります");
    expect(r!.fit).toEqual({ ok: true, text: "最大期間(56 日)に収まる見込みです" });
    expect(r!.raised).toBeNull();
  });
  it("3 パターンではしきい値を引き上げて計算し、収まらなければ打ち手を示す", () => {
    const r = sampleSizeEstimate({ cvrPercent: 5, diffPoints: 1, perDay: 100, activeVariants: 3, threshold: 95, maxWeeks: 8 })!;
    expect(r.raised).toBe("3 つのパターンを比べるため、しきい値を 97.5% に引き上げて計算しています");
    expect(r.fit.ok).toBe(false);
    expect(r.fit.text).toBe("最大期間(56 日)に収まりません。見つけたい差を大きくする・パターンを減らす・最大期間を延ばす、のいずれかを検討してください");
  });
  it("計算できない入力は null(sampleSize の RangeError を画面に出さない)", () => {
    expect(sampleSizeEstimate({ cvrPercent: 0, diffPoints: 1, perDay: 500, activeVariants: 2, threshold: 95, maxWeeks: 8 })).toBeNull();
    expect(sampleSizeEstimate({ cvrPercent: 5, diffPoints: 0, perDay: 500, activeVariants: 2, threshold: 95, maxWeeks: 8 })).toBeNull();
    expect(sampleSizeEstimate({ cvrPercent: Number.NaN, diffPoints: 1, perDay: 500, activeVariants: 2, threshold: 95, maxWeeks: 8 })).toBeNull();
    expect(sampleSizeEstimate({ cvrPercent: 5, diffPoints: 1, perDay: 0, activeVariants: 2, threshold: 95, maxWeeks: 8 })).toBeNull();
  });
});

describe("draft timeline (開始から評価時点までの見込み)", () => {
  it("目標参加者数なし = 最低期間の終わり", () => {
    expect(draftEvaluationEstimate({ minDays: 14, maxWeeks: 8, target: null, perDay: 500, activeVariants: 2 })).toEqual({ days: 14, text: "最低期間の終わりに判定します" });
  });
  it("目標参加者数あり = 届く日(最低期間より前なら最低期間の終わり)、最大期間を超えれば最大期間の終わり", () => {
    expect(draftEvaluationEstimate({ minDays: 14, maxWeeks: 8, target: 10000, perDay: 500, activeVariants: 2 })).toEqual({ days: 40, text: "各パターンが 10,000 人に達した日(見込み)に判定します" });
    expect(draftEvaluationEstimate({ minDays: 14, maxWeeks: 8, target: 1000, perDay: 500, activeVariants: 2 })).toEqual({ days: 14, text: "各パターンが 1,000 人に達した日(見込み)に判定します" });
    expect(draftEvaluationEstimate({ minDays: 14, maxWeeks: 8, target: 100000, perDay: 500, activeVariants: 2 })).toEqual({
      days: 56,
      text: "目標に届く見込みは約 400 日後で最大期間を超えるため、最大期間の終わりに判定する見込みです。多くは「判断材料が不足」になります",
    });
    // 1 日の見込みが分からなければ、届く日は出さない
    expect(draftEvaluationEstimate({ minDays: 14, maxWeeks: 8, target: 1000, perDay: null, activeVariants: 2 })).toEqual({ days: null, text: "各パターンが 1,000 人に達した日に判定します(最大期間の終わりまでに届かなければ、その日に判定します)" });
  });
});

describe("notices on the plan tab", () => {
  it("notRecordingNotice: 結果を記録しないサイトの上部の警告(導入に計測用のデータベースが無いときは有効にする導線を出さない)", () => {
    expect(notRecordingNotice(true)).toEqual({
      title: "このサイトは結果を記録しない設定です",
      body: "このまま開始すると、結果はツール上に残りません(GA4 / BigQuery には今までどおり送られます)。終わったテストのデータは後から取り戻せません",
      canEnable: true,
    });
    expect(notRecordingNotice(false)).toEqual({
      title: "この導入では結果を記録できません",
      body: "計測用のデータベースが導入されていないため、このまま開始すると、結果はツール上に残りません(GA4 / BigQuery には今までどおり送られます)",
      canEnable: false,
    });
  });
  it("baselineNote: 基準が変更を持つパターンなら、何との比較になるかを知らせる", () => {
    expect(baselineNote({ name: "元のページ", original: true, changes: [] })).toBeNull();
    expect(baselineNote({ name: "B", original: false, changes: [] })).toBeNull();
    expect(baselineNote({ name: "B", original: false, changes: [{}, {}] })).toBe("基準に変更が 2 件あります。結果は「今のページとの比較」ではなく「B との比較」になります");
  });
  it("文言にサイトを Site と書かない(stats の planIssues の文言をそのまま出さない)", () => {
    const all = [
      ...Object.values(PLAN_MODE_NOTICE),
      notRecordingNotice(true).title,
      notRecordingNotice(true).body,
      ...(["min_days_short", "min_days_very_short", "threshold_low", "no_target"] as const).map((key) => cautionMessage({ key, params: { minDays: 1, threshold: 90 } }).text),
    ];
    for (const s of all) expect(s).not.toMatch(/\bSite\b/);
  });
});

describe("plan state across editor remounts (fix r1)", () => {
  const V = { plan: PLAN, fixed: false, fixedAt: null, evaluation: null, cautions: [], changes: [] };
  it("planDirty: 保存済みの計画と入力が違うときだけ", () => {
    expect(planDirty(null, null)).toBe(false);
    expect(planDirty(V, planFormState(V))).toBe(false);
    expect(planDirty(V, { ...planFormState(V), minDays: "21" })).toBe(true);
  });
  it("syncPlanState: 読み直した計画で置き換える。未保存の入力があれば入力は残し、比べる計画だけ新しくする", () => {
    const fixedView = { ...V, fixed: true, fixedAt: 5 };
    // 未保存なし → 入力も読み直した値にする
    expect(syncPlanState({ view: V, form: planFormState(V) }, fixedView)).toEqual({ view: fixedView, form: planFormState(fixedView) });
    // 未保存あり → 入力は残す
    const edited = { ...planFormState(V), maxWeeks: "10" };
    expect(syncPlanState({ view: V, form: edited }, fixedView)).toEqual({ view: fixedView, form: edited });
    // 読めなかった(null)→ 入力が無ければ null のまま
    expect(syncPlanState({ view: null, form: null }, fixedView)).toEqual({ view: fixedView, form: planFormState(fixedView) });
    expect(syncPlanState({ view: V, form: planFormState(V) }, null)).toEqual({ view: null, form: null });
  });
});
