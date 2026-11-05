import { ApiClientError, describeError } from "./client";
import type { BusyOutcome } from "./run-busy";

/**
 * エクスペリエンスの保存(概要 → パターン → パターンごとの変更の 3 段)が失敗したときの文。
 * 一部を保存した後に断られたときは、通常は再読み込みで最新の状態を見てもらう。
 * backlog D13 / 決定 56 (5): 凍結(503 write_frozen)で断られたときは再読み込みさせない(まだ保存されていない入力が消える)。
 * 保存は毎回全体を上書きするので、凍結が外れてから押し直せば残りもそろう。
 * plan12 K5 / K6: 古い管理画面で 426 client_too_old に当たったときは逆に、押し直しても同じなので再読み込みを案内する(まだ保存されていない入力は消える)。
 * 426 の hint には再読み込みの案内と API を直接呼ぶクライアント向けの文が入っているので、hint は使わず message に案内を 1 回だけ足す
 */
export function saveErrorMessage(e: unknown, savedSomething: boolean): string {
  const text = describeError(e);
  if (!savedSomething) return text;
  if (e instanceof ApiClientError && e.code === "write_frozen") {
    return `${text}(一部は保存されています。入力はそのまま残っています。メンテナンスが終わってからもう一度保存すると、残りも保存されます)`;
  }
  if (e instanceof ApiClientError && e.code === "client_too_old") {
    const message = e.extra.message || "管理画面が古い版です";
    return `${message}(一部は保存されています。ページを再読み込みしてください。未保存の入力は消えます)`;
  }
  return `${text}(一部は保存されています。最新の状態を確認するにはこの画面を再読み込みしてください)`;
}

/**
 * B129 final review: 保存の結果のうち、変更履歴のタブを読み直すもの(全段の成功は onWritten が読み直しの印を進めるので含めない)。
 * - failed で savedSomething: 途中の段まで書けた(その段の記録が増えている)
 * - unknown: 30 秒待っても結果が分からない(書けていれば記録が増えている)
 * 何も書かずに失敗した・取りやめた・別の画面へ移り始めた・実行中だったときは読み直さない(タブの読み直しは開いている間だけの 1 本)。
 * navigated(書けた後に移動が始まった)は全段の成功と同じく onWritten が進める
 */
export function historyStaleAfterSave(outcome: { kind: BusyOutcome<unknown>["kind"] }, savedSomething: boolean): boolean {
  return outcome.kind === "unknown" || (outcome.kind === "failed" && savedSomething);
}
