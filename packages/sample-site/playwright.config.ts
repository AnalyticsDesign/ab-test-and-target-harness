import { defineConfig } from "@playwright/test";
import {
  E2E_RESULTS_VISITOR_KEY,
  EXAMPLE_EDGE_PERSIST,
  EXAMPLE_HOST,
  EXAMPLE_HTTPS_PORT,
  RESULTS_EDGE_PERSIST,
  RESULTS_HOST,
} from "./e2e/results-key";

// D9 ② K25: 計測用 D1 の訪問者の鍵は .dev.vars に依存せず、起動コマンドで固定値を渡す(helpers.ts の visitorKeySql が同じ値で計算する)
const RESULTS_VAR = `--var RESULTS_VISITOR_KEY:${E2E_RESULTS_VISITOR_KEY}`;

// B139 のローカルの HTTPS と名前の解決(本番と同じ経路を試すための土台。経路の条件はテストのために緩めない):
//
//   Chromium ── https://www.example.test/ (ポート無し) ──┐ --host-resolver-rules で *.example.test:443 を手元の HTTPS サーバーへ向ける
//        (location.host = "www.example.test"。ポートが入ると runtime の onEdgePath が偽になるので入れない)
//                                                        ▼
//   node server.mjs (WTT_TLS=1, 自己署名, 127.0.0.1:${EXAMPLE_HTTPS_PORT})  ── 静的ページと /s/*。/v1・/__ab は Host 名で転送先を選ぶ(WTT_EDGE_MAP)
//        ├─ Host www.example.test     → 8791 の edge   = Cloudflare 経由のホスト(Mode B。/__ab/* が edge に届く)
//        ├─ Host results.example.test → 8790 の edge   = 結果の E2E 用の Cloudflare 経由のホスト
//        └─ Host form.example.test    → /v1・/__ab は 404 = Cloudflare の外のホスト(静的ページだけ。API は焼いた apiBase の
//                                       https://www.example.test/v1/ を別オリジンで呼ぶ。CORS は Site の allowedOrigins)
//
//   edge が元のホスト名を受ける仕組み: wrangler dev は受けた Host を捨て、"local upstream" のホスト名に書き換えて Worker に渡す
//   (--local-upstream > wrangler.jsonc の dev.host > route。wrangler 4.133 で確認)。共有の dev.host は localhost のまま(ほかの spec が使う)にして、
//   edge を 1 つ足すごとに --local-upstream でホスト名を固定する。つまり 1 つの edge は 1 つのホスト名の D-lite の Site だけを持てる
const HOST_RULES = `MAP *.example.test 127.0.0.1:${EXAMPLE_HTTPS_PORT}`;
const EDGE_MAP = `${EXAMPLE_HOST}=http://127.0.0.1:8791,${RESULTS_HOST}=http://127.0.0.1:8790`;

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:4173", ignoreHTTPSErrors: true },
  webServer: [
    {
      command: `pnpm -C ../../apps/edge exec wrangler dev --port 8787 ${RESULTS_VAR}`,
      url: "http://127.0.0.1:8787/",
      // 毎回新しい isolate で起動する。dev を再利用すると edge の 60 秒キャッシュ
      // (store.ts の TTL_MS)が fixture 変更を最大 60 秒隠し、
      // runtime のバグと誤診しやすい(r1 CL-Medium-6)
      reuseExistingServer: false,
      timeout: 60_000,
    },
    // D9 ②: 結果の E2E(results.spec.ts)用の edge。別の状態の置き場(KV・D1・DO)と別のポートで起動する(理由は e2e/results-key.ts)。
    // ほかの spec はここを使わない
    {
      // --local-upstream: この edge に届く Host を RESULTS_HOST に固定する(結果の E2E の D-lite の Site の host。上の図)
      command: `pnpm -C ../../apps/edge exec wrangler dev --port 8790 --inspector-port 9239 --persist-to ${RESULTS_EDGE_PERSIST} --local-upstream ${RESULTS_HOST} ${RESULTS_VAR}`,
      url: "http://127.0.0.1:8790/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    // B139: Cloudflare 経由のホスト(EXAMPLE_HOST)の D-lite の Site 用の edge。別の状態の置き場と別のポート(理由は e2e/results-key.ts)
    {
      command: `pnpm -C ../../apps/edge exec wrangler dev --port 8791 --inspector-port 9240 --persist-to ${EXAMPLE_EDGE_PERSIST} --local-upstream ${EXAMPLE_HOST} ${RESULTS_VAR}`,
      url: "http://127.0.0.1:8791/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    // server.mjs は 127.0.0.1 だけで待ち受ける。Node 17+ は localhost を ::1 に先に解決することがあるので、起動確認の URL は IPv4 で書く
    // (ブラウザの baseURL は localhost のまま。Chromium は IPv6 が繋がらなければ IPv4 に切り替える。Secure Cookie の trustworthy origin も変わらない)
    { command: "node server.mjs", url: "http://127.0.0.1:4173/", reuseExistingServer: true },
    // 結果の E2E 用の sample-site(/v1/*・/__ab/* を上の 8790 の edge へ転送する。RESULTS_ORIGIN)
    {
      command: "node server.mjs",
      url: "http://127.0.0.1:4174/",
      reuseExistingServer: true,
      env: { PORT: "4174", WTT_EDGE_URL: "http://127.0.0.1:8790" },
    },
    // B139: 自己署名の HTTPS の sample-site(https://*.example.test/ で開く。上の図)。起動確認は証明書の検証を省く
    {
      command: "node server.mjs",
      url: `https://127.0.0.1:${EXAMPLE_HTTPS_PORT}/`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: true,
      env: { PORT: String(EXAMPLE_HTTPS_PORT), WTT_TLS: "1", WTT_EDGE_MAP: EDGE_MAP },
    },
  ],
  // Secure Cookie の書込みは trustworthy origin(localhost)前提。既定ブラウザを固定して環境差を減らす(r1 CL-Low-6)
  // *.example.test の名前の解決は上の図。localhost / 127.0.0.1 の要求は規則に当たらず今までどおり
  projects: [{ name: "chromium", use: { browserName: "chromium", launchOptions: { args: [`--host-resolver-rules=${HOST_RULES}`] } } }],
});
