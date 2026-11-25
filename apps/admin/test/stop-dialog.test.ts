import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResultsResponse } from "@/lib/results-view";
import { adoptionListText, baselineOf, selectionNotes, stopDialogState, stopDuplicateOption, stopView, submitStop, verdictHint } from "@/lib/stop-dialog";
import { capacityWarning } from "@/lib/results-settings";
import type { Experiment, StatusResult } from "@/lib/types";

/**
 * D9 ③ Task 16: 終了のモーダル(設計書 §8.2)・一覧の採用の要約(§8.1)・Site の設定の容量の警告(plan ③ K18)。
 * fixture は結果のタブと同じ(test/fixtures/results)。評価時点 = 2026-10-15 00:00(Asia/Tokyo)
 */
const load = (name: string): ResultsResponse => JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/results", `${name}.json`), "utf8")) as ResultsResponse;
const TZ = "Asia/Tokyo";

const TEXT = { id: "c1", type: "TEXT", selector: "#cta", payload: { text: "B" } };
const EXP = {
  id: "exp_buy", siteId: "s", name: "購入ボタンの文言テスト", kind: "test", status: "running", publishedStatus: "running", urlMatch: { include: [{ page: { op: "equals", value: "/" } }] }, targeting: null,
  trafficPercentage: 100, persistAssignment: false, analytics: null, createdBy: "u", updatedBy: "u", createdAt: 1, updatedAt: 2, unpublished: false, description: "", runId: "run_1",
  variants: [
    { id: "a", name: "A(現行)", weight: 50, original: true, description: "", analytics: null, changes: [] },
    { id: "b", name: "B(CTA 文言)", weight: 50, original: false, description: "", analytics: null, changes: [TEXT] },
  ],
} as unknown as Experiment;
const THREE = {
  ...EXP,
  variants: [...EXP.variants!.map((v) => ({ ...v, weight: v.id === "a" ? 33 : 34 })), { id: "c", name: "C(CTA 文言 + 色)", weight: 33, original: false, description: "", analytics: null, changes: [TEXT] }],
} as unknown as Experiment;

