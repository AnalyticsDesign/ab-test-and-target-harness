import { describe, expect, it } from "vitest";
import { draftOf, experimentPatchBody, type Draft } from "@/lib/experiment-draft";
import { defaultCond } from "@/lib/conditions";
import {
  ARCHIVED_TEST_MESSAGE,
  archivedTestBanner,
  audienceSaveNotice,
  goalSaveNotice,
  lockedFieldChanges,
  needsRunningTestConfirm,
  PERSIST_HINT,
  preSaveLockProblem,
  RUNNING_TEST_CONFIRM,
  testLockMessage,
  trafficError,
} from "@/lib/test-locks";
import type { Experiment, Status } from "@/lib/types";

const EXP = {
  id: "exp_a", siteId: "s", name: "Hero", kind: "test", status: "running", publishedStatus: "running", urlMatch: { include: [{ page: { op: "equals", value: "/" } }] }, targeting: null,
  trafficPercentage: 50, persistAssignment: false, analytics: null, createdBy: "u", updatedBy: "u", createdAt: 1, updatedAt: 2, unpublished: false, runId: "r1", description: "",
  variants: [
    { id: "a", name: "A", weight: 50, original: true, description: "", analytics: null, changes: [] },
    { id: "b", name: "B", weight: 50, original: false, description: "", analytics: null, changes: [{ id: "c1", type: "TEXT", selector: "h1", payload: { text: "x" } }] },
  ],
} as Experiment;
const at = (status: Status, kind: Experiment["kind"] = "test") => ({ ...EXP, status, kind });

describe("post-start edit locks for tests (D9 ③ Task 14、設計書 §5.5・§10)", () => {
  it("配信率を下げる入力のエラー文(実行中・一時停止中のテストだけ)", () => {
    const msg = "テストの開始後は配信率を下げられません。絞るときは一時停止か終了してください";
    expect(trafficError(at("running"), 40)).toBe(msg);
    expect(trafficError(at("paused"), 49)).toBe(msg);
    expect(trafficError(at("running"), 50)).toBeNull(); // 同じ値は変更ではない
    expect(trafficError(at("running"), 80)).toBeNull(); // 上げるのは可
    expect(trafficError(at("draft"), 10)).toBeNull();
    expect(trafficError(at("running", "single"), 10)).toBeNull(); // パーソナライズは今のまま
  });

  it("testLockMessage: 開始後の割当の固定・終了したテストの欄(メモは除く)", () => {
    expect(testLockMessage(at("running"), "persistAssignment")).toBe("テストの開始後は割当の固定を変えられません");
    expect(testLockMessage(at("paused"), "trafficPercentage")).toBe("テストの開始後は配信率を下げられません。絞るときは一時停止か終了してください");
    expect(testLockMessage(at("draft"), "persistAssignment")).toBeNull();
    expect(testLockMessage(at("running", "single"), "persistAssignment")).toBeNull();
    expect(testLockMessage(at("archived"), "urlMatch")).toBe(ARCHIVED_TEST_MESSAGE);
    expect(testLockMessage(at("archived"), "persistAssignment")).toBe(ARCHIVED_TEST_MESSAGE);
    expect(testLockMessage(at("archived"), "description")).toBeNull(); // メモは編集できる
    expect(testLockMessage(at("archived", "single"), "urlMatch")).toBeNull();
  });

  it("終了したテストの上部の文", () => {
    expect(ARCHIVED_TEST_MESSAGE).toBe("終了したテストは編集できません。変えるときは複製してください");
    expect(archivedTestBanner(at("archived"))).toBe("終了したテストは編集できません。変えるときは複製してください");
    expect(archivedTestBanner(at("running"))).toBeNull();
    expect(archivedTestBanner(at("archived", "single"))).toBeNull();
  });

  it("割当の固定の説明(設計書 §10): off でも同じパターン、on が効くのは配信率を下げたときだけ、テストは開始後に変えられない、サイト全体で往復", () => {
    expect(PERSIST_HINT).toContain("オフでも、同じ訪問者には毎回同じパターンを表示します");
    expect(PERSIST_HINT).toContain("後から配信率を下げたとき");
    expect(PERSIST_HINT).toContain("テストは開始後に配信率を下げられず、この設定も変えられない");
    expect(PERSIST_HINT).toContain("サイト全体で");
    expect(PERSIST_HINT).not.toMatch(/\bSite\b/);
  });
});

