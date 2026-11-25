import type { Site } from "./types";

/** 古い control は理由を返さない。印が立っているなら自動での再同期を案内する。 */
export function kvStaleBannerText(reason: Site["activeKvStaleReason"]): string {
  return reason === "config_missing"
    ? "配信の設定が見つかりません。公開し直してください"
    : "配信ポインタが未収束です(自動で再同期します。通常 15 分以内に反映します)";
}
