"use client";
import { API_CONTRACT_VERSION } from "@wtt/core";
import { versionBannerKind } from "@/lib/capabilities";
import type { Capabilities } from "@/lib/types";
import { useCapabilitiesPoll } from "./useCapabilitiesPoll";
import { VersionBanner } from "./VersionBanner";
import { WriteFreezeBanner } from "./WriteFreezeBanner";

/**
 * 認証済みの全ページの上に出す、`/capabilities` 由来の帯(凍結・版)。
 * `/capabilities` の取り直しはここで 1 回だけ行い(useCapabilitiesPoll)、2 つの帯に値を渡す(別々に取りに行かない)。
 * 版の帯は凍結の帯の下(凍結は全員の操作に関わるので一番上)。どちらも常にマウントする(開いていた画面にも取り直しで帯が出るように)
 */
export function CapabilitiesBanners({ initial }: { initial: Capabilities }) {
  const caps = useCapabilitiesPoll(initial);
  return (
    <>
      <WriteFreezeBanner freeze={caps.writeFreeze} />
      <VersionBanner kind={versionBannerKind(API_CONTRACT_VERSION, caps)} />
    </>
  );
}
