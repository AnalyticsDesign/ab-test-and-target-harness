"use client";
import { useEffect, useState } from "react";
import { useNow } from "@/components/LocalTime";
import { nextWriteFreeze, writeFreezeBannerText } from "@/lib/capabilities";
import { api } from "@/lib/client";
import type { WriteFreezeState } from "@/lib/types";

/**
 * backlog D13 / 決定 56 (5): 書き込みの凍結(メンテナンス中)のあいだ、認証済みの全ページに出す。閉じるボタンは置かない。
 * 保存ボタンは止めない(判定の正は control の 503。保存時は 503 の理由が既存のエラー表示に出る)。
 * 見込みを過ぎたかは今の時刻で決まるので、マウントの後に 1 分ごとに描き直す。
 * P17: 共有 layout は router.refresh() やクライアント遷移では描き直されないので、初期値(サーバーが読んだ状態)の後は
 * 60 秒ごと(タブが隠れている間は取り直さない。Worker への要求を使わないため)と、タブが前に戻ったときに /capabilities を取り直して
 * 出す・消すを切り替える。画面は描き直さない(未保存の入力を消さない)。
 * 取り直しに失敗したら直前の表示を保つ(nextWriteFreeze)
 */
export function WriteFreezeBanner({ initial }: { initial: WriteFreezeState | null }) {
  const [freeze, setFreeze] = useState(initial);
  const now = useNow(60_000);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      api("GET", "/capabilities")
        .catch(() => null)
        .then((data) => {
          if (alive) setFreeze((prev) => nextWriteFreeze(prev, data));
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    // 隠れたタブでは見送る(戻ったときは下の visibilitychange で取り直す)
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  if (!freeze) return null;
  return (
    <div className="banner-warn banner-full" data-testid="write-freeze-banner" role="status">
      <span>{writeFreezeBannerText(freeze, now)}</span>
    </div>
  );
}
