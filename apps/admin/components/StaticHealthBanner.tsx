"use client";
import { useEffect, useState } from "react";
import { AppLink } from "@/components/ui/AppLink";
import { usePathname } from "next/navigation";
import { startCapabilitiesPoll } from "@/lib/capabilities-poll";
import { api, ApiClientError } from "@/lib/client";
import {
  nextStaticHealth,
  staticHealthBannerText,
  STATIC_HEALTH_POLL_MS,
  STATIC_HEALTH_REFRESH_EVENT,
  type StaticHealthFetch,
  type StaticHealthState,
} from "@/lib/static-health";

const STATUS_PAGE = "/w/me/static-delivery";

/** 状態の GET。投げずに結果の形にする(503 static_deployer_unavailable は封筒の reason で分け、それ以外の失敗は other) */
async function fetchStatus(): Promise<StaticHealthFetch> {
  try {
    return { ok: true, data: await api("GET", "/static/status") };
  } catch (e) {
    if (e instanceof ApiClientError && e.code === "static_deployer_unavailable") {
      const reason = e.extra.reason;
      if (reason === "not_configured" || reason === "unreachable") return { ok: false, reason };
    }
    return { ok: false, reason: "other" };
  }
}

/**
 * 7o K14: システム管理者にだけ、認証済みの全ページの上部(凍結・版の帯の下)に出す、設置タグの配信ファイルの帯。
 * 置くのは app/w/layout.tsx の 1 か所(user.instanceAdmin のときだけ)。取得はクライアントだけ: 全ページの描画にデプロイ専用の Worker への往復を足さず、
 * 失敗で layout を壊さないため。マウント時・5 分ごと・タブが前に戻ったとき(startCapabilitiesPoll)と、
 * 配信ファイルの画面が作り直しを終えたとき(STATIC_HEALTH_REFRESH_EVENT)に取り直す。取れなければ直前の表示を保つ(nextStaticHealth)。
 * 「状態を見る」は配信ファイルの画面では出さない
 */
export function StaticHealthBanner() {
  const pathname = usePathname();
  const [state, setState] = useState<StaticHealthState>({ view: null, unreachable: 0 });
  useEffect(() => {
    let alive = true;
    // 要求の連番。マウント時・イベントの取得と定期の取得が前後しても、最後に出した要求の応答だけを使う
    let latest = 0;
    const load = async (): Promise<StaticHealthFetch | null> => {
      const seq = ++latest;
      const res = await fetchStatus();
      return alive && seq === latest ? res : null;
    };
    const apply = (res: StaticHealthFetch | null) => {
      if (res) setState((prev) => nextStaticHealth(prev, res));
    };
    const refresh = () => void load().then(apply);
    refresh();
    const stop = startCapabilitiesPoll({
      fetchCaps: load,
      onData: (data) => apply(data as StaticHealthFetch | null),
      doc: document,
      intervalMs: STATIC_HEALTH_POLL_MS,
    });
    window.addEventListener(STATIC_HEALTH_REFRESH_EVENT, refresh);
    return () => {
      alive = false;
      stop();
      window.removeEventListener(STATIC_HEALTH_REFRESH_EVENT, refresh);
    };
  }, []);
  const text = staticHealthBannerText(state);
  if (!text) return null;
  return (
    <div className="banner-warn banner-full" role="status" data-testid="static-health-banner">
      <span>{text}</span>
      {pathname === STATUS_PAGE ? null : (
        // 先読みしない(行き先の画面がデプロイ専用の Worker に問い合わせる)
        <AppLink href={STATUS_PAGE} prefetch={false}>
          状態を見る
        </AppLink>
      )}
    </div>
  );
}
