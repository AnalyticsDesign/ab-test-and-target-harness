import { describe, expect, it } from "vitest";
import { ApiClientError } from "../lib/client";
import { saveErrorMessage } from "../lib/experiment-save";

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
  it("partly saved and 426 client_too_old: tell to reload and that unsaved input is lost, not 'save again later'", () => {
    const tooOld = new ApiClientError(426, "client_too_old", { message: "管理画面が古い版です", hint: "管理画面ならページを再読み込みしてください" });
    const text = saveErrorMessage(tooOld, true);
    expect(text).toContain("管理画面が古い版です");
    expect(text).toContain("一部は保存されています");
    expect(text).toContain("再読み込み");
    expect(text).toContain("未保存の入力は消えます");
    expect(text).not.toContain("もう一度保存すると");
    expect(text).not.toContain("入力はそのまま残っています");
    // 何も保存されていない 426 は封筒のまま
    expect(saveErrorMessage(tooOld, false)).toBe("管理画面が古い版です 管理画面ならページを再読み込みしてください");
  });
});