describe("stopDialogState(設計書 §8.2)", () => {
  it("options: one per non-baseline pattern with its verdict and probability, then 採用なし; a baseline without changes has no option", () => {
    const s = stopDialogState(load("adopt"), EXP, { timeZone: TZ });
    expect(s.options).toEqual([
      { variantId: "b", label: "B(CTA 文言) を採用", note: "採用候補・上回る確率 97.1%" },
      { variantId: null, label: "採用なし", note: "今のままにする。分かったことはメモに残す" },
    ]);
  });

  it("initial: the adopt candidate of the evaluation record", () => {
    expect(stopDialogState(load("adopt"), EXP, { timeZone: TZ }).initial).toBe("b");
  });

  it("initial: with several adopt candidates, the one with the higher probability of being best", () => {
    const r = load("three");
    const both = { ...r, variants: r.variants.map((v) => (v.id === "b" ? { ...v, state: "adopt" as const } : v)) };
    expect(stopDialogState(both, THREE, { timeZone: TZ }).initial).toBe("c");
    const flipped = { ...both, variants: both.variants.map((v) => (v.id === "b" ? { ...v, probBest: 0.95 } : v.id === "c" ? { ...v, probBest: 0.04 } : v)) };
    expect(stopDialogState(flipped, THREE, { timeZone: TZ }).initial).toBe("b");
  });

  it("initial: 採用なし without an official verdict (interim), with a quality problem, or when no candidate", () => {
    expect(stopDialogState(load("interim"), EXP, { timeZone: TZ }).initial).toBeNull();
    expect(stopDialogState({ ...load("adopt"), quality: "blocked" }, EXP, { timeZone: TZ }).initial).toBeNull();
    expect(stopDialogState(load("insufficient"), EXP, { timeZone: TZ }).initial).toBeNull();
    expect(stopDialogState(null, EXP, { timeZone: TZ }).initial).toBeNull();
  });

  it("initial: a zero-weight pattern is never a candidate", () => {
    const r = load("adopt");
    const zero = { ...r, variants: r.variants.map((v) => (v.id === "b" ? { ...v, weight: 0 } : v)) };
    const s = stopDialogState(zero, EXP, { timeZone: TZ });
    expect(s.initial).toBeNull();
    expect(s.options[0]).toEqual({ variantId: "b", label: "B(CTA 文言) を採用", note: "配信していません" });
  });

  it("initial: the selection from the results banner wins (採用なしで終了 opens with 採用なし)", () => {
    expect(stopDialogState(load("adopt"), EXP, { timeZone: TZ, initialVariantId: null }).initial).toBeNull();
    expect(stopDialogState(load("insufficient"), EXP, { timeZone: TZ, initialVariantId: "b" }).initial).toBe("b");
    // 選択肢に無い ID は採用なし
    expect(stopDialogState(load("adopt"), EXP, { timeZone: TZ, initialVariantId: "zzz" }).initial).toBeNull();
  });

  it("「(基準)を採用」 only when the baseline has changes in the definition delivered just before stop", () => {
    const r = load("adopt");
    // 保存済みの基準に変更があっても、配信していた定義で変更が無ければ出さない
    const savedOnly = { ...EXP, variants: EXP.variants!.map((v) => (v.id === "a" ? { ...v, original: false, changes: [TEXT] } : v)) } as Experiment;
    expect(stopDialogState(r, savedOnly, { timeZone: TZ }).options.map((o) => o.variantId)).toEqual(["b", null]);
    // 配信していた定義で基準に変更があれば出す(保存済みの変更が無くても)
    const delivered = { ...r, deliveredChanges: { a: true, b: true } };
    expect(stopDialogState(delivered, EXP, { timeZone: TZ }).options).toEqual([
      { variantId: "a", label: "A(現行)(基準)を採用", note: "基準の変更を残す" },
      { variantId: "b", label: "B(CTA 文言) を採用", note: "採用候補・上回る確率 97.1%" },
      { variantId: null, label: "採用なし", note: "今のままにする。分かったことはメモに残す" },
    ]);
    // 配信を確かめた定義が無ければ保存済みの変更で判断する
    expect(stopDialogState({ ...r, deliveredChanges: null }, savedOnly, { timeZone: TZ }).options.map((o) => o.variantId)).toEqual(["a", "b", null]);
  });

  it("before the evaluation point: the early notice in the site timezone", () => {
    expect(stopDialogState(load("interim"), EXP, { timeZone: TZ }).earlyNotice).toBe("評価時点(10/15)の前です。この記録には「評価時点前に終了」と付きます。");
    expect(stopDialogState(load("interim"), EXP, { timeZone: "UTC" }).earlyNotice).toBe("評価時点(10/14)の前です。この記録には「評価時点前に終了」と付きます。");
    expect(stopDialogState(load("adopt"), EXP, { timeZone: TZ }).earlyNotice).toBeNull();
    // 結果を記録していないテストには出さない
    expect(stopDialogState(load("interim"), { ...EXP, runId: null } as Experiment, { timeZone: TZ }).earlyNotice).toBeNull();
  });

  it("a stale interim returned after the evaluation point (read refused, no record yet) is not 'before the evaluation point'", () => {
    const r = load("interim");
    const at = r.evaluation!.evaluationAt;
    expect(stopDialogState(r, EXP, { timeZone: TZ, now: at - 1 }).earlyNotice).toBe("評価時点(10/15)の前です。この記録には「評価時点前に終了」と付きます。");
    const after = stopDialogState({ ...r, notes: [...r.notes, { key: "interim_stale", params: { reason: "budget" } }] }, EXP, { timeZone: TZ, now: at + 1 });
    expect(after.earlyNotice).toBeNull();
    expect(after.lead).toBe("結果は評価時点の記録のまま変わりません。終了すると配信を止め、採用とメモを記録します。終了したテストは再開できません。");
    // 速報なので正の判定は無い = 採用なし
    expect(after.initial).toBeNull();
  });

  it("verdict hints follow the phase (interim / stopped early / quality)", () => {
    expect(verdictHint(load("interim"), "b")).toBe("速報・いまの上回る確率 92.3%");
    expect(verdictHint(load("early"), "b")).toBe("評価時点前に終了・上回る確率 93.0%");
    expect(verdictHint({ ...load("adopt"), quality: "blocked" }, "b")).toBe("判定不可(データ品質)・上回る確率 97.1%");
    expect(verdictHint(load("adopt"), "a")).toBe("基準");
    expect(verdictHint(null, "b")).toBeNull();
  });

  it("edited after the evaluation point / unpublished edits: shown for the selected adoption", () => {
    const r = { ...load("adopt"), notes: [{ key: "edited_after_evaluation", params: { variantId: "b" } }, { key: "unpublished_changes", params: { variantId: "b" } }] } as ResultsResponse;
    const s = stopDialogState(r, EXP, { timeZone: TZ });
    expect(s.editedAfterEvaluation).toEqual(["b"]);
    expect(s.unpublished).toEqual(["b"]);
    expect(selectionNotes(s, EXP, "b")).toEqual([
      "評価時点の後に B(CTA 文言) の変更が編集されています",
      "B(CTA 文言) に未公開の編集があります。テストで配信したのは編集の前の中身です。「B(CTA 文言) だけを表示」の複製は配信した中身で作ります",
    ]);
    expect(selectionNotes(s, EXP, null)).toEqual([]);
  });

  it("the lead says what the stop records", () => {
    expect(stopDialogState(load("interim"), EXP, { timeZone: TZ }).lead).toBe("終了の時点の数値と判定を固定して保存します。終了したテストは再開できません。");
    expect(stopDialogState(load("adopt"), EXP, { timeZone: TZ }).lead).toBe("結果は評価時点の記録のまま変わりません。終了すると配信を止め、採用とメモを記録します。終了したテストは再開できません。");
    expect(stopDialogState(null, { ...EXP, runId: null } as Experiment, { timeZone: TZ }).lead).toBe("このテストは結果を記録していないため、採用とメモだけを記録します。終了したテストは再開できません。");
  });

  it("adopt mode (after stop) starts from the recorded adoption", () => {
    const s = stopDialogState(load("adopted"), { ...EXP, status: "archived" } as Experiment, { timeZone: TZ, mode: "adopt" });
    expect(s.initial).toBe("b");
    expect(s.earlyNotice).toBeNull();
    const none = { ...load("adopted"), adoption: { variantId: null, note: "", decidedAt: 1, decidedBy: null } };
    expect(stopDialogState(none, { ...EXP, status: "archived" } as Experiment, { timeZone: TZ, mode: "adopt" }).initial).toBeNull();
  });
});

