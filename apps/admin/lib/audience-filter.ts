/**
 * オーディエンスの絞り込み(B59)。一覧の画面と、作成画面の「既存のオーディエンスから取り込む」で同じ規則を使う:
 * 名前・ID・条件の要約(summarizeDsl の文)のどれかに、検索語(前後の空白を除き、大文字・小文字を区別しない)が含まれる
 */
export function audienceMatches(a: { id: string; name: string }, summary: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q) || summary.toLowerCase().includes(q);
}
