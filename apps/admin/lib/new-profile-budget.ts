/** サイトの設定の「新しい訪問者の記録の上限(1 日あたり)」の入力欄(control の newProfileBudgetPerDay)。空欄 = null = プランの既定 */

export const NEW_PROFILE_BUDGET_LABEL = "新しい訪問者の記録の上限(1 日あたり)";

/** 欄の補足の文。Free / Paid の既定値は control(core の NEW_PROFILE_BUDGET_DEFAULTS)と合わせる */
export const NEW_PROFILE_BUDGET_HINT =
  "履歴の条件を使うサイトで、1 日に新しく記録する訪問者の数の上限です。超えた訪問者にもテストは表示されますが、その訪問の記録は残りません。1 時間あたりはこの値の 10% までです。空欄にすると、使用状況の設定の Cloudflare のプランに合わせた既定値(Free 20,000 / Paid 200,000)を使います。Free では、全サイトの合計にも 1 日 20,000 件の上限があります";

/** 入力欄の文字列 → PATCH の値。空欄(空白だけも)は null、それ以外は数値(範囲と整数の検査は control が 422 で返し、欄の下に出る) */
export function budgetFromInput(raw: FormDataEntryValue | null): number | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text === "" ? null : Number(text);
}
