"use client";
import { useEffect, useRef, useState } from "react";
import { replaceParam } from "@/lib/url-state";
import { ErrorBox } from "../ErrorBox";

/**
 * B108: 複製の「下書きを作成」の後に移った先で、作成したことを知らせる(移った先の見た目が元とほぼ同じで、反応が無いように見えるため)。
 * 印は URL の ?duplicated=1(複製の画面が付ける)。出した後に URL から消し、再読み込みで出し直さない。閉じるまで残す(決まり 5.3)。
 * 移った直後の描画では role="status" が読み上げられないことが多いので、帯にフォーカスを移す(決まり 5.3「出したらフォーカスを移す」)。
 * analyticsFailed = 外部計測の名前を直す 2 回目の要求が失敗した(B103。複製はできているので、カードで直してもらう)。帯を閉じても残す
 */
export function DuplicatedNotice({ analyticsFailed }: { analyticsFailed: boolean }) {
  const [open, setOpen] = useState(true);
  const banner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    replaceParam("duplicated", null);
    replaceParam("analyticsFailed", null);
    banner.current?.focus();
  }, []);
  return (
    <>
      {open ? (
        <div ref={banner} tabIndex={-1} className="banner-ok" role="status" data-testid="duplicated-notice">
          <span>複製して下書きを作りました。開始するまで訪問者には表示されません。内容を確かめてから開始してください</span>
          <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
            閉じる
          </button>
        </div>
      ) : null}
      {analyticsFailed ? <ErrorBox message="外部計測のエクスペリエンス名を変えられませんでした(元と同じ名前のままです)。基本設定の「外部計測(dataLayer 出力)」のカードで直して保存してください" /> : null}
    </>
  );
}
