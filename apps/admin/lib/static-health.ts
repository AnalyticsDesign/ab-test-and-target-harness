import type { RebuildResult, StaticHealthView } from "./types";

/**
 * 7o K14: 設置タグの配信ファイルの配置の状態(GET /static/status。システム管理者だけ)を、全ページの帯・配信ファイルの画面・
 * サイトの警告帯の文言にする部分と、帯の取り直しの考え方・全サイトの作り直しの繰り返し(React に依存しない。node の試験で確かめる)。
 * 文言の出どころ = モック docs/dev/mocks/static_delivery_status_mock_v1.html の案 1(statusRows / staticPage / rebuildBlock / renderModal)と、
 * K14 の「モックとの違い」。画面に出る文なので、設計記録への参照を書かない
 */

/** 帯の取り直しの間隔(タブ 1 つにつき 1 時間 12 回。費用は K14) */
export const STATIC_HEALTH_POLL_MS = 300_000;
/** 配信ファイルの画面が作り直しを終えたときに window に出すイベント(帯に取り直させる) */
export const STATIC_HEALTH_REFRESH_EVENT = "wtt:static-health-refresh";

/** 帯の状態。unreachable = binding はあるのに状態の GET が続けて取れなかった回数(2 回で「取得できません」の帯) */
export type StaticHealthState = { view: StaticHealthView | null; unreachable: number };
/** 状態の GET の結果。失敗は 503 static_deployer_unavailable の封筒の reason で分ける(それ以外の失敗は other) */
export type StaticHealthFetch = { ok: true; data: unknown } | { ok: false; reason: "not_configured" | "unreachable" | "other" };
type RebuildFailure = RebuildResult["failed"][number];
export type RebuildTotal = { requested: number; removed: number; skippedRemoving: number; failed: RebuildFailure[] };

const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 応答の形を確かめる(形が違えば null。帯は直前の表示を保ち、画面はエラーの箱にする) */
export function parseStaticHealth(data: unknown): StaticHealthView | null {
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;
  const ok =
    isIds(o.pendingSites) &&
    isIds(o.removingSites) &&
    (o.lastError === null || typeof o.lastError === "string") &&
    isInt(o.failures) &&
    (o.lastDeployedAt === null || isInt(o.lastDeployedAt)) &&
    isIds(o.mismatchSites) &&
    isIds(o.unknownSites) &&
    isIds(o.undeliveredSites) &&
    isInt(o.publishedSites) &&
    isInt(o.unpublishedWithFiles) &&
    isInt(o.removingInD1) &&
    typeof o.needsAttention === "boolean";
  return ok ? (data as StaticHealthView) : null;
}

/** 作り直しで直る記録の問題の数(食い違い + 記録に無い + 依頼が届いていない)。帯の数と、作り直しのボタンを主ボタンにするか(決まり 2.4) */
export function recordIssueCount(h: StaticHealthView): number {
  return h.mismatchSites.length + h.unknownSites.length + h.undeliveredSites.length;
}

/**
 * 全ページの帯の文(出さないときは null)。取得できない状態(2 回続けて)を先に見る。
 * needsAttention は lastError か failures でも立つが、lastError が null で記録の問題も 0 のときは書く中身が無いので出さない
 * (配置の失敗が続けば deployer は lastError を残す)
 */
export function staticHealthBannerText(s: StaticHealthState): string | null {
  if (s.unreachable >= 2) return "設置タグの配信ファイルの状態を取得できません。デプロイ専用の Worker がデプロイされているかを確かめてください";
  const h = s.view;
  if (!h || !h.needsAttention) return null;
  if (h.lastError) return `設置タグの配信ファイルの更新が止まっています(最後のエラー: ${h.lastError})`;
  const n = recordIssueCount(h);
  return n > 0 ? `設置タグの配信ファイルの記録が食い違っています(${n} サイト)。公開中の全サイトの配信ファイルを作り直してください` : null;
}

export type StaticHealthRow = { label: string; state: { kind: "ok" | "warn" | "danger" | "text"; text: string }; description: string };

const count = (ids: string[]): StaticHealthRow["state"] => (ids.length > 0 ? { kind: "warn", text: `${ids.length} サイト` } : { kind: "ok", text: "なし" });

