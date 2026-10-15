import { ApiClientError, describeError } from "./client";

/**
 * エクスペリエンスの保存(概要 → パターン → パターンごとの変更の 3 段)が失敗したときの文。
 * 一部を保存した後に断られたときは、通常は再読み込みで最新の状態を見てもらう。
 * backlog D13 / 決定 56 (5): 凍結(503 write_frozen)で断られたときは再読み込みさせない(まだ保存されていない入力が消える)。
 * 保存は毎回全体を上書きするので、凍結が外れてから押し直せば残りもそろう
 */
export function saveErrorMessage(e: unknown, savedSomething: boolean): string {
  const text = describeError(e);
  if (!savedSomething) return text;
  if (e instanceof ApiClientError && e.code === "write_frozen") {
    return `${text}(一部は保存されています。入力はそのまま残っています。メンテナンスが終わってからもう一度保存すると、残りも保存されます)`;
  }
  return `${text}(一部は保存されています。最新の状態を確認するにはこの画面を再読み込みしてください)`;
}
