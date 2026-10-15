/**
 * 時刻の表示の書式(backlog B44)。見ている人のタイムゾーンで描くため、描画は components/LocalTime.tsx が
 * マウントの後にだけ呼ぶ(サーバー = Workers は UTC なので、サーバーの描画で呼ぶとハイドレーションで食い違う)。
 * timeZone はテスト用(省略 = 実行環境のタイムゾーン)
 */
export type LocalTimeKind = "datetime" | "date" | "deadline" | "time";

export function formatLocalTime(at: number, kind: LocalTimeKind, timeZone?: string): string {
  const d = new Date(at);
  if (kind === "time") return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone }); // 例: 「09:00」
  if (kind === "date") return d.toLocaleDateString("ja-JP", { timeZone });
  if (kind === "deadline") return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone }); // 例: 「10/12 22:05」
  return d.toLocaleString("ja-JP", { timeZone });
}