/**
 * 表「配置の状態」の 8 行(モックの statusRows の 7 行 +「更新の依頼が届いていないサイト」)。
 * 「最後のエラー」の行の状態のエラーの本文(<code>)と、「最後に成功した時刻」の時刻(見ている人のタイムゾーン)は画面が描く。
 * 時刻の text は時刻が無いときの「—」か、ISO の文字列(画面が LocalTime で置き換える。サーバーとブラウザで書式がずれないように)
 */
export function staticHealthRows(h: StaticHealthView): StaticHealthRow[] {
  return [
    { label: "更新待ちのサイト", state: count(h.pendingSites), description: "公開した内容がまだ配信ファイルになっていないサイト。訪問者には前の配信ファイルが届きます。自動で再試行します。" },
    {
      label: "削除を受け付けたが、まだ消えていないサイト",
      state: count(h.removingSites),
      description: "削除したサイト・ワークスペースの配信ファイルが残っていて、訪問者にはまだ届きます。自動で再試行します。",
    },
    {
      label: "最後のエラー",
      state: h.lastError ? { kind: "danger", text: "失敗中" } : { kind: "ok", text: "なし" },
      // K14: モックの文(Authentication error は…)を、トークンの問題に限らない書き方に替えた
      description: h.lastError ? "トークンの問題(Authentication error など)なら、デプロイ用のトークンを入れ直すと、次の再試行(1 時間以内)で配置されます。" : "—",
    },
    { label: "連続の失敗", state: { kind: "text", text: `${h.failures} 回` }, description: h.failures > 0 ? "最後に成功してからの失敗の回数です。" : "—" },
    {
      label: "最後に成功した時刻",
      state: { kind: "text", text: h.lastDeployedAt === null ? "—" : new Date(h.lastDeployedAt).toISOString() },
      description: h.lastError ? "この時刻より後の公開は、配信ファイルに入っていません。" : "—",
    },
    { label: "記録が食い違っているサイト", state: count(h.mismatchSites), description: "データベースを過去の時点に戻した後などに起きます。下の「公開中の全サイトの配信ファイルを作り直す」で直ります。" },
    {
      label: "デプロイ専用の Worker の記録に無い公開中のサイト",
      state: count(h.unknownSites),
      description: "デプロイ専用の Worker を作り直した後などに起きます。このままでは次の公開で配信ファイルが消えます。作り直しで直ります。",
    },
    {
      label: "更新の依頼が届いていないサイト",
      state: count(h.undeliveredSites),
      description: "データベースでは内容が新しくなっているのに、デプロイ専用の Worker に更新の依頼が届いていないサイト。15 分ごとの定期処理が依頼し直します。",
    },
  ];
}

/** サイトの警告帯(StaticStaleBanner)の文。優先は 削除の途中 → 記録の食い違い → 更新が済んでいない */
export function staticStaleText(site: { staticRemoving: boolean; staticMismatch?: boolean }): string {
  if (site.staticRemoving) return "このサイトの削除が途中で止まっています。もう一度削除するか、「配信ファイルを作り直す」で配信を戻してください。";
  if (site.staticMismatch === true) return "このサイトの配信ファイルの記録が食い違っています(データベースを過去の時点に戻した後などに起きます)。今の公開内容で作り直してください。";
  // 未設定・初回・再試行中のどれでも誤解が無いように書く(この帯からは区別できない)
  return "設置タグの配信ファイルが最新の公開内容になっていません。前に作った配信ファイルがあれば訪問者にはそれが届き、初めての公開でまだ無ければタグは読み込まれません。配信ファイルを更新する仕組みが設定されていれば、自動で再試行します。";
}

/** 確認のモーダルの本文の段落(モックの renderModal。数は publishedSites・removingInD1、消すサイトがあれば 1 段落足す) */
export function rebuildConfirmParagraphs(h: StaticHealthView): string[] {
  return [
    `公開中の全サイト(${h.publishedSites} サイト)の配信ファイルを、今の公開内容で作り直します。デプロイ専用の Worker を作り直した後や、データベースを過去の時点に戻した後に使います。`,
    ...(h.unpublishedWithFiles > 0 ? [`データベースでは未公開か、データベースに無いのに配信ファイルが残っている ${h.unpublishedWithFiles} サイトは、配信ファイルを消します。`] : []),
    `削除の途中のサイト${h.removingInD1 > 0 ? `(${h.removingInD1} サイト)` : ""}は対象外です。公開の内容と訪問者の割り当ては変わりません。`,
  ];
}

