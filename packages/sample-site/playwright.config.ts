import { defineConfig } from "@playwright/test";
import { E2E_RESULTS_VISITOR_KEY, RESULTS_EDGE_PERSIST } from "./e2e/results-key";

// D9 ② K25: 計測用 D1 の訪問者の鍵は .dev.vars に依存せず、起動コマンドで固定値を渡す(helpers.ts の visitorKeySql が同じ値で計算する)
const RESULTS_VAR = `--var RESULTS_VISITOR_KEY:${E2E_RESULTS_VISITOR_KEY}`;

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:4173" },
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
      command: `pnpm -C ../../apps/edge exec wrangler dev --port 8790 --inspector-port 9239 --persist-to ${RESULTS_EDGE_PERSIST} ${RESULTS_VAR}`,
      url: "http://127.0.0.1:8790/",
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
  ],
  // Secure Cookie の書込みは trustworthy origin(localhost)前提。既定ブラウザを固定して環境差を減らす(r1 CL-Low-6)
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