describe("stopDuplicateOption(設計書 §8.2 のチェック)", () => {
  it("採用なし: greyed out with the reason", () => {
    expect(stopDuplicateOption(EXP, null)).toEqual({
      enabled: false,
      label: "採用したパターンだけを表示する新しいエクスペリエンスも作成する",
      hint: "パターンを採用すると選べます。あとから見出しの「複製」でも作れます。",
    });
  });
  it("a pattern is adopted: selectable, and the stop is never undone", () => {
    expect(stopDuplicateOption(EXP, "b")).toEqual({
      enabled: true,
      label: "B(CTA 文言) だけを表示する新しいエクスペリエンスも作成する(下書き)",
      hint: "終了と記録が先に確定します。作成に失敗しても終了は取り消さず、見出しの「複製」から作り直せます。",
    });
  });
  it("an original pattern cannot be duplicated", () => {
    expect(stopDuplicateOption(EXP, "a").enabled).toBe(false);
  });
});

describe("submitStop / stopView(設計書 §8.2: 複製が失敗しても終了は取り消さない)", () => {
  const ok: StatusResult = { experiment: { ...EXP, status: "archived" } as Experiment, publish: { ok: true, version: 7, needsProfile: false, superseded: false, staticDeploy: "deployed", warnings: [] }, warnings: [], results: { recorded: true } };
  const input = { expectDigest: "a".repeat(64), siteId: "s", experimentId: "exp_buy", adoption: { variantId: "b", note: " メモ " }, duplicate: { variantId: "b", name: "購入ボタンの文言テスト(B(CTA 文言) だけを表示)" } };

  it("calls the status API with the adoption, then the duplicate API", async () => {
    const call = vi.fn(async (_m: string, p: string, _b?: unknown) => (p.endsWith("/status") ? ok : { id: "exp_buy-copy" }));
    const out = await submitStop(call, input);
    expect(call.mock.calls).toEqual([
      ["POST", "/sites/s/experiments/exp_buy/status", { status: "archived", expectDigest: "a".repeat(64), adoption: { variantId: "b", note: "メモ" } }],
      ["POST", "/sites/s/experiments/exp_buy/duplicate", { mode: "variant", variantId: "b", name: "購入ボタンの文言テスト(B(CTA 文言) だけを表示)" }],
    ]);
    expect(out.duplicate).toEqual({ kind: "created", id: "exp_buy-copy" });
    expect(stopView(out, "/w/w/sites/s/experiments")).toEqual({
      messages: [{ tone: "info", text: "終了しました。公開 v7 を反映しました(訪問者のブラウザには 1 分ほどで届きます)" }],
      created: "/w/w/sites/s/experiments/exp_buy-copy",
      navigate: true,
    });
  });

  it("stop_with_delivery_warning_holds_navigation", () => {
    const result = { ...ok, publish: { ok: true, version: 7, needsProfile: false, superseded: false, staticDeploy: "pending", warnings: [{ path: "delivery", message: "反映待ち" }] } } satisfies StatusResult;
    expect(stopView({ result, duplicate: { kind: "created", id: "copy" } }, "/experiments")).toEqual({
      messages: [{ tone: "warn", text: "公開は確定しました。配信への反映は遅れています(自動で反映します)" }],
      created: "/experiments/copy",
      navigate: false,
    });
  });

  it("a failed duplicate keeps the stop and shows the error (no other call)", async () => {
    const call = vi.fn(async (_m: string, p: string, _b?: unknown) => {
      if (p.endsWith("/status")) return ok;
      throw new Error("network down");
    });
    const out = await submitStop(call, { ...input, adoption: { variantId: "b", note: "" } });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]![2]).toEqual({ status: "archived", expectDigest: "a".repeat(64), adoption: { variantId: "b" } });
    expect(out.result).toBe(ok);
    expect(out.duplicate.kind).toBe("failed");
    const v = stopView(out, "/w/w/sites/s/experiments");
    expect(v.navigate).toBe(false);
    expect(v.created).toBeNull();
    expect(v.messages.at(-1)).toEqual({ tone: "error", text: "終了しました。下書きの作成に失敗しました(network down)。終了は取り消していません。見出しの「複製」から作り直せます" });
  });

  it("a failed status API throws (nothing is duplicated)", async () => {
    const call = vi.fn(async () => {
      throw new Error("409");
    });
    await expect(submitStop(call, input)).rejects.toThrow("409");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("results not recorded: says it will be recorded later and the adoption was not recorded; does not navigate away", async () => {
    const notRecorded = { ...ok, results: { recorded: false } };
    const call = vi.fn(async (_m: string, p: string, _b?: unknown) => (p.endsWith("/status") ? notRecorded : { id: "exp_buy-copy" }));
    const v = stopView(await submitStop(call, input), "/w/w/sites/s/experiments");
    expect(v.messages).toContainEqual({ tone: "warn", text: "結果を記録できませんでした。自動で記録し直します。採用は記録されていないので、結果のタブから記録し直してください" });
    expect(v.navigate).toBe(false);
    expect(v.created).toBe("/w/w/sites/s/experiments/exp_buy-copy");
  });

  it("publish failure and warnings are shown", async () => {
    const failed: StatusResult = { ...ok, publish: { ok: false, version: null, error: "publish_failed", message: "boom" }, warnings: [{ path: "variants.b.changes", message: "パターン「B」に未公開の編集があります" }] };
    const v = stopView(await submitStop(vi.fn(async () => failed), { ...input, duplicate: null }), "/w/w/sites/s/experiments");
    expect(v.messages).toEqual([
      { tone: "error", text: "状態は 終了 に変わりましたが、公開に失敗しました(publish_failed: boom)。上部の「公開」から再試行してください" },
      { tone: "warn", text: "パターン「B」に未公開の編集があります" },
    ]);
    expect(v.navigate).toBe(false);
  });
});

