/**
 * 管理画面の移動の入口(B173 第 1 段)。アプリの中の遷移(router.push / replace)と全画面の移動(window.location)を 1 か所に集め、
 * store(lib/feedback-store.ts)に「遷移の始まり」を知らせる。画面の側はこの入口だけを呼ぶ(test/navigate.test.ts が、すり抜ける呼び出しが無いか検査する)。
 * React・ルーターに依らない(router は引数で受ける。単体テストと、どの部品からも同じ形で呼べるように)。
 *
 * 2 つの判定を分けている:
 * - isAppNavigation: アプリの中の遷移か。読み直しの反映を待たせるか・push するかは、これだけで決める
 * - shouldStartNavigation: 遷移の「表示」(store の遷移)を始めるか。同じ画面・最後の印と同じ URL への移動は、印が新しく出ないので
 *   store の遷移を始めると終わらない。表示を省くリンクでも、読み直しの間は必ず待たせる(待たせないと、vinext が遷移を黙って捨てる窓が開く。lib/refresh-wait.ts)
 */
import { cancelNavigation, lastMarkUrl, markNavigationDispatched, normalizeUrl, startNavigation, targetScope } from "@/lib/feedback-store";
import { deferUntilRefreshed, isRefreshPending } from "@/lib/refresh-wait";

export { targetScope };

/**
 * 移動の入口が返す、始めた移動の種類(B173 第 2 段。BusyScope の waitNav が移動の終わりを待つのに使う)。
 * - document: ページが閉じる移動(window.location.assign・reload)。seq はアプリの中の URL への navigateDocument なら
 *   startNavigation が始めた store の遷移の番号(打ち切りの文言は NavGate が出す)。reloadDocument・外の URL は null
 *   (store の遷移を始めないので、待つ側が自分の時計と文言を持つ)
 * - app: store の遷移を始めた(その番号)
 * - none: アプリの中の遷移でない・表示を始めない遷移(同じ URL・最後の印と同じ URL)。ページは閉じず、印も来ない
 */
export type NavHandle = { kind: "document"; seq: number | null } | { kind: "app"; seq: number } | { kind: "none" };

type NavigateRouter = {
  push(href: string, options?: { scroll?: boolean }): void;
  replace(href: string, options?: { scroll?: boolean }): void;
};

/** 今の画面の URL(normalizeUrl の形)。window の無い環境(単体テスト)では "/" */
export function currentUrl(): string {
  if (typeof window === "undefined") return "/";
  return normalizeUrl(window.location.pathname + window.location.search);
}

/** window の無い環境(単体テスト)の基準 URL */
function baseUrl(): string {
  return typeof window !== "undefined" ? window.location.href : "http://localhost/";
}

/** アプリの中の遷移か。`#` だけ(同じ画面の別の位置)・別のオリジン・URL にできない値は false */
export function isAppNavigation(href: string): boolean {
  if (href.trim().startsWith("#")) return false;
  try {
    const base = new URL(baseUrl());
    return new URL(href, base).origin === base.origin;
  } catch {
    return false;
  }
}

/**
 * 遷移の表示(store の遷移)を始めるか。isAppNavigation が false・今と同じ URL・最後の印の URL と同じなら false。
 * 最後の印と同じ: URL が replaceState で印からずれた画面から、印と同じ URL へ移る場合。サーバーが同じ印を描き直しても印は知らせないので、
 * store の遷移を始めると終わらない(vinext の遷移はそのまま走る)
 */
export function shouldStartNavigation(href: string, current: string): boolean {
  if (!isAppNavigation(href)) return false;
  const target = normalizeUrl(href);
  return target !== normalizeUrl(current) && target !== lastMarkUrl();
}

/**
 * アプリの中の遷移。isAppNavigation が false なら何もしない。
 * 読み直しの反映を待っていれば、その後に回す(後から押したものが前のものに替わる)。回した遷移の打ち切りの時計は、実際に push した時点から数える
 */
export function navigateApp(
  router: NavigateRouter,
  href: string,
  opts: { replace?: boolean; key?: string | null; scroll?: boolean } = {},
): NavHandle {
  if (!isAppNavigation(href)) return { kind: "none" };
  const fromUrl = currentUrl();
  const seq = shouldStartNavigation(href, fromUrl)
    ? startNavigation({ href: normalizeUrl(href), fromUrl, key: opts.key ?? null, deferred: isRefreshPending() })
    : undefined;
  const options = { scroll: opts.scroll !== false };
  deferUntilRefreshed("navigation", () => {
    if (seq !== undefined) markNavigationDispatched(seq);
    // 表示を始めない遷移が実際に始まるとき、前の遷移(読み直しの間に押した別の画面へのリンクなど)は置き換わるので、store からも終える
    else cancelNavigation();
    if (opts.replace) router.replace(href, options);
    else router.push(href, options);
  });
  return seq !== undefined ? { kind: "app", seq } : { kind: "none" };
}

/** 全画面の移動。始まりを知らせてから移る(ページが閉じるまで、150 ms を過ぎればスケルトンが出る) */
export function navigateDocument(href: string): NavHandle {
  const seq = isAppNavigation(href) ? startNavigation({ href: normalizeUrl(href), fromUrl: currentUrl(), key: null }) : null;
  window.location.assign(href);
  return { kind: "document", seq };
}

/** 今の画面の全画面の読み直し。遷移の始まりは知らせない(行き先が変わらないので、終わりの印が来ない) */
export function reloadDocument(): NavHandle {
  window.location.reload();
  return { kind: "document", seq: null };
}
