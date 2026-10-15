import nodeConsole from "node:console";
import { Window } from "happy-dom";
import { vi, type MockInstance } from "vitest";

/**
 * vitest の happy-dom 環境が出すログ(外部 `<script src>` の読込失敗など)を握る。
 * 既定環境は外部スクリプトを読まず、接続した時点で同期に error を発火し、ページの console.error に記録する。
 * そのページの console は環境を作った時点の Node の console(`node:console`)で、テスト中の `console` とは別物なので、こちらを spy する。
 * 握った記録はテストが中身を確かめる(期待しない読込も見逃さない)。後始末は `mockRestore()` / `vi.restoreAllMocks()`
 */
export function spyPageConsoleError(): MockInstance<typeof console.error> {
  return vi.spyOn(nodeConsole, "error").mockImplementation(() => {});
}

/**
 * `<script>` を同期実行できる happy-dom Window。vitest 既定の環境(vitest.config.ts)は JavaScript を評価しないため、
 * CUSTOM_JS / HTML `<script>` の実行を見るテストはこれで Document を作る。
 * 返す doc は別 Window のものなので、グローバルの MutationObserver と混ぜない(エンジンの unit は既定環境で行う)
 */
export function executableDocument(url = "https://site.test/"): { win: Window; doc: Document } {
  // 外部ファイルの読込は無効にする: unit を実ネットワークに依存させない(`<script src>` の失敗はテストが自分で発火させる)
  const win = new Window({ url, settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true } });
  return { win, doc: win.document as unknown as Document };
}
