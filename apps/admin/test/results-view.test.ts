import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_KEYS } from "@/generated/help.ja";
import { adoptedDuplicateState, resultsView, type ResultsResponse, type ResultsView } from "@/lib/results-view";
import type { Experiment } from "@/lib/types";
import { formatLocalTime } from "@/lib/local-time";

/**
 * D9 ③ Task 15: 結果のタブの表示モデル(設計書 §7.3・§7.4・§10、モック (b))。
 * fixture(test/fixtures/results/*.json)は結果の API の応答の形(control の ResultReportSchema + deliveredChanges、記録は names / definition 付き)。
 * 場面とモックの対応: interim = 速報(評価時点の前)/ adopt = 採用候補(評価時点の後・実行中)/ insufficient = 判断材料が不足 /
 * three = 3 つのパターン / quality = 品質の問題で判定不可 / early = 評価時点の前に終了(phase stopped)/ adopted = 終了後(採用を記録)/
 * purged = 個票の削除後 / not-recorded = 結果を記録せずに開始 / store-missing = 計測用のデータベースが無い。
 * 日付はサイトのタイムゾーン(設計書 §5.3)。評価時点 = 2026-10-15 00:00(Asia/Tokyo)= UTC では 10/14
 */
const load = (name: string): ResultsResponse => JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/results", `${name}.json`), "utf8")) as ResultsResponse;
const TZ = "Asia/Tokyo";
const DAY = 864e5;
const START = Date.parse("2026-10-01T00:00:00+09:00");

/** 画面に出る文字をすべて集める(禁止語の検査用) */
function allText(v: ResultsView): string {
  return JSON.stringify(v);
}
const FORBIDDEN = [/信頼度/, /有意/, /p ?値/, /対照/, /バリエーション/, /実験/];

