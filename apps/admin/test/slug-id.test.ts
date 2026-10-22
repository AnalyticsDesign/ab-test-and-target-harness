import { describe, expect, it } from "vitest";
import { audienceIdProblem } from "../lib/audience-id";
import { experimentIdProblem, slugIdProblem } from "../lib/slug-id";

// B37: エクスペリエンスの ID もオーディエンスと同じ規則(control の SLUG_RE と、新規作成の画面と重なる new の予約)
describe("slugIdProblem / experimentIdProblem (B37)", () => {
  it("new は使えない。new を含むだけの ID は使える", () => {
    expect(experimentIdProblem("new")).toBe("new は新規作成の画面と重なるので ID に使えません");
    expect(experimentIdProblem("new-hero")).toBeNull();
    expect(experimentIdProblem("exp_new")).toBeNull();
  });
  it("空・SLUG_RE に合わない ID は日本語で止める", () => {
    expect(experimentIdProblem("")).toBe("ID を入力してください");
    expect(experimentIdProblem("Exp_X")).toBe("ID は英小文字・数字で始まり、英小文字・数字・_・- のみ、64 文字以内で入力してください");
  });
  it("オーディエンスの検査と同じ規則を使う(constructor の予約はエクスペリエンスだけ)", () => {
    for (const id of ["new", "", "Exp_X", "aud_ok"]) expect(audienceIdProblem(id)).toBe(slugIdProblem(id));
    expect(audienceIdProblem("constructor")).toBeNull();
  });
});

// B136: 設置タグが配る設定を ID で引くので、constructor(Object.prototype の名前のうち SLUG_RE を通るもの)は使えない。control と同じ文言
describe("experimentIdProblem: constructor is reserved (B136)", () => {
  it("constructor は使えない。constructor を含むだけの ID は使える", () => {
    expect(experimentIdProblem("constructor")).toBe("constructor は JavaScript で特別な意味を持つ名前なので ID に使えません");
    expect(experimentIdProblem("constructor-copy")).toBeNull();
    expect(experimentIdProblem("new")).toBe("new は新規作成の画面と重なるので ID に使えません");
  });
});