describe("adoptionListText(設計書 §8.1 の一覧の要約)", () => {
  type A = NonNullable<Experiment["adoption"]>;
  const withAdoption = (adoption: Experiment["adoption"], kind: "test" | "single" = "test") => ({ kind, adoption }) as Pick<Experiment, "kind" | "adoption">;
  const adopted = (over: Partial<A>): A => ({ variantId: "b", variantName: "B", baseline: false, decidedAt: 1, summary: null, ...over });
  const NULLS = { diffPoints: null, relative: null, probBeat: null, verdict: null };
  it("formats an adopted pattern with its name and the official record", () => {
    expect(adoptionListText(withAdoption(adopted({ summary: { diffPoints: 0.6, relative: 12.04, probBeat: 0.971, verdict: "adopt" } })))).toBe("採用: B(+0.60 ポイント・+12%、上回る確率 97.1%)");
    expect(adoptionListText(withAdoption(adopted({ summary: { diffPoints: -0.25, relative: null, probBeat: 0.2, verdict: "insufficient" } })))).toBe("採用: B(−0.25 ポイント、上回る確率 20.0%)");
  });
  it("baseline comes from the baseline flag, not from all-null values", () => {
    expect(adoptionListText(withAdoption(adopted({ variantId: "a", variantName: "A", baseline: true, summary: NULLS })))).toBe("採用: A(基準)");
    // 重み 0 のパターン(配信していない)を採用: 要約の値はすべて null だが基準ではない
    expect(adoptionListText(withAdoption(adopted({ variantId: "c", variantName: "C", baseline: false, summary: NULLS })))).toBe("採用: C");
  });
  it("falls back to the ID without a name; 採用なし / no record / not recorded / personalization", () => {
    expect(adoptionListText(withAdoption(adopted({ variantName: null })))).toBe("採用: b");
    expect(adoptionListText(withAdoption(adopted({})))).toBe("採用: B");
    expect(adoptionListText(withAdoption(adopted({ variantId: null, variantName: null })))).toBe("採用なし");
    expect(adoptionListText(withAdoption(null))).toBe("");
    expect(adoptionListText(withAdoption(undefined))).toBe("");
    expect(adoptionListText(withAdoption(adopted({}), "single"))).toBe("");
  });
});

