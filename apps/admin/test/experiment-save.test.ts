import { describe, expect, it } from "vitest";
import { ApiClientError } from "../lib/client";
import { historyStaleAfterSave, saveErrorMessage, saveSuccessNotice } from "../lib/experiment-save";

// backlog D13 / 決定 56 (5): エクスペリエンスの保存は 3 段の要求。凍結で途中から断られたら「再読み込み」ではなく「もう一度保存」を案内する
// (再読み込みすると、まだ保存されていない入力が消える)
describe("saveErrorMessage", () => {
  const frozen = new ApiClientError(503, "write_frozen", { message: "メンテナンス中のため、変更を保存できません", hint: "理由: r。メンテナンスが終わってから、もう一度実行してください" });
  const other = new ApiClientError(422, "validation_failed", { message: "入力の検証に失敗しました" });

  it("nothing saved yet: the envelope as is", () => {
    expect(saveErrorMessage(frozen, false)).toBe("メンテナンス中のため、変更を保存できません 理由: r。メンテナンスが終わってから、もう一度実行してください");
    expect(saveErrorMessage(other, false)).toBe("入力の検証に失敗しました");
  });

  it("partly saved and frozen: keep the input and save again later", () => {
    expect(saveErrorMessage(frozen, true)).toBe(
      "メンテナンス中のため、変更を保存できません 理由: r。メンテナンスが終わってから、もう一度実行してください(一部は保存されています。入力はそのまま残っています。メンテナンスが終わってからもう一度保存すると、残りも保存されます)",
    );
  });

  it("partly saved for another reason: the existing reload advice", () => {
    expect(saveErrorMessage(other, true)).toBe("入力の検証に失敗しました(一部は保存されています。最新の状態を確認するにはこの画面を再読み込みしてください)");
  });

  // plan12 K5 / K6: 古い管理画面は 3 段の保存の途中で 426 になり得る。凍結と逆に、再読み込みを案内する(入力は消える)
  // hint は control の CLIENT_TOO_OLD_HINT(apps/control/src/client-version.ts)と同じ文。本物の hint で、案内が重ならないことを確かめる
  const realHint =
    "管理画面ならページを再読み込みしてください(未保存の入力は消えるので、必要なら控えてから)。API を直接呼ぶクライアントは /openapi.json を読み直してから再試行してください";
  const tooOld = new ApiClientError(426, "client_too_old", { message: "管理画面が古い版です", hint: realHint });
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("partly saved and 426 client_too_old: tell to reload and that unsaved input is lost, not 'save again later'", () => {
    const text = saveErrorMessage(tooOld, true);
    expect(text).toContain("管理画面が古い版です");
    expect(text).toContain("一部は保存されています");
    expect(text).toContain("再読み込み");
    expect(text).toContain("未保存の入力は消えます");
    expect(text).not.toContain("もう一度保存すると");
    expect(text).not.toContain("入力はそのまま残っています");
    expect(text).not.toContain("メンテナンス");
  });

  // 最終レビュー: 封筒の hint(再読み込みの案内と API クライアント向けの文)に同じ案内を足して二重にしない
  it("partly saved and 426: one reload advice, without the sentence for API clients", () => {
    const text = saveErrorMessage(tooOld, true);
    expect(count(text, "再読み込み")).toBe(1);
    expect(count(text, "未保存の入力は消え")).toBe(1);
    expect(text).not.toContain("API を直接呼ぶクライアント");
    expect(text).not.toContain("/openapi.json");
    // 何も保存されていない 426 は封筒のまま(ほかの画面のエラーと同じ出し方)
    expect(saveErrorMessage(tooOld, false)).toBe(`管理画面が古い版です ${realHint}`);
  });
});

// B129 final review: 変更履歴のタブの読み直し。全段の成功(onWritten)のほかに、途中の段まで書けて失敗したときと、書けたか分からないときも
// 記録が増えている(かもしれない)ので読み直す。何も書かずに失敗した・取りやめた・別の画面へ移り始めたときは読み直さない
describe("historyStaleAfterSave", () => {
  it("history_reloads_after_partial_save_or_unknown", () => {
    expect(historyStaleAfterSave({ kind: "failed" }, true)).toBe(true);
    expect(historyStaleAfterSave({ kind: "unknown" }, false)).toBe(true);
    expect(historyStaleAfterSave({ kind: "unknown" }, true)).toBe(true);
    expect(historyStaleAfterSave({ kind: "failed" }, false)).toBe(false);
    // 成功は onWritten が進める(ここでは二重に進めない)
    for (const kind of ["saved", "navigated", "cancelled", "discarded", "ignored"] as const) expect(historyStaleAfterSave({ kind }, true), kind).toBe(false);
  });
});

// 配信の保存をメモ・評価計画の保存と取り違えて、公開が必要/不要な案内を逆にしない。
describe("saveSuccessNotice", () => {
  const memo = { patchExperiment: false, experimentMemo: true, putVariants: false, variantMemos: [], putChanges: [], putPlan: false };
  it("delivery edits require publication, including changes-only and variant-set saves", () => {
    for (const step of [{ patchExperiment: true }, { putVariants: true }, { putChanges: ["b"] }]) {
      const notice = saveSuccessNotice({ ...memo, ...step });
      expect(notice.needsPublish).toBe(true);
      expect(notice.message).toContain("訪問者への反映にはサイトの公開が必要です");
    }
  });
  it("memo-only and plan-only saves do not ask for publication", () => {
    expect(saveSuccessNotice(memo)).toEqual({ message: "保存しました", needsPublish: false });
    expect(saveSuccessNotice({ ...memo, experimentMemo: false, putPlan: true })).toEqual({ message: "保存しました。評価計画は反映済みです", needsPublish: false });
  });
  it("mixed delivery and plan saves explain both reflection paths", () => {
    const notice = saveSuccessNotice({ ...memo, patchExperiment: true, putPlan: true });
    expect(notice.needsPublish).toBe(true);
    expect(notice.message).toContain("サイトの公開が必要です");
    expect(notice.message).toContain("評価計画は反映済みです");
  });
});
