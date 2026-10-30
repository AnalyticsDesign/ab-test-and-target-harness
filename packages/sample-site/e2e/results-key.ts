/**
 * E2E 用の訪問者の鍵(RESULTS_VISITOR_KEY。D9 ② K25)。playwright.config.ts が edge の起動に `--var` で渡し、
 * helpers.ts が同じ鍵で visitor_key を計算して、計測用 D1 の行をその訪問者だけに絞って読む(ほかの spec・前の実行の行と混ぜない)。
 * 32 バイトの ASCII("wtt-e2e-results-visitor-key-0001")の base64。テスト専用で、本番の鍵ではない
 */
export const E2E_RESULTS_VISITOR_KEY = "d3R0LWUyZS1yZXN1bHRzLXZpc2l0b3Ita2V5LTAwMDE=";

/**
 * 結果の E2E(results.spec.ts)用の edge の状態の置き場(apps/edge からの相対)。ほかの spec の edge と分ける理由は 2 つ:
 * - D-lite の Site は host で引くが、wrangler dev は Worker から見える host を 1 つに固定する(--local-upstream。既定は wrangler.jsonc の dev.host = localhost)ので、
 *   1 つの状態に D-lite の Site を 1 つしか置けない(この edge は RESULTS_HOST、demo-dlite の edge は EXAMPLE_HOST。下の B139 の注記)
 * - 結果のイベントの POST が、ほかの spec と同じ IP あたりのレート制限を使い切らないように(ローカルではすべての要求が同じ IP の鍵で数えられる。
 *   上限が 20 req / 10 秒だったころは、並列実行の合計がこれを超えて 429 になっていた = backlog B80 の原因。429 は fixtures.ts が失敗の文言に出す)
 */
export const RESULTS_EDGE_PERSIST = ".wrangler/state-results";

/** 結果の E2E 用の sample-site(/v1/*・/__ab/* を結果の E2E 用の edge へ転送する) */
export const RESULTS_ORIGIN = "http://localhost:4174";

/**
 * B139: ローカルの HTTPS の E2E(playwright.config.ts の図)。入口はポート無しの https://<ホスト名>/ で、Chromium が *.example.test を EXAMPLE_HTTPS_PORT へ向ける。
 * EXAMPLE_HOST = Cloudflare 経由のホスト(Mode B の D-lite。hosts に載る)、FORM_HOST = Cloudflare の外のホスト(/v1/ を別オリジンで呼ぶ。allowedOrigins に載る)、
 * RESULTS_HOST = 結果の E2E 用の Cloudflare 経由のホスト(RESULTS_EDGE_PERSIST の edge が受ける)
 */
export const EXAMPLE_HTTPS_PORT = 4443;
export const EXAMPLE_HOST = "www.example.test";
export const FORM_HOST = "form.example.test";
export const RESULTS_HOST = "results.example.test";
export const EXAMPLE_ORIGIN = `https://${EXAMPLE_HOST}`;
export const FORM_ORIGIN = `https://${FORM_HOST}`;
export const RESULTS_HTTPS_ORIGIN = `https://${RESULTS_HOST}`;

/** EXAMPLE_HOST の D-lite の Site 用の edge(8791)の状態の置き場(apps/edge からの相対)。結果の E2E の置き場と分ける理由は上の RESULTS_EDGE_PERSIST と同じ(1 つの状態に D-lite の Site は 1 つ) */
export const EXAMPLE_EDGE_PERSIST = ".wrangler/state-example";
