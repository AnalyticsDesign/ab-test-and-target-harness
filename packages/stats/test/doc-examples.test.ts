import { describe, expect, test } from "vitest";
import { betaInterval, diffSummary, sampleSize } from "../src/index";

// 公開文書 docs/experiment-results.md に載せた例の値(B104・B109)。計算を変えて値が変わったら、文書の例も直す

/** 割合(0〜1)を、文書と同じ小数 2 桁の % の値にする */
const pct2 = (x: number) => Number((x * 100).toFixed(2));

describe("公開文書の例の値", () => {
  test("「CVR と区間」: 1 人中 0 人の区間は 1.26〜84.19%、1,000 人中 0 人の区間は 0.00〜0.37%", () => {
    expect(betaInterval(1, 0).map(pct2)).toEqual([1.26, 84.19]);
    expect(betaInterval(1000, 0).map(pct2)).toEqual([0, 0.37]);
  });

  test("「CVR と区間」: CV が 0 件の区間の下端は、約 500 人を超えると小数 2 桁の表示で 0.00% になる", () => {
    expect(pct2(betaInterval(300, 0)[0])).toBe(0.01);
    expect(pct2(betaInterval(510, 0)[0])).toBe(0);
  });

  test("「基準との差と区間」: 基準 2 人中 1 人・B 1 人中 0 人の差は −16.67 ポイント", () => {
    expect(Number(diffSummary({ n: 2, y: 1 }, { n: 1, y: 0 }, 0, null).mean.toFixed(2))).toBe(-16.67);
  });

  test("6.7「必要な人数の目安」: CVR 5% で +1 ポイント 8,158 人・+0.5 ポイント 31,234 人・3 パターンで +1 ポイント 9,880 人、CVR 0.1% で +1 ポイント 936 人", () => {
    expect(sampleSize(0.05, 1, 1, 95)).toBe(8158);
    expect(sampleSize(0.05, 0.5, 1, 95)).toBe(31234);
    expect(sampleSize(0.05, 1, 2, 95)).toBe(9880);
    expect(sampleSize(0.001, 1, 1, 95)).toBe(936);
  });
});
