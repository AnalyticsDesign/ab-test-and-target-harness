import type { PublishPreview } from "./types";

/** 決定 51(設計書 §3.3・§10、plan ① K7): 下書きを開始するときの重なりの確認。重なりが無ければ確認しない */
export type Overlap = PublishPreview["overlaps"][number];
export type StartConfirm = { title: string; lead: string; items: { key: string; message: string }[]; confirmLabel: string };

/** verb = 下書きの開始は「開始」、一時停止中の再開は「再開」(再開も配信に入り直すので優先が変わる。2026-10-06 ユーザー決定) */
export function startConfirmFor(overlaps: Overlap[] | null | undefined, verb: "開始" | "再開" = "開始"): StartConfirm | null {
  if (!overlaps || overlaps.length === 0) return null;
  return { title: `${verb}しますか?`, lead: "同じ要素を変える配信中のエクスペリエンスがあります。", items: overlaps.map((o) => ({ key: o.experimentIds.join("|"), message: o.message })), confirmLabel: `${verb}する` };
}

/** 確認サマリの取得。失敗したら空(警告は開始を止めない) */
export async function loadStartOverlaps(fetchPreview: () => Promise<PublishPreview>): Promise<Overlap[]> {
  try {
    return (await fetchPreview()).overlaps ?? [];
  } catch {
    return [];
  }
}