describe("save confirmation for running tests (設計書 §5.5)", () => {
  it("lockedFieldChanges: Change・対象 URL・配信条件の変更だけを拾う(名前・配信率・メモは拾わない)", () => {
    const initial = draftOf(EXP);
    expect(lockedFieldChanges(initial, { ...initial, name: "Hero 2", traffic: 80, description: "メモ" })).toEqual([]);
    expect(lockedFieldChanges(initial, { ...initial, urlMatch: { include: [{ page: { op: "equals", value: "/lp" } }] } })).toEqual(["urlMatch"]);
    expect(lockedFieldChanges(initial, { ...initial, targeting: { kind: "form", form: { logic: "and", rows: [{ id: "r1", kind: "cond", type: "device", neg: false, values: ["mobile"] }] } } })).toEqual(["targeting"]);
    const changed = { ...initial, variants: initial.variants.map((v) => (v.id === "b" ? { ...v, changes: [] } : v)) };
    expect(lockedFieldChanges(initial, changed)).toEqual(["changes"]);
  });

  it("needsRunningTestConfirm: 実行中・一時停止中のテストで、Change・対象 URL・配信条件を変えたときだけ", () => {
    expect(needsRunningTestConfirm(at("running"), ["changes"])).toBe(true);
    expect(needsRunningTestConfirm(at("paused"), ["targeting"])).toBe(true);
    expect(needsRunningTestConfirm(at("running"), [])).toBe(false);
    expect(needsRunningTestConfirm(at("draft"), ["changes"])).toBe(false);
    expect(needsRunningTestConfirm(at("running", "single"), ["urlMatch"])).toBe(false);
    expect(RUNNING_TEST_CONFIRM).toBe("実行中のテストを変更します。変更は結果に記録されます。大きく変えるなら複製して新しいテストにしてください");
  });

  it("goalSaveNotice: 参照している実行中・一時停止中のテストの件数を添える(目標名の変更も対象。0 件なら確認しない)", () => {
    expect(goalSaveNotice([])).toBeNull();
    expect(goalSaveNotice([{ id: "t1", name: "T1" }, { id: "t2", name: "T2" }])).toBe(
      "この目標を使っている実行中・一時停止中のテストが 2 件あります(T1、T2)。変更は次の公開でこれらのテストに効き、結果に記録されます。大きく変えるなら複製して新しいテストにしてください",
    );
  });

  it("audienceSaveNotice: 使っている実行中・一時停止中のエクスペリエンスの件数を添える", () => {
    expect(audienceSaveNotice([{ id: "x", name: "X", status: "draft" }, { id: "y", name: "Y", status: "archived" }])).toBeNull();
    expect(audienceSaveNotice([{ id: "x", name: "X", status: "running" }])).toBe(
      "次の公開で、実行中のエクスペリエンス 1 件の配信対象が変わります。テストでは、変更が結果に記録されます。大きく変えるなら複製して新しいテストにしてください。保存しますか?",
    );
    expect(audienceSaveNotice([{ id: "x", name: "X", status: "running" }, { id: "y", name: "Y", status: "paused" }])).toBe(
      "次の公開で、実行中のエクスペリエンス 1 件と一時停止中のエクスペリエンス 1 件の配信対象が変わります。テストでは、変更が結果に記録されます。大きく変えるなら複製して新しいテストにしてください。保存しますか?",
    );
    expect(audienceSaveNotice([{ id: "y", name: "Y", status: "paused" }])).toBe(
      "次の公開で、一時停止中のエクスペリエンス 1 件の配信対象が変わります。テストでは、変更が結果に記録されます。大きく変えるなら複製して新しいテストにしてください。保存しますか?",
    );
  });
});

// 最終レビュー FR-Medium-1: 保存の前の確かめは、実際に送る PATCH(experimentPatchBody)に載る欄だけを見る。
// 画面を開いた後にほかの人が配信率を上げた値が届いても(サーバー 75・基準と下書き 50)、名前だけの保存を「下げられません」で止めない
describe("preSaveLockProblem (B173 stage 1 final review FR-Medium-1)", () => {
  const running75 = { ...at("running"), trafficPercentage: 75 };
  const base = draftOf(EXP); // 開いたときの値(配信率 50)
  const withRow = (d: Draft): Draft => {
    if (d.targeting.kind !== "form") throw new Error("form expected");
    return { ...d, targeting: { kind: "form", form: { ...d.targeting.form, rows: [defaultCond("referrer", {}, "row1")] } } };
  };

  it("does not check the traffic when the PATCH does not send trafficPercentage", () => {
    const draft = { ...base, name: "renamed" };
    const patch = experimentPatchBody(base, draft);
    expect(patch).toEqual({ name: "renamed" });
    expect(preSaveLockProblem(running75, patch, draft, 30)).toBeNull();
  });

  it("checks the traffic when the PATCH sends trafficPercentage", () => {
    const draft = { ...base, traffic: 60 };
    expect(preSaveLockProblem(running75, experimentPatchBody(base, draft), draft, 30)).toBe("テストの開始後は配信率を下げられません。絞るときは一時停止か終了してください");
    const up = { ...base, traffic: 80 };
    expect(preSaveLockProblem(running75, experimentPatchBody(base, up), up, 30)).toBeNull();
  });

  it("checks the target URL rows only when the PATCH sends urlMatch (B69 spec §7.2)", () => {
    const empty = { ...base, urlMatch: { include: [base.urlMatch.include[0]!, { page: { part: "path" as const, op: "startsWith", value: "" } }] } };
    expect(preSaveLockProblem(at("draft"), experimentPatchBody(base, empty), empty, 30)).toBe("対象 URL(含める 2 行目): 値を入力してください");
    const renamed = { ...empty, name: "renamed" };
    expect(preSaveLockProblem(at("draft"), experimentPatchBody(empty, renamed), renamed, 30)).toBeNull();
  });

  it("checks the targeting rows only when the PATCH sends targeting", () => {
    // 保存済みの配信条件に入力漏れがあっても、配信条件を送らない保存は止めない
    const savedRow = withRow(base);
    const renamed = { ...savedRow, name: "renamed" };
    expect(preSaveLockProblem(at("draft"), experimentPatchBody(savedRow, renamed), renamed, 30)).toBeNull();
    // 画面で足した入力漏れの行は、配信条件を送るので止める
    const added = withRow(base);
    expect(preSaveLockProblem(at("draft"), experimentPatchBody(base, added), added, 30)).toBe("「リファラー」の条件: 値を入力してください");
  });
});
