import type { VersionBannerKind } from "@/lib/capabilities";

/** plan12 K6: 管理画面と control の版の食い違いの帯の文。文言は公開物 — 設計記録への参照を書かない */
const TEXT: Record<VersionBannerKind, string> = {
  incompatible: "管理画面の新しい版があります。この画面のままでは保存できません。ページを再読み込みしてください(未保存の入力は消えます)",
  outdated: "管理画面の新しい版があります。ページを再読み込みすると反映されます",
  control_outdated: "サーバー側(control)が管理画面より古い版です。更新の途中か、control の更新が漏れています。作業者に確認してください",
};

/**
 * 版の帯。incompatible は書き込みが断られる状態なので目立つ帯(banner-warn)、outdated は急がない案内なので控えめな帯(banner-note)。
 * 閉じるボタンは置かない。保存ボタンは止めない(判定の正は control の 426)。
 * 取得は親(CapabilitiesBanners)の 1 回の取り直しを使う — ここでは取りに行かない
 */
export function VersionBanner({ kind }: { kind: VersionBannerKind | null }) {
  if (kind === null) return null;
  return (
    <div className={`${kind === "outdated" ? "banner-note" : "banner-warn"} banner-full`} data-testid="version-banner" data-kind={kind} role="status">
      <span>{TEXT[kind]}</span>
    </div>
  );
}
