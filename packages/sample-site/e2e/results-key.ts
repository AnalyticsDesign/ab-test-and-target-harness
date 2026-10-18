/**
 * E2E 用の訪問者の鍵(RESULTS_VISITOR_KEY。D9 ② K25)。playwright.config.ts が edge の起動に `--var` で渡し、
 * helpers.ts が同じ鍵で visitor_key を計算して、計測用 D1 の行をその訪問者だけに絞って読む(ほかの spec・前の実行の行と混ぜない)。
 * 32 バイトの ASCII("wtt-e2e-results-visitor-key-0001")の base64。テスト専用で、本番の鍵ではない
 */
export const E2E_RESULTS_VISITOR_KEY = "d3R0LWUyZS1yZXN1bHRzLXZpc2l0b3Ita2V5LTAwMDE=";

/**
 * 結果の E2E(results.spec.ts)用の edge の状態の置き場(apps/edge からの相対)。ほかの spec の edge と分ける理由は 2 つ:
 * - D-lite の Site は host で引くが、wrangler dev は Worker から見える host を localhost に固定する(wrangler.jsonc の dev.host)ので、
 *   1 つの状態に D-lite の Site を 1 つしか置けない(demo-dlite が使っている)
 * - 結果のイベントの POST が、ほかの spec と同じ IP あたりのレート制限(20 req / 10 秒)を使い切らないように(backlog B80 を悪化させない)
 */
export const RESULTS_EDGE_PERSIST = ".wrangler/state-results";

/** 結果の E2E 用の sample-site(/v1/*・/__ab/* を結果の E2E 用の edge へ転送する) */
export const RESULTS_ORIGIN = "http://localhost:4174";
