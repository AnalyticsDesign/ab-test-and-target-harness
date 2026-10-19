/**
 * D9 ③(plan ③ の Task 9、設計書 §6.7): 時刻の時(1 時間)の区切り。edge の ResultsHealth が失敗を数える時と同じ式
 * (apps/edge/src/results-health.ts の hourOf の写し。control は edge のコードを import しない)
 */
const HOUR_MS = 3_600_000;

/** ms を含む UTC の時の始まり(ms) */
export const hourOf = (ms: number): number => ms - (((ms % HOUR_MS) + HOUR_MS) % HOUR_MS);
