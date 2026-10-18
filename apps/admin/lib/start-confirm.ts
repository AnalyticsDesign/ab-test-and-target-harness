import type { PublishPreview } from "./types";

/** 決定 51(設計書 §3.3・§10、plan ① K7): 下書きを開始するときの重なりの確認。重なりが無ければ確認しない */
export type Overlap = PublishPreview["overlaps"][number];
export type StartConfirm = { title: string; lead: string; items: { key: string; message: string }[]; confirmLabel: string };

/**
 * verb = 下書きの開始は「開始」、一時停止中の再開は「再開」(再開も配信に入り直すので優先が変わる。2026-10-06 ユーザー決定)。
 * zeroWeight = 保存済みのパターンのうち重み 0 のものの名前(B77 K20。パターン名をそのまま渡す)。開始の確認を 1 つにまとめ、モーダルを 2 回出さない。
 * 0% を知らせるのは下書きの開始だけ(開始後は重みを直せないため)なので、再開では呼び出し側が渡さない
 */
export function startConfirmFor(overlaps: Overlap[] | null | undefined, verb: "開始" | "再開" = "開始", zeroWeight: string[] = []): StartConfirm | null {
  const ov = overlaps ?? [];
  if (ov.length === 0 && zeroWeight.length === 0) return null;
  return {
    title: `${verb}しますか?`,
    lead: ov.length > 0 ? "同じ要素を変える配信中のエクスペリエンスがあります。" : "重み 0% のパターンがあります。",
    items: [
      ...ov.map((o) => ({ key: o.experimentIds.join("|"), message: o.message })),
      // 名前は重なり得るので位置も key に入れる
      ...zeroWeight.map((name, i) => ({ key: `zero-weight:${i}:${name}`, message: `${name} は重み 0% のため、誰にも表示されません` })),
    ],
    confirmLabel: `${verb}する`,
  };
}

/** 確認サマリの取得。失敗したら空(警告は開始を止めない) */
export async function loadStartOverlaps(fetchPreview: () => Promise<PublishPreview>): Promise<Overlap[]> {
  try {
    return (await fetchPreview()).overlaps ?? [];
  } catch {
    return [];
  }
}