/**
 * 作り直しの結果のカード(緑)の本文の行。失敗は、時間をおいて押せば直るもの(rejected・unavailable)と、
 * 押し直しても直らず公開し直すもの(no_publish_record)の 2 つの文に分ける
 */
export function rebuildResultLines(total: RebuildTotal): string[] {
  const ids = (pick: (r: RebuildFailure["reason"]) => boolean) =>
    total.failed
      .filter((f) => pick(f.reason))
      .map((f) => f.siteId)
      .join("、");
  const retry = ids((r) => r !== "no_publish_record");
  const republish = ids((r) => r === "no_publish_record");
  return [
    `公開中の ${total.requested} サイトの配信ファイルの作り直しを受け付けました。配置は 1 分ほどで終わり、訪問者に届くまでさらに 1 分ほどかかります。上の表で状態を確かめてください。`,
    ...(total.removed > 0 ? [`データベースでは未公開か、データベースに無い ${total.removed} サイトの配信ファイルの削除を頼みました。`] : []),
    ...(retry ? [`次のサイトは受け付けられませんでした: ${retry}。時間をおいてもう一度押してください。`] : []),
    ...(republish ? [`次のサイトは公開履歴が無いため作り直せませんでした: ${republish}。そのサイトを公開し直してください。`] : []),
    ...(total.skippedRemoving > 0 ? [`削除の途中の ${total.skippedRemoving} サイトは対象外にしました。`] : []),
  ];
}

/**
 * 帯の次の状態(nextCapabilities と同じ考え方: 取れなければ直前の表示を保つ)。
 * - 正しい形の data → 新しい値、回数は 0
 * - 形が違う data・それ以外の失敗 → prev のまま
 * - unreachable(binding はあるのに届かない)→ view を保って回数 +1(2 回で取得できない旨の帯)
 * - not_configured(binding が無い)→ view を保って回数 0(取得できない旨の帯を出さない)
 */
export function nextStaticHealth(prev: StaticHealthState, res: StaticHealthFetch): StaticHealthState {
  if (res.ok) {
    const view = parseStaticHealth(res.data);
    return view ? { view, unreachable: 0 } : prev;
  }
  if (res.reason === "unreachable") return { view: prev.view, unreachable: prev.unreachable + 1 };
  if (res.reason === "not_configured") return { view: prev.view, unreachable: 0 };
  return prev;
}

/**
 * 全サイトの作り直し。next が null になるまで続きを頼み(1 回目の after は null)、結果を合計する。途中の失敗は投げる(呼ぶ側がエラーの箱に出す)。
 * signal = 打ち切りの合図(BusyScope の 30 秒の上限)。各 POST に渡し、中止の後は続きを頼まない
 * (上限で結果が分からなくなった後もループが裏で続くと、押し直したときに 2 本走るため。B173 第 2 段)
 */
export async function runRebuild(
  call: (after: string | null, signal?: AbortSignal) => Promise<RebuildResult>,
  onProgress: (requested: number) => void,
  signal?: AbortSignal,
): Promise<RebuildTotal> {
  const total: RebuildTotal = { requested: 0, removed: 0, skippedRemoving: 0, failed: [] };
  let after: string | null = null;
  do {
    if (signal?.aborted) throw new Error("作り直しを打ち切りました");
    const r: RebuildResult = await call(after, signal);
    // 続きの ID が進まなければ止める(同じ頁を頼み続けない)
    if (r.next !== null && r.next === after) throw new Error("作り直しの続きを頼めませんでした。時間をおいてもう一度押してください");
    total.requested += r.requested;
    total.removed += r.removed;
    total.skippedRemoving += r.skippedRemoving;
    total.failed.push(...r.failed);
    onProgress(total.requested);
    after = r.next;
  } while (after !== null);
  return total;
}