describe("baselineOf(結果が無いときの既定の基準は重みが 0 より大きいパターンから)", () => {
  it("skips a zero-weight original", () => {
    const exp = { ...THREE, variants: THREE.variants!.map((v) => (v.id === "a" ? { ...v, weight: 0 } : v)) } as Experiment;
    expect(baselineOf(null, exp)).toBe("b");
    expect(baselineOf(null, THREE)).toBe("a");
    expect(baselineOf(load("adopt"), exp)).toBe("a");
  });
});

describe("capacityWarning(plan ③ K18: 80% で警告・95% で停止)", () => {
  it("nothing below 80% or before the first measurement", () => {
    expect(capacityWarning(undefined)).toBeNull();
    expect(capacityWarning(null)).toBeNull();
    expect(capacityWarning({ sizeBytes: 100e6, measuredAt: 1, level: "ok" })).toBeNull();
  });
  it("80%: a warning", () => {
    expect(capacityWarning({ sizeBytes: 412_345_678, measuredAt: 1, level: "warning" })).toEqual({
      level: "warning",
      text: "計測用のデータベースの使用量が上限の 80% 以上になりました(約 412 MB / 500 MB)。保持期間を短くするか、不要になったテストを削除してください",
    });
  });
  it("95%: recording is stopped", () => {
    expect(capacityWarning({ sizeBytes: 480e6, measuredAt: 1, level: "stopped" })).toEqual({
      level: "stopped",
      text: "計測用のデータベースの使用量が上限の 95% 以上になったため、参加と CV の記録を止めています(約 480 MB / 500 MB)。保持期間を短くするか、不要になったテストを削除してください。期限を過ぎた記録の削除は毎日 UTC 23 時台に行い、空きができれば記録を再開します",
    });
  });
});

it("stop stale publish closes confirmation and links to publishing", () => {
  const result = { experiment: { status: "archived" }, publish: { ok: false, version: 2, error: "stale_preview", message: "changed" }, warnings: [] } as unknown as StatusResult;
  const view = stopView({ result, duplicate: { kind: "none" } }, "/w/w/sites/s/experiments");
  expect(view.messages[0]).toMatchObject({ tone: "error", text: "状態は変わりましたが、確認の後に内容が変わったため公開していません", publishHref: "/w/w/sites/s/publish" });
  expect(view.navigate).toBe(false);
});
