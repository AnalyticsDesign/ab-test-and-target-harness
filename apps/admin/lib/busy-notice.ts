import { describeError } from "./client";
import type { BusyOutcome } from "./run-busy";

/**
 * カード・一覧のカードの書き込みの結果を、範囲の中の 1 行(成功の文 = role="status" / 失敗の文 = ErrorBox)に変える(B173 第 2 段 Task 6)。
 * 目標・使用状況・メンバー・システム管理者・API キーの一覧で同じ決まりにそろえる:
 * - saved(読み直しの反映まで)→ 呼び出し元の成功の文(null = 文を出さない。結果は別の箱に出るもの = 招待・リセットリンクの発行)
 * - saved(読み直しが上限を超えた)→ 書き込みは成功のまま、成功の文の代わりに同じ位置へ再読み込みの案内(送り直さない)
 * - failed → describeError の文 / unknown(30 秒の上限)→ 保存できたか分からない旨(自動で送り直さない)
 * - discarded・cancelled・ignored・navigated → 何も出さない(null。今の表示を変えない)
 */

export const REFRESH_TIMEOUT = "保存しました。画面の表示が古い可能性があります。再読み込みしてください";
export const WRITE_UNKNOWN = "保存できたか分かりません。再読み込みして確かめてください";

export type BusyNotice = { status: string | null; error: string | null };

export const NO_NOTICE: BusyNotice = { status: null, error: null };

/** 結果から出す 1 行を決める。null = 何も出さない(呼び出し元は今の表示のままにする) */
export function noticeOf(outcome: BusyOutcome<unknown>, success: string | null): BusyNotice | null {
  switch (outcome.kind) {
    case "saved":
      if (outcome.refresh === "timeout") return { status: REFRESH_TIMEOUT, error: null };
      return success === null ? null : { status: success, error: null };
    case "failed":
      return { status: null, error: describeError(outcome.error) };
    case "unknown":
      return { status: null, error: WRITE_UNKNOWN };
    default:
      return null;
  }
}
