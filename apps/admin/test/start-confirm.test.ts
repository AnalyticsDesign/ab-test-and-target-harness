import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN, type EvaluationPlan } from "@wtt/stats";
import { loadStartPreview, pauseConfirm, SITE_PUBLISH_NOTE, startBlocker, startConfirmFor, startWarnings } from "@/lib/start-confirm";

const OV = { path: "experiments.t2", message: "「T2」は「T1」と同じ要素(#cta)を変えます。「T1」(先に開始・再開)が優先され、「T2」の効果は薄まって見えます", experimentIds: ["t2", "t1"] };

// B107・B66 b: 一時停止にも確認を出す。状態の変更はサイト全体を公開するので、ほかのエクスペリエンスの保存済みの編集も一緒に出ることを確認の中で言う
describe("pause confirmation and the site-wide publish note (B107・B66 b)", () => {
  it("pauseConfirm: 一時停止はすぐ止まること・再開できること・サイト全体を公開することを言う", () => {
    const c = pauseConfirm();
    expect(c.title).toBe("一時停止しますか?");
    expect(c.confirmLabel).toBe("一時停止する");
    expect(c.lead).toContain("訪問者への配信がすぐに止まります");
    expect(c.lead).toContain("再開できます");
    expect(c.sitePublish).toBe(SITE_PUBLISH_NOTE);
  });
  it("開始・再開の確認にもサイト全体を公開する 1 文が入る", () => {
    expect(startConfirmFor([OV])?.sitePublish).toBe(SITE_PUBLISH_NOTE);
    expect(startConfirmFor([], "再開", ["C"])?.sitePublish).toBe(SITE_PUBLISH_NOTE);
    expect(SITE_PUBLISH_NOTE).toContain("ほかのエクスペリエンス");
  });
  it("重なりも 0% も無い再開・パーソナライズの開始でも、ほかに未公開の編集があれば 1 文だけの確認を出す", () => {
    expect(startConfirmFor([], "再開", [], undefined, false)).toBeNull();
    expect(startConfirmFor([], "再開", [], undefined, true)).toEqual({ title: "再開しますか?", lead: "", items: [], confirmLabel: "再開する", sitePublish: SITE_PUBLISH_NOTE });
  });
  it("loadStartPreview: 自分以外の未公開の編集・オーディエンスの変更・サイト全体の変更を、ほかの未公開の変更として数える", async () => {
    const base = { overlaps: [OV], experiments: [], audienceChanges: [], siteLevelChanged: false };
    const self = { id: "t2" } as never;
    const other = { id: "t9" } as never;
    expect(await loadStartPreview("t2", () => Promise.resolve({ ...base, experiments: [self] } as never))).toEqual({ overlaps: [OV], othersUnpublished: false });
    expect((await loadStartPreview("t2", () => Promise.resolve({ ...base, experiments: [self, other] } as never))).othersUnpublished).toBe(true);
    expect((await loadStartPreview("t2", () => Promise.resolve({ ...base, audienceChanges: [{}] } as never))).othersUnpublished).toBe(true);
    expect((await loadStartPreview("t2", () => Promise.resolve({ ...base, siteLevelChanged: true } as never))).othersUnpublished).toBe(true);
    // 下見が取れなければ確認を出さずに進める(重なりの確認と同じ扱い)
    expect(await loadStartPreview("t2", () => Promise.reject(new Error("network")))).toEqual({ overlaps: [], othersUnpublished: false });
  });
});

describe("start confirmation for overlaps (決定 51、設計書 §3.3)", () => {
  it("asks nothing when there is no overlap", () => {
    expect(startConfirmFor([])).toBeNull();
    expect(startConfirmFor(undefined)).toBeNull();
  });
  it("lists the priority sentences when there is an overlap", () => {
    expect(startConfirmFor([OV])).toEqual({ title: "開始しますか?", lead: "同じ要素を変える配信中のエクスペリエンスがあります。", items: [{ key: "t2|t1", message: OV.message }], confirmLabel: "開始する", sitePublish: SITE_PUBLISH_NOTE });
    expect(startConfirmFor([OV], "再開")).toMatchObject({ title: "再開しますか?", confirmLabel: "再開する" });
  });
  it("startConfirmFor: 0% だけでも確認する(B77 K20)", () => {
    expect(startConfirmFor([], "開始", ["C"])?.items[0]?.message).toBe("C は重み 0% のため、誰にも表示されません"); // zeroWeight にはパターン名をそのまま渡す
    expect(startConfirmFor([], "開始", [])).toBeNull();
    expect(startConfirmFor([], "開始", ["C"])).toMatchObject({ title: "開始しますか?", lead: "重み 0% のパターンがあります。", confirmLabel: "開始する" });
  });
  it("重なりと 0% を 1 つの確認にまとめる(重なりがあれば lead は重なりの文)", () => {
    const c = startConfirmFor([OV], "開始", ["C", "D"]);
    expect(c?.lead).toBe("同じ要素を変える配信中のエクスペリエンスがあります。");
    expect(c?.items.map((i) => i.message)).toEqual([OV.message, "C は重み 0% のため、誰にも表示されません", "D は重み 0% のため、誰にも表示されません"]);
    expect(new Set(c?.items.map((i) => i.key)).size).toBe(3);
  });
  it("starts without asking when the preview cannot be read", async () => {
    expect((await loadStartPreview("t2", () => Promise.reject(new Error("network")))).overlaps).toEqual([]);
    expect((await loadStartPreview("t2", () => Promise.resolve({ overlaps: [OV] } as never))).overlaps).toEqual([OV]);
  });
});

