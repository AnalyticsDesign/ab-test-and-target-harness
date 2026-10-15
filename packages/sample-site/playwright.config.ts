import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:4173" },
  webServer: [
    {
      command: "pnpm -C ../../apps/edge exec wrangler dev --port 8787",
      url: "http://127.0.0.1:8787/",
      // 毎回新しい isolate で起動する。dev を再利用すると edge の 60 秒キャッシュ
      // (store.ts の TTL_MS)が fixture 変更を最大 60 秒隠し、
      // runtime のバグと誤診しやすい(r1 CL-Medium-6)
      reuseExistingServer: false,
      timeout: 60_000,
    },
    // server.mjs は 127.0.0.1 だけで待ち受ける。Node 17+ は localhost を ::1 に先に解決することがあるので、起動確認の URL は IPv4 で書く
    // (ブラウザの baseURL は localhost のまま。Chromium は IPv6 が繋がらなければ IPv4 に切り替える。Secure Cookie の trustworthy origin も変わらない)
    { command: "node server.mjs", url: "http://127.0.0.1:4173/", reuseExistingServer: true },
  ],
  // Secure Cookie の書込みは trustworthy origin(localhost)前提。既定ブラウザを固定して環境差を減らす(r1 CL-Low-6)
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
