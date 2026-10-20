"use client";
import { useNow } from "@/components/LocalTime";
import { writeFreezeBannerText } from "@/lib/capabilities";
import type { WriteFreezeState } from "@/lib/types";

/**
 * backlog D13 / 決定 56 (5): 書き込みの凍結(メンテナンス中)のあいだ、認証済みの全ページに出す。閉じるボタンは置かない。
 * 保存ボタンは止めない(判定の正は control の 503。保存時は 503 の理由が既存のエラー表示に出る)。
 * 見込みを過ぎたかは今の時刻で決まるので、マウントの後に 1 分ごとに描き直す。
 * P17: 開いている画面にも出す・消すを切り替えるための /capabilities の取り直し(60 秒ごと・タブが前に戻ったとき・失敗したら直前の表示を保つ)は
 * useCapabilitiesPoll に移した(plan12 K6。版の帯と取得を共有する)。ここは親(CapabilitiesBanners)が渡した状態を描くだけ
 */
export function WriteFreezeBanner({ freeze }: { freeze: WriteFreezeState | null }) {
  const now = useNow(60_000);
  if (!freeze) return null;
  return (
    <div className="banner-warn banner-full" data-testid="write-freeze-banner" role="status">
      <span>{writeFreezeBannerText(freeze, now)}</span>
    </div>
  );
}