describe("resultsView(D9 ③ Task 15)", () => {
  it("interim: 速報の帯は「速報(判定は 10/15 に出ます)」、状態のラベルを出さず、日数と進み具合を出す", () => {
    const v = resultsView(load("interim"), { timeZone: TZ, status: "running", now: START + 7 * DAY });
    expect(v.banner?.tone).toBe("early");
    expect(v.banner?.state).toBe("速報");
    expect(v.banner?.title).toBe("速報(判定は 10/15 に出ます)");
    // 日目は 1 から数える(開始から 7 日たった時点 = 8 日目)
    expect(v.banner?.body).toContain("いまは 8 日目です(あと 7 日)");
    expect(v.banner?.progress).toEqual({ value: 8, max: 14, label: "8 / 14 日" });
    expect(v.banner?.primary).toBeUndefined();
    // カードは状態を持たず、ラベルは「判定前(速報)」だけ
    expect(v.cards.map((c) => c.state)).toEqual([null, null]);
    expect(v.cards[1]!.stateLabel).toBe("判定前(速報)");
    expect(v.cards[1]!.probText).toBe("92.3%");
    expect(v.banner?.key).toEqual({ label: "いまの基準を上回る確率", value: "92.3%", sub: "B(CTA 文言)・速報値" });
  });

  it("interim: 開始の日は 1 日目", () => {
    const v = resultsView(load("interim"), { timeZone: TZ, status: "running", now: START + 60_000 });
    expect(v.banner?.body).toContain("いまは 1 日目です(あと 14 日)");
    expect(v.banner?.progress).toEqual({ value: 1, max: 14, label: "1 / 14 日" });
  });

  it("interim + 品質の問題: 速報の帯のまま(状態のラベル「判定不可」を出さない)。品質の欄が問題を出す", () => {
    const base = load("interim");
    const v = resultsView({ ...base, quality: "blocked", qualityDetail: { ...base.qualityDetail, srmP: 0.0000001 }, notes: [...base.notes, { key: "quality_blocked_srm", params: { p: 0.0000001 } }] }, { timeZone: TZ, status: "running", now: null });
    expect(v.banner?.tone).toBe("early");
    expect(v.banner?.state).toBe("速報");
    expect(v.banner?.title).toBe("速報(判定は 10/15 に出ます)");
    expect(v.banner?.body).toContain("データ品質");
    expect(JSON.stringify(v.banner)).not.toContain("判定不可");
    expect(v.cards[1]!.stateLabel).toBe("判定前(速報)");
    expect(v.quality.level).toBe("bad");
  });

  it("interim: マウント前(now = null)は日数を出さない", () => {
    const v = resultsView(load("interim"), { timeZone: TZ, status: "running", now: null });
    expect(v.banner?.title).toBe("速報(判定は 10/15 に出ます)");
    expect(v.banner?.body).not.toContain("あと");
    expect(v.banner?.progress).toBeNull();
  });

  it("interim: 日付はサイトのタイムゾーン(UTC のサイトでは 10/14)", () => {
    const v = resultsView(load("interim"), { timeZone: "UTC", status: "running", now: null });
    expect(v.banner?.title).toBe("速報(判定は 10/14 に出ます)");
  });

  it("adopt: 評価時点を過ぎた実行中のテストは採用候補の帯・記録を終えた知らせ・主ボタン「終了して採用を記録」", () => {
    const v = resultsView(load("adopt"), { timeZone: TZ, status: "running", now: START + 15 * DAY });
    expect(v.banner?.tone).toBe("win");
    expect(v.banner?.state).toBe("採用候補");
    expect(v.banner?.title).toBe("B(CTA 文言) が基準より良い可能性が高い");
    expect(v.banner?.body).toContain("評価時点(10/15)の値で固定");
    expect(v.banner?.primary).toEqual({ kind: "stop", label: "終了して採用を記録", variantId: "b" });
    expect(v.callouts.map((c) => c.text)).toContain("評価時点で記録を終えました。テストを終了して採用を記録してください(配信は終了するまで続きます)");
    expect(v.cards[1]).toMatchObject({ isBaseline: false, state: "adopt", stateLabel: "採用候補", win: true, cvrText: "5.60%", diffText: "+0.60 ポイント(+12%)", probText: "97.1%", meter: { value: 97.1, threshold: 95 } });
    expect(v.cards[0]).toMatchObject({ isBaseline: true, diffText: null, probText: null, meter: null, state: null });
    expect(v.diffChart.map((d) => d.variantId)).toEqual(["b"]);
    expect(v.diffChart[0]!.mean).toBeCloseTo(0.6, 6);
  });

  it("adopt: 品質に問題が無ければ 1 行に畳む", () => {
    const v = resultsView(load("adopt"), { timeZone: TZ, status: "running", now: null });
    expect(v.quality.folded).toBe(true);
    expect(v.quality.headline).toBe("データ品質: 問題なし");
    expect(v.quality.rows.every((r) => r.level === "ok")).toBe(true);
  });

  it("adopt: 一時停止中も記録を終えた知らせを出す。終了したテストには出さない", () => {
    const paused = resultsView(load("adopt"), { timeZone: TZ, status: "paused", now: null });
    expect(paused.callouts.some((c) => c.text.startsWith("評価時点で記録を終えました"))).toBe(true);
    const archived = resultsView(load("adopt"), { timeZone: TZ, status: "archived", now: null });
    expect(archived.callouts.some((c) => c.text.startsWith("評価時点で記録を終えました"))).toBe(false);
    expect(archived.banner?.primary).toBeUndefined();
    expect(archived.banner?.status).toBe("採用は未記録です");
  });

  it("insufficient: 判断材料が不足の帯・主ボタン「採用なしで終了」(評価時点の後は計画を延ばせないので延長の操作は出さない)・適用の失敗で品質を開く", () => {
    const v = resultsView(load("insufficient"), { timeZone: TZ, status: "running", now: null });
    expect(v.banner?.tone).toBe("none");
    expect(v.banner?.state).toBe("判断材料が不足");
    expect(v.banner?.title).toBe("この人数では決着がつきませんでした");
    expect(v.banner?.body).toContain("B(CTA 文言) が上回る確率は 82.0% で、しきい値 95% に届きません。「差が無い」という意味ではありません。");
    expect(v.banner?.primary).toEqual({ kind: "stop", label: "採用なしで終了", variantId: null });
    expect(v.banner?.secondary).toBeUndefined();
    expect(allText(v)).not.toContain("延長");
    expect(v.quality.folded).toBe(false);
    expect(v.quality.level).toBe("warn");
    const apply = v.quality.rows.find((r) => r.helpKey === "apply-failures")!;
    expect(apply).toMatchObject({ level: "warn", value: "B(CTA 文言) 210 人(2.1%)" });
    expect(apply.note).toContain("B(CTA 文言) の変更が一部の人に効いていません。効果が薄まって見えます");
    expect(apply.note).toContain("後から効いた人");
  });

  it("three: しきい値は比較の回数で引き上げた 97.5%・最良である確率を出す・採用候補は C", () => {
    const v = resultsView(load("three"), { timeZone: TZ, status: "running", now: null });
    expect(v.banner?.title).toBe("C(CTA 文言 + 色) が基準より良い可能性が高い");
    expect(v.banner?.body).toContain("3 つのパターンのため、しきい値 97.5% で判定しています");
    expect(v.banner?.key?.sub).toBe("しきい値 97.5%");
    expect(v.banner?.primary).toEqual({ kind: "stop", label: "終了して採用を記録", variantId: "c" });
    expect(v.cards.map((c) => c.meter?.threshold ?? null)).toEqual([null, 97.5, 97.5]);
    expect(v.cards[1]!.stateLabel).toBe("判断材料が不足");
    expect(v.details.showBest).toBe(true);
    expect(v.details.rows.map((r) => r.best)).toEqual(["0.1%", "6.5%", "93.4%"]);
    expect(v.byDevice.columns).toEqual(["A(現行)", "B(CTA 文言)", "C(CTA 文言 + 色)"]);
  });

  it("quality: 判定不可の帯・カードを薄く・状態のラベルを出さない・品質は畳まず判定を止める問題として出す(検定の値は出さない)", () => {
    const v = resultsView(load("quality"), { timeZone: TZ, status: "running", now: null });
    expect(v.banner?.tone).toBe("dq");
    expect(v.banner?.state).toBe("判定不可");
    expect(v.banner?.title).toBe("データ品質に問題があるため、判定できません");
    expect(v.banner?.help).toEqual({ key: "quality", label: "データ品質とは" });
    expect(v.cards.every((c) => c.dim)).toBe(true);
    expect(v.cards.map((c) => c.stateLabel)).toEqual([null, null]);
    expect(v.quality.folded).toBe(false);
    expect(v.quality.level).toBe("bad");
    expect(v.quality.headline).toBe("データ品質: 判定を止める問題があります");
    expect(v.quality.rows.find((r) => r.helpKey === "srm")).toMatchObject({ level: "bad", value: "あり(重み 50 / 50 に対して 10,000 人 / 9,000 人)" });
    expect(allText(v)).not.toMatch(/1e-7|0\.0000001/);
  });

  it("quality + 終了して採用を記録: 判定不可の帯でも採用の記録と「<採用> だけを表示する下書きを作成」を出す", () => {
    const base = load("quality");
    const adoption = { variantId: "b", note: "", decidedAt: Date.parse("2026-10-16T10:00:00+09:00"), decidedBy: "owner@example.com" };
    const v = resultsView({ ...base, adoption }, { timeZone: TZ, status: "archived", now: null });
    expect(v.banner?.tone).toBe("dq");
    expect(v.banner?.primary).toEqual({ kind: "duplicate-adopted", label: "B(CTA 文言) だけを表示する下書きを作成", variantId: "b" });
    expect(v.banner?.status).toBe("B(CTA 文言) の採用を記録済み(10/16)");
    const none = resultsView(base, { timeZone: TZ, status: "archived", now: null });
    expect(none.banner?.status).toBe("採用は未記録です");
  });

  it("評価時点の前に終了 + 品質の問題: 判定不可の帯に終了の日を添える", () => {
    const base = load("early");
    const v = resultsView({ ...base, quality: "blocked", notes: [...base.notes, { key: "quality_blocked_mixed", params: { rate: 0.02 } }] }, { timeZone: TZ, status: "archived", now: null });
    expect(v.banner?.tone).toBe("dq");
    expect(v.banner?.body).toContain("10/10 に評価時点の前に終了しました(評価時点は 10/15 の予定)");
    expect(v.banner?.status).toBe("採用は未記録です");
  });

  it("判断材料が不足が最低の件数による: 確率がしきい値に届かないとは書かず、CV の件数の理由を出す", () => {
    const base = load("insufficient");
    const b = { ...base.variants[1]!, minCountMet: false, diff: { ...base.variants[1]!.diff!, pAboveDelta: 0.99, pBelowZero: 0.01 } };
    const v = resultsView({ ...base, variants: [base.variants[0]!, b], notes: [{ key: "min_count_not_met", params: { variantId: "b" } }] }, { timeZone: TZ, status: "running", now: null });
    expect(v.banner?.state).toBe("判断材料が不足");
    expect(v.banner?.title).toBe("CV の件数が少なすぎるため判定しません");
    expect(v.banner?.body).toContain("目安: 比べる 2 つのパターンのそれぞれで、CV の見込みが 10 件以上");
    expect(v.banner?.body).not.toContain("届きません");
    expect(v.banner?.key).toBeNull();
    expect(v.banner?.primary).toEqual({ kind: "stop", label: "採用なしで終了", variantId: null });
  });

  it("悪化の可能性が高い: 下回る確率を大きく出す", () => {
    const base = load("adopt");
    const b = { ...base.variants[1]!, state: "worse" as const, diff: { ...base.variants[1]!.diff!, mean: -0.6, relMean: -12, pAboveDelta: 0.02, pBelowZero: 0.98 } };
    const v = resultsView({ ...base, variants: [base.variants[0]!, b] }, { timeZone: TZ, status: "running", now: null });
    expect(v.banner?.tone).toBe("bad");
    expect(v.banner?.state).toBe("悪化の可能性が高い");
    expect(v.banner?.title).toBe("B(CTA 文言) は基準より悪い可能性が高い");
    expect(v.banner?.key).toEqual({ label: "基準を下回る確率", value: "98.0%", sub: "しきい値 95%" });
    expect(v.banner?.primary).toEqual({ kind: "stop", label: "採用なしで終了", variantId: null });
    expect(v.cards[1]).toMatchObject({ stateLabel: "悪化の可能性が高い", stateTone: "bad", diffSign: "neg" });
  });

  it("実務上ほぼ同等: 幅に収まる確率を大きく出す", () => {
    const base = load("adopt");
    const b = { ...base.variants[1]!, state: "equivalent" as const, diff: { ...base.variants[1]!.diff!, pAboveDelta: 0.6, pWithinRope: 0.97 } };
    const v = resultsView({ ...base, plan: { ...base.plan!, rope: 0.5 }, variants: [base.variants[0]!, b] }, { timeZone: TZ, status: "running", now: null });
    expect(v.banner?.state).toBe("実務上ほぼ同等");
    expect(v.banner?.title).toBe("B(CTA 文言) は基準と実務上ほぼ同等です");
    expect(v.banner?.body).toContain("±0.5 ポイント");
    expect(v.banner?.key).toEqual({ label: "同等とみなす幅に収まる確率", value: "97.0%", sub: "しきい値 95%" });
  });

  it("悪化と判断材料が不足が混ざる: 判断材料が不足の帯で、悪化のパターンも書く", () => {
    const base = load("three");
    const b = { ...base.variants[1]!, state: "worse" as const, diff: { ...base.variants[1]!.diff!, pAboveDelta: 0.01, pBelowZero: 0.99 } };
    const c = { ...base.variants[2]!, state: "insufficient" as const, diff: { ...base.variants[2]!.diff!, pAboveDelta: 0.9, pBelowZero: 0.1 } };
    const v = resultsView({ ...base, variants: [base.variants[0]!, b, c] }, { timeZone: TZ, status: "running", now: null });
    expect(v.banner?.state).toBe("判断材料が不足");
    expect(v.banner?.body).toContain("C(CTA 文言 + 色) が上回る確率は 90.0% で、しきい値 97.5% に届きません");
    expect(v.banner?.body).toContain("B(CTA 文言) は基準より悪い可能性が高い(下回る確率 99.0%)");
  });

  it("early(評価時点の前に終了): 終了の日と予定の評価時点・状態のラベルを出さない・採用は未記録", () => {
    const v = resultsView(load("early"), { timeZone: TZ, status: "archived", now: null });
    expect(v.banner?.tone).toBe("stop");
    expect(v.banner?.state).toBe("評価時点前に終了");
    expect(v.banner?.title).toBe("10/10 に終了しました(評価時点は 10/15 の予定)");
    expect(v.banner?.key).toEqual({ label: "基準を上回る確率", value: "93.0%", sub: "B(CTA 文言)・終了時点" });
    expect(v.banner?.primary).toBeUndefined();
    expect(v.cards[1]!.stateLabel).toBeNull();
    expect(v.callouts.some((c) => c.text.startsWith("評価時点で記録を終えました"))).toBe(false);
  });

  it("adopted: 採用の後の主ボタン「B(CTA 文言) だけを表示する下書きを作成」と採用の記録", () => {
    const v = resultsView(load("adopted"), { timeZone: TZ, status: "archived", now: null });
    expect(v.banner?.primary).toEqual({ kind: "duplicate-adopted", label: "B(CTA 文言) だけを表示する下書きを作成", variantId: "b" });
    expect(v.banner?.status).toBe("B(CTA 文言) の採用を記録済み(10/16)");
    expect(v.adoption).toEqual({
      title: "採用: B(CTA 文言)",
      summary: "+0.60 ポイント(+12%)、上回る確率 97.1%、判定「採用候補」",
      note: "「今すぐ購入」→「カートに入れて送料を確認」。モバイルで差が大きい",
      decidedAt: Date.parse("2026-10-16T10:00:00+09:00"),
      decidedBy: "owner@example.com",
    });
  });

  it("adopted: 採用なし・基準の採用の書き方", () => {
    const base = load("adopted");
    const none = resultsView({ ...base, adoption: { ...base.adoption!, variantId: null } }, { timeZone: TZ, status: "archived", now: null });
    expect(none.adoption).toMatchObject({ title: "採用なし", summary: null });
    expect(none.banner?.primary).toBeUndefined();
    expect(none.banner?.status).toBe("採用なしを記録済み(10/16)");
    const baseline = resultsView({ ...base, adoption: { ...base.adoption!, variantId: "a" } }, { timeZone: TZ, status: "archived", now: null });
    expect(baseline.adoption).toMatchObject({ title: "採用: A(現行)(基準)", summary: null });
  });

  it("purged: 個票の削除の後の文(数字は記録のまま)", () => {
    const v = resultsView(load("purged"), { timeZone: TZ, status: "archived", now: null });
    expect(v.callouts[0]).toEqual({ tone: "info", text: "参加者ごとの記録は削除済みです(保持期間 90 日)。表示しているのは評価時点に固定した結果です", helpKey: "retention" });
    expect(v.cards).toHaveLength(2);
    expect(v.empty).toBeNull();
  });

  it("purged: 記録を作る前に削除した(数値なし)", () => {
    const base = load("purged");
    const v = resultsView({ ...base, variants: [], byDevice: [], otherGoals: [], snapshots: { evaluation: false, stop: false }, adoption: null }, { timeZone: TZ, status: "archived", now: null });
    expect(v.banner).toBeNull();
    expect(v.empty).toEqual({ title: "参加者ごとの記録は削除済みです", body: "結果を記録する前に保持期間(90 日)を過ぎて削除したため、表示できる数値はありません", helpKey: "retention" });
  });

  it("not-recorded / store-missing: 数値なしの理由", () => {
    const nr = resultsView(load("not-recorded"), { timeZone: TZ, status: "running", now: null });
    expect(nr.banner).toBeNull();
    expect(nr.empty?.title).toBe("このテストは結果を記録せずに開始しました");
    expect(nr.empty?.helpKey).toBe("enable");
    const sm = resultsView(load("store-missing"), { timeZone: TZ, status: "running", now: null });
    expect(sm.banner).toBeNull();
    expect(sm.empty?.title).toBe("計測用のデータベースが導入されていません");
  });

  it("重み 0 のパターンは「配信していない」と出し、状態をラベルにしない(差の図にも出さない)", () => {
    const base = load("adopt");
    const c = { ...base.variants[1]!, id: "c", name: "C(保留)", weight: 0, n: 0, y: 0, cvr: 0, state: "insufficient" as const, diff: null };
    const v = resultsView({ ...base, variants: [...base.variants, c], notes: [{ key: "zero_weight", params: { variantId: "c" } }] }, { timeZone: TZ, status: "running", now: null });
    const card = v.cards.find((x) => x.variantId === "c")!;
    expect(card).toMatchObject({ stateLabel: "配信していない", meter: null, probText: null, notDelivered: true });
    expect(v.diffChart.map((d) => d.variantId)).toEqual(["b"]);
    // 比較の回数は配信中のパターンだけで数える(しきい値は 95% のまま)
    expect(v.cards[1]!.meter?.threshold).toBe(95);
  });

  it("収集の停止の上限は応答の値(既定の 5% に固定しない)", () => {
    const base = load("adopt");
    const v = resultsView(
      { ...base, quality: "warning", qualityDetail: { ...base.qualityDetail, stopRatio: 0.012, stopLimit: 0.016 }, notes: [{ key: "collection_stops", params: { ratio: 0.012, hours: 4, limit: 0.016 } }] },
      { timeZone: TZ, status: "running", now: null },
    );
    const row = v.quality.rows.find((r) => r.helpKey === "collection-stops")!;
    expect(row.level).toBe("warn");
    expect(row.value).toBe("約 4 時間(期間の 1.2%。上限 1.6%)");
    expect(allText(v)).not.toContain("上限 5%");
  });

  it("最小改善幅を決めたときは「+δ ポイントを超えて上回る確率」", () => {
    const base = load("adopt");
    const v = resultsView({ ...base, plan: { ...base.plan!, delta: 0.2 } }, { timeZone: TZ, status: "running", now: null });
    expect(v.cards[1]!.probLabel).toBe("+0.2 ポイントを超えて上回る確率");
    expect(v.banner?.key?.label).toBe("+0.2 ポイントを超えて上回る確率");
    expect(v.planLine).toContain("最小改善幅 +0.2 ポイント");
  });

  it("前に計算した速報(読み取りが混み合っている / 今日の上限)の知らせ", () => {
    const base = load("interim");
    const busy = resultsView({ ...base, notes: [...base.notes, { key: "interim_stale", params: { reason: "busy", computedAt: base.computedAt! } }] }, { timeZone: TZ, status: "running", now: null });
    expect(busy.callouts.some((c) => c.text.includes("ほかの集計が読み取り中"))).toBe(true);
    expect(busy.callouts.some((c) => c.text.includes(`(${formatLocalTime(base.computedAt!, "deadline", TZ)} 時点)`))).toBe(true);
    const budget = resultsView({ ...base, notes: [...base.notes, { key: "interim_stale", params: { reason: "budget", computedAt: base.computedAt! } }] }, { timeZone: TZ, status: "running", now: null });
    expect(budget.callouts.some((c) => c.text.includes("更新は UTC 0 時以降"))).toBe(true);
  });

  it("注記: 判定に要る最低の件数・A/A テスト・基準がオリジナルでない・未公開の編集・評価時点の後の編集・定義の写しなし", () => {
    const base = load("adopt");
    const v = resultsView(
      {
        ...base,
        notes: [
          { key: "min_count_not_met", params: { variantId: "b" } },
          { key: "aa_test" },
          { key: "baseline_not_original" },
          { key: "unpublished_changes", params: { variantId: "b" } },
          { key: "edited_after_evaluation", params: { variantId: "b" } },
          { key: "definition_missing" },
          { key: "not_a_known_key" } as unknown as ResultsResponse["notes"][number],
        ],
      },
      { timeZone: TZ, status: "running", now: null },
    );
    const texts = v.callouts.map((c) => c.text);
    expect(texts).toContain("B(CTA 文言): CV の件数が少なすぎるため判定しません(目安: 比べる 2 つのパターンのそれぞれで、CV の見込みが 10 件以上)");
    expect(texts.some((t) => t.startsWith("A/A テストです"))).toBe(true);
    expect(texts).toContain("基準はオリジナルではありません");
    expect(texts.some((t) => t.startsWith("B(CTA 文言) に未公開の編集があります"))).toBe(true);
    expect(texts).toContain("評価時点の後に B(CTA 文言) の変更が編集されています");
    expect(texts.some((t) => t.includes("定義の写し"))).toBe(true);
  });

  it("サイトで結果の記録を無効にしているときの知らせ", () => {
    const v = resultsView({ ...load("interim"), collection: "site_disabled" }, { timeZone: TZ, status: "running", now: null });
    expect(v.callouts.some((c) => c.helpKey === "collection-stops" && c.text.includes("無効"))).toBe(true);
  });

  it("端末別とほかの目標は参考の数値(差は区間付き)", () => {
    const v = resultsView(load("adopt"), { timeZone: TZ, status: "running", now: null });
    expect(v.byDevice.rows.map((r) => r.label)).toEqual(["デスクトップ", "モバイル", "タブレット"]);
    expect(v.byDevice.rows[0]!.cells[0]!.diff).toBeNull();
    expect(v.byDevice.rows[0]!.cells[1]!.cvr).toMatch(/%$/);
    expect(v.otherGoals.map((g) => g.name)).toEqual(["カート追加", "会員登録"]);
    expect(v.otherGoals[0]!.cells[1]!.diff).toBe("+0.80 ポイント(−0.10 〜 +1.70)");
  });

  it("adoptedDuplicateState: 採用したパターンだけを表示する方式で、そのパターンを選んだ複製の画面を開く(オリジナルは選ばない)", () => {
    const exp = {
      id: "exp_buy", name: "購入ボタンの文言テスト", kind: "test", status: "archived", trafficPercentage: 100,
      variants: [
        { id: "a", name: "A", weight: 50, original: true, description: "", analytics: null, changes: [] },
        { id: "b", name: "B", weight: 50, original: false, description: "", analytics: null, changes: [{ id: "c1", type: "TEXT", selector: "#cta", payload: { text: "B" } }] },
      ],
    } as unknown as Experiment;
    expect(adoptedDuplicateState(exp, "b")).toEqual({ mode: "variant", variantId: "b", name: "購入ボタンの文言テスト(B だけを表示)", nameEdited: false });
    expect(adoptedDuplicateState(exp, "a").variantId).toBe("b");
  });

  it("どの場面でも「信頼度」「有意」「p 値」「対照」を出さず、使う説明の鍵は原稿にある", () => {
    const names = ["interim", "adopt", "insufficient", "three", "quality", "early", "adopted", "purged", "not-recorded", "store-missing"];
    for (const name of names) {
      for (const status of ["running", "archived"] as const) {
        const v = resultsView(load(name), { timeZone: TZ, status, now: START + 7 * DAY });
        for (const re of FORBIDDEN) expect(allText(v), `${name}/${status}`).not.toMatch(re);
        const keys = JSON.stringify(v).match(/"(?:helpKey|key)":"([a-z0-9-]+)"/g) ?? [];
        for (const k of keys) {
          const key = k.split(":")[1]!.replaceAll('"', "");
          expect(HELP_KEYS as readonly string[], `${name}: ${key}`).toContain(key);
        }
      }
    }
  });
});
