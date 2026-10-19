import type { Experiment, ResultsCapacity } from "./types";

/**
 * Site の設定「結果を記録する」まわりの純関数(D9 ②)。画面の文言はここに集める(テストで固定する)
 */

/**
 * 切り替えの確認の本文。確認が要らなければ null。
 * - 有効にする: 実行中のテスト(結果の記録の対象外 = 開始のときに run が振られていない)があれば、その件数を知らせる
 * - 無効にする: 記録中のテスト(runId を持つ running / paused)があれば、記録が止まる件数と判定への影響を知らせる
 */
export function resultsToggleNotice(input: { enabling: boolean; runningTests: number; runningRecordedTests: number }): string | null {
  if (input.enabling) {
    return input.runningTests > 0 ? `実行中の ${input.runningTests} 件のテストは対象になりません。結果を見たいテストは、複製して開始し直してください` : null;
  }
  return input.runningRecordedTests > 0
    ? `記録中の ${input.runningRecordedTests} 件のテストの記録が止まります。止めた時間が上限(評価時点までの期間の 5%。CV の多いテストほど短い)を超えると、判定できなくなります`
    : null;
}

/** URL またはホスト名から、比較用のホスト(小文字・ポートなし)を取り出す。取れなければ null */
function hostOf(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * 結果の送信先(edge)の案内。文中のバッククォートで囲んだ部分は、画面で <code> にする(splitCode)。
 * - Mode B(サーバー発行 Cookie): runtime は同じホストの `/__ab/event` に送る。`/__ab/*` の Route が edge に向いていることの確認
 *   (edge の origin が別でも、ブラウザからは同じオリジンへの送信なので connect-src は関係しない)
 * - Mode A で送信先 = edge の origin(未設定なら設置タグの origin)がサイトと同じホスト(Route 構成): `/v1/*` の Route の確認
 * - Mode A で別のホスト: サイトの CSP の `connect-src` に足す案内(足さないと送信が届かない)
 * 送信先が分からないとき(どちらも未設定)は、アドレスを添えずに connect-src の案内を返す
 */
export function cspNotice(input: { mode: "A" | "B"; edgeOrigin: string | null; tagOrigin: string | null; siteDomain: string }): string {
  if (input.mode === "B") return "結果は同じホストの `/__ab/event` に送ります。`/__ab/*` の Route が edge に向いていることを確かめてください";
  const origin = input.edgeOrigin ?? input.tagOrigin;
  const edgeHost = origin ? hostOf(origin) : null;
  if (edgeHost !== null && edgeHost === hostOf(input.siteDomain)) return "`/v1/*` の Route が edge に向いていることを確かめてください";
  const where = origin ? `(${origin})` : "";
  return `サイトの CSP の \`connect-src\` に edge のアドレス${where}を足してください。足さないと送信が届かず、ツール側でも失敗を数えられません`;
}

/** 案内の文を、バッククォートで囲んだ部分(code)とそれ以外に分ける。空の部分は捨てる */
export function splitCode(text: string): Array<{ code: boolean; text: string }> {
  return text
    .split("`")
    .map((part, i) => ({ code: i % 2 === 1, text: part }))
    .filter((p) => p.text !== "");
}

/** エクスペリエンスの一覧から、確認の文に使う 2 つの件数を数える(テストだけが対象。single は数えない) */
export function countExperimentsForResults(list: Experiment[]): { runningTests: number; runningRecordedTests: number } {
  const tests = list.filter((e) => e.kind === "test");
  return {
    // 有効にしても記録されない実行中のテスト(開始のときに run が振られていない)。runId を返さない古い応答も含める
    runningTests: tests.filter((e) => e.status === "running" && e.runId == null).length,
    runningRecordedTests: tests.filter((e) => e.runId != null && (e.status === "running" || e.status === "paused")).length,
  };
}

/** 計測用のデータベース(wtt-results)の上限(D1 の 1 つのデータベースの上限。Free) */
const RESULTS_STORE_LIMIT_MB = 500;

/**
 * Site の設定の容量の警告(D9 ③、plan ③ K18)。control の Cron が測った値の level で決める: warning = 80% 以上、
 * stopped = 95% 以上(参加と CV の記録を止めている)。測る前(値が無い)と ok は null(何も出さない)。
 * 測った時刻は画面がサイトのタイムゾーンで添える
 */
export function capacityWarning(cap: ResultsCapacity | null | undefined): { level: "warning" | "stopped"; text: string } | null {
  if (!cap || cap.level === "ok") return null;
  const size = `約 ${Math.floor(cap.sizeBytes / 1e6)} MB / ${RESULTS_STORE_LIMIT_MB} MB`;
  const fix = "保持期間を短くするか、不要になったテストを削除してください";
  if (cap.level === "warning") return { level: "warning", text: `計測用のデータベースの使用量が上限の 80% 以上になりました(${size})。${fix}` };
  return {
    level: "stopped",
    text: `計測用のデータベースの使用量が上限の 95% 以上になったため、参加と CV の記録を止めています(${size})。${fix}。期限を過ぎた記録の削除は毎日 UTC 23 時台に行い、空きができれば記録を再開します`,
  };
}
