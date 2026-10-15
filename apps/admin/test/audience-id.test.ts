import { describe, expect, it } from "vitest";
import { audienceIdCandidate, audienceIdProblem } from "../lib/audience-id";

describe("オーディエンス ID の候補(plan ② P7)", () => {
  const rnd = () => "k3x9qa";
  it("名前の ASCII の英数字から aud_<スラッグ>。全角の英数字は半角にする", () => {
    expect(audienceIdCandidate("Pricing Visitors", [], rnd)).toBe("aud_pricing_visitors");
    expect(audienceIdCandidate("料金 LP 2024", [], rnd)).toBe("aud_lp_2024");
    expect(audienceIdCandidate("ＬＰ閲覧", [], rnd)).toBe("aud_lp");
  });
  it("英数字が無ければ aud_ + 乱数", () => {
    expect(audienceIdCandidate("料金ページ閲覧・資料請求前", [], rnd)).toBe("aud_k3x9qa");
  });
  it("使われていれば _2, _3 … を足す。全体は 64 字以内(SLUG の規則)", () => {
    expect(audienceIdCandidate("Pricing", ["aud_pricing"], rnd)).toBe("aud_pricing_2");
    expect(audienceIdCandidate("Pricing", ["aud_pricing", "aud_pricing_2"], rnd)).toBe("aud_pricing_3");
    const long = audienceIdCandidate("a".repeat(100), ["aud_" + "a".repeat(54)], rnd);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  });
  it("ID の欄に new を入れると保存の前に止める(新規作成の画面 /audiences/new と重なる。plan ② P19)", () => {
    expect(audienceIdProblem("new")).toBe("new は新規作成の画面と重なるので ID に使えません");
    expect(audienceIdProblem("aud_new")).toBeNull();
    expect(audienceIdProblem("news")).toBeNull();
  });
  it("空の ID と control の SLUG_RE に合わない ID は保存の前に日本語で止める(control の 422 に任せない)", () => {
    expect(audienceIdProblem("")).toBe("ID を入力してください");
    const slug = "ID は英小文字・数字で始まり、英小文字・数字・_・- のみ、64 文字以内で入力してください";
    expect(audienceIdProblem("Aud_X")).toBe(slug); // 大文字
    expect(audienceIdProblem("_aud")).toBe(slug); // 記号で始まる
    expect(audienceIdProblem("aud x")).toBe(slug); // 空白
    expect(audienceIdProblem("料金")).toBe(slug);
    expect(audienceIdProblem("a".repeat(65))).toBe(slug);
    expect(audienceIdProblem("a".repeat(64))).toBeNull();
    expect(audienceIdProblem("aud_pricing-2")).toBeNull();
  });
});