const PLAN: EvaluationPlan = { ...DEFAULT_PLAN, primaryGoalId: "g_buy", baselineVariantId: "a" };
const NOT_RECORDED = "結果はツール上に残りません。後から結果の記録を有効にしても、このテストの結果は記録されません";

describe("start confirmation with the evaluation plan (D9 ③ Task 14、設計書 §5.2・§10)", () => {
  it("結果を記録する開始: 固定する内容の一覧を出す", () => {
    const c = startConfirmFor([], "開始", [], { recording: true, plan: PLAN, goalName: "購入完了", baselineName: "元のページ", comparisons: 1 });
    expect(c).not.toBeNull();
    expect(c!.title).toBe("開始して評価計画を固定しますか?");
    expect(c!.lead).toBe("次の内容で評価計画を固定します。");
    expect(c!.fixed).toEqual([
      { label: "判定に使う目標", value: "購入完了" },
      { label: "基準", value: "元のページ" },
      { label: "期間", value: "最低 14 日・最大 8 週" },
      { label: "目標参加者数", value: "なし(最低期間の終わりに判定)" },
      { label: "判定の基準", value: "上回る確率 95% 以上" },
    ]);
    expect(c!.note).toBe("開始後も期間と人数を延ばす変更はできますが、変更は記録され、結果の画面に表示されます。");
    expect(c!.notice).toBeUndefined();
    expect(c!.confirmLabel).toBe("開始する");
  });

  it("固定する内容: 目標参加者数・最小改善幅・同等とみなす幅と、比較の回数で引き上げたしきい値", () => {
    const c = startConfirmFor([], "開始", [], {
      recording: true,
      plan: { ...PLAN, targetPerVariant: 12000, delta: 0.5, rope: 0.2 },
      goalName: "購入完了",
      baselineName: "A",
      comparisons: 2,
    });
    expect(c!.fixed).toContainEqual({ label: "目標参加者数", value: "12,000 人 / パターン" });
    expect(c!.fixed).toContainEqual({ label: "判定の基準", value: "上回る確率 97.5% 以上・+0.5 ポイント超・同等とみなす幅 ±0.2 ポイント" });
  });

  it("結果を記録しない開始: 記録しない文を出し、一覧は出さない", () => {
    const c = startConfirmFor([], "開始", [], { recording: false, plan: PLAN, goalName: null });
    expect(c).not.toBeNull();
    expect(c!.title).toBe("開始しますか?");
    expect(c!.notice).toBe(NOT_RECORDED);
    expect(c!.fixed).toBeUndefined();
    expect(c!.lead).toBe(""); // 記録しない文(notice)と同じことを導入文で重ねない(fix r1)
  });

  it("重なりと重み 0% は、評価計画の一覧と同じ確認にまとめる", () => {
    const c = startConfirmFor([OV], "開始", ["C"], { recording: true, plan: PLAN, goalName: "購入完了", baselineName: "A", comparisons: 1 });
    expect(c!.lead).toBe("同じ要素を変える配信中のエクスペリエンスがあります。");
    expect(c!.items.map((i) => i.message)).toEqual([OV.message, "C は重み 0% のため、誰にも表示されません"]);
    expect(c!.fixed?.length).toBe(5);
    const off = startConfirmFor([], "開始", ["C"], { recording: false, plan: null, goalName: null });
    expect(off!.lead).toBe("重み 0% のパターンがあります。");
    expect(off!.notice).toBe(NOT_RECORDED);
  });

  it("評価計画を読めなかったときは一覧を出さず、開始は control の検査に任せる", () => {
    const c = startConfirmFor([], "開始", [], { recording: true, plan: null, goalName: null });
    expect(c!.fixed).toBeUndefined();
    expect(c!.lead).toBe("開始の時点で評価計画を固定します。");
  });

  it("startBlocker: 結果を記録する開始で判定に使う目標が無ければ、確認の前に止める", () => {
    expect(startBlocker({ recording: true, plan: { ...PLAN, primaryGoalId: null }, goalName: null })).toBe("評価計画のタブで判定に使う目標を選んでください");
    expect(startBlocker({ recording: true, plan: PLAN, goalName: "購入完了" })).toBeNull();
    expect(startBlocker({ recording: false, plan: { ...PLAN, primaryGoalId: null }, goalName: null })).toBeNull();
    expect(startBlocker({ recording: true, plan: null, goalName: null })).toBeNull();
    // 基準の重みが 0(control の 422 と同じ案内。fix r1)
    expect(startBlocker({ recording: true, plan: PLAN, goalName: "購入完了", baselineWeight: 0 })).toBe("基準のパターンの重みを 0 より大きくしてください");
    expect(startBlocker({ recording: true, plan: PLAN, goalName: "購入完了", baselineWeight: 50 })).toBeNull();
    expect(startBlocker({ recording: false, plan: PLAN, goalName: null, baselineWeight: 0 })).toBeNull();
  });

  it("startWarnings: 開始の応答の warnings(容量の見込みを含む)を文にする", () => {
    expect(startWarnings(undefined)).toEqual([]);
    expect(
      startWarnings([
        { path: "results", message: NOT_RECORDED },
        { path: "resultsCapacity", message: "計測用のデータベースの空きが少なくなります(見込み 約 420 MB)。保持期間を短くするか、終了したテストの記録を整理してください" },
      ]),
    ).toEqual([NOT_RECORDED, "計測用のデータベースの空きが少なくなります(見込み 約 420 MB)。保持期間を短くするか、終了したテストの記録を整理してください"]);
  });
});
