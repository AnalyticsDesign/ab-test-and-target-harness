/**
 * サイト設定の「いま開いている節」と「入力エラーのある節」を、フォーム(SiteSettingsForm)とサイドバーで共有する小さな store(B60 D3)。
 *
 * 節の切り替えは Next のルーターを通さず replaceState で URL に写すだけ(ページの再取得とフォームの状態の食い違いを避けるため)。
 * vinext(1.0.0-beta.10)はアプリが持つ state のままの replaceState を useSearchParams に知らせないので、節の値は URL から読まずに
 * この store が自分で持つ。URL から読むのは popstate(戻る・進む)のときだけ。
 * クライアント遷移で URL が書き換わる時機(新しい画面の描画の前か後か)に左右されないためでもある。
 *
 * フォームとの約束:
 * - フォームは表示したとき(mount)と initialSection が変わったときだけ syncSettingsSection(initialSection) を呼ぶ
 *   (ふつうの再描画で入れ直すと、利用者が切り替えた節が元に戻るため)
 * - フォームは消えるとき(unmount)に clearSettingsSection() と setSectionErrors([]) で空に戻す
 *   (前の画面の値が残って、次に開いたフォームやサイドバーに効かないように)
 * store が空の間(サーバーでの描画・フォームが入れる前・フォームが消えた後)は、読む側が渡した fallback を返す
 *
 * window にはモジュールの読み込みでは触らない(unit test は node で動く)。popstate は購読者がいる間だけ聞く
 */
import { useSyncExternalStore } from "react";
import { SECTION_IDS, type SectionId } from "@/components/settings/sections";
import { pickParam, replaceParam } from "./url-state";
import { deferUntilRefreshed } from "./refresh-wait";

/** URL の search(`?section=...`)から節を引く。無い・知らない値は一般の節。重なったら先頭 */
export function readSection(search: string): SectionId {
  return pickParam(new URLSearchParams(search).get("section") ?? undefined, SECTION_IDS, "general");
}

/**
 * href が今と同じサイト設定の画面(パスが同じ)を指すなら、その節。違う画面なら null。
 * 未保存のまま節のリンクを押したときに、離脱の確認を出さずに節だけを切り替えるのに使う
 */
export function sectionOfHref(href: string, currentPath: string): SectionId | null {
  let url: URL;
  try {
    url = new URL(href, "http://local"); // 相対の href を読むための仮の base(オリジンは比べない)
  } catch {
    return null;
  }
  return url.pathname === currentPath ? readSection(url.search) : null;
}

// ---------------------------------------------------------------------------
// 節の store
// ---------------------------------------------------------------------------

let section: SectionId | null = null;
const sectionListeners = new Set<() => void>();

function emitSection(next: SectionId | null) {
  if (section === next) return;
  section = next;
  for (const l of sectionListeners) l();
}

// 戻る・進むで URL が変わったら、URL の節に合わせる。store が空(フォームがいない)なら入れない(空のままにして fallback に任せる)
function onPopState() {
  if (section !== null) emitSection(readSection(window.location.search));
}

function subscribeSection(listener: () => void): () => void {
  sectionListeners.add(listener);
  if (sectionListeners.size === 1) window.addEventListener("popstate", onPopState);
  return () => {
    sectionListeners.delete(listener);
    if (sectionListeners.size === 0) window.removeEventListener("popstate", onPopState);
  };
}

/** 節を切り替える(URL にも写す。一般の節は section を付けない)。replaceParam は URL_PARAM_EVENT を出すので、設定を開いた場所の記憶もこれを見る */
export function setSettingsSection(id: SectionId): void {
  // 保存の後の読み直しが画面に反映される前に切り替えると、反映が節を一般に戻す(管理画面の速さの記録 4 節・CE-R9)。
  // その間だけ切り替えを反映の後に回す(lib/refresh-wait.ts。後から押した節が前のものに替わる)
  deferUntilRefreshed("settings-section", () => {
    replaceParam("section", id === "general" ? null : id);
    emitSection(id);
  });
}

/** URL を書き換えずに store の値だけを入れる(フォームが initialSection を入れるのに使う) */
export function syncSettingsSection(id: SectionId): void {
  emitSection(id);
}

/** store を空に戻す(フォームが消えるときに呼ぶ) */
export function clearSettingsSection(): void {
  emitSection(null);
}

/** いま開いている節。store が空なら fallback(サーバーでの描画も fallback) */
export function useSettingsSection(fallback: SectionId): SectionId {
  return useSyncExternalStore(
    subscribeSection,
    () => section ?? fallback,
    () => fallback,
  );
}

// ---------------------------------------------------------------------------
// 入力エラーのある節の store(フォームが書き、サイドバーの設定のメニューが印を付ける)
// 今開いている節を除くのは読む側(印は今開いている節には付けない)。store はエラーのある節をすべて持つ
// ---------------------------------------------------------------------------

const NO_ERRORS: ReadonlySet<SectionId> = new Set();
let errors: ReadonlySet<SectionId> = NO_ERRORS;
const errorListeners = new Set<() => void>();

function subscribeErrors(listener: () => void): () => void {
  errorListeners.add(listener);
  return () => void errorListeners.delete(listener);
}

/** エラーのある節を入れ替える。中身が同じなら知らせない(useSyncExternalStore は同じ参照を返し続ける必要があるため、変わったときだけ作り直す) */
export function setSectionErrors(ids: readonly SectionId[]): void {
  const next = new Set(ids);
  if (next.size === errors.size && [...next].every((id) => errors.has(id))) return;
  errors = next.size === 0 ? NO_ERRORS : next;
  for (const l of errorListeners) l();
}

export function useSectionErrors(): ReadonlySet<SectionId> {
  return useSyncExternalStore(
    subscribeErrors,
    () => errors,
    () => NO_ERRORS,
  );
}
