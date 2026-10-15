import { defineConfig } from "@playwright/test";
import { ADMIN_URL, AUTH_SECRET, BREAK_GLASS_TOKEN, CONTROL_URL, SETUP_TOKEN } from "./e2e/fixtures";

/**
 * admin の E2E。偽の Cloudflare API(8791)/ control + デプロイ専用の Worker(8799。1 プロセス)/ edge(8787)/ admin(3000)の 4 プロセスを起動して実際のブラウザで管理画面を操作し、
 * **control の Publish が設置タグの配信ファイルに現れる**ところまでを確認する(control → デプロイ専用の Worker → 偽の API。このプランの DoD 3)。
 *
 * 入口は必ずルートの `pnpm e2e:admin`。状態のリセット(`e2e/global-setup.ts`)は Playwright の `globalSetup` ではなく
 * その前段で走る — 理由は `e2e/global-setup.ts` のコメント参照。
 */
const STATE = "../control/.e2e-state"; // control と edge で共有(KV を共有するため)。edge の package ディレクトリからの相対

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // 落ちたら落ちたままにする。再試行で緑にすると「たまに落ちる E2E」を作ってしまい、誰も失敗を見なくなる
  retries: 0,
  // control / edge / D1 を共有し、publish → invite の順に状態を引き継ぐので直列に走らせる
  workers: 1,
  use: { baseURL: ADMIN_URL, trace: "retain-on-failure" },
  webServer: [
    {
      // 決定 52: 偽の Cloudflare API(配信専用の Worker の代わりに /s/* も配る)
      command: "node e2e/fake-cf-api.mjs",
      url: "http://127.0.0.1:8791/",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // `--var` は `.dev.vars` より優先される(wrangler 4.128.0 で実測)。開発者のローカル `.dev.vars` があっても E2E 用の値で走る
      // URL 系 3 つも上書きする(wrangler.jsonc の vars は本番値)。
      // 決定 46: E2E は Google を呼べないので、非常用のパスワードログインを開けた状態で起動する(fixtures.ts の login())
      // 決定 52: デプロイ専用の Worker は 2 つ目の -c で同じプロセスに載せる(control の DEPLOYER が確実に繋がる。別プロセス + dev registry だと
      // RPC が「Network connection lost」になる実行があった)。その Worker の vars(偽の API の向き先・偽の鍵)は e2e/deployer.wrangler.jsonc に書く(--var は効かない)
      command: `pnpm -C ../control exec wrangler dev -c wrangler.jsonc -c ../admin/e2e/deployer.wrangler.jsonc --port 8799 --persist-to .e2e-state --var AB_SETUP_TOKEN:${SETUP_TOKEN} --var BETTER_AUTH_SECRET:${AUTH_SECRET} --var AB_ADMIN_URL:${ADMIN_URL} --var AB_CONTROL_URL:${CONTROL_URL} --var AB_ASSET_PUBLIC_BASE:${CONTROL_URL}/dev-assets --var AB_EDGE_ORIGIN:https://wtt-edge.example.workers.dev --var AB_GOOGLE_CLIENT_ID:e2e-google-client-id --var AB_GOOGLE_CLIENT_SECRET:e2e-google-client-secret --var AB_BREAK_GLASS_TOKEN:${BREAK_GLASS_TOKEN} --var CF_USAGE_TOKEN: --var CF_ACCOUNT_ID:`,
      url: "http://127.0.0.1:8799/",
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      // control と同じディレクトリを指す(= 同じローカル KV を読む)
      command: `pnpm -C ../edge exec wrangler dev --port 8787 --persist-to ${STATE}`,
      url: "http://127.0.0.1:8787/",
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      // 本番と同じ経路(vinext build の出力を Workers ランタイムで動かす)。`next dev` で走らせると Workers で動くことを何も確かめない。
      // build はルートの `pnpm e2e:admin` が playwright の前に済ませる(global-setup.ts と同じ理由でここには置かない)
      // `--var` で wrangler.jsonc の本番値(AB_CONTROL_URL)をローカル control に上書きする。BFF は接続元 IP を control に転送しない(決定 35 (4))
      // `package.json` の `preview` と同じコマンド(生成設定のパスは scripts にだけある)
      command: `pnpm preview --var AB_CONTROL_URL:${CONTROL_URL}`,
      url: `${ADMIN_URL}/login`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  // invite-flow は publish-flow が作った owner / Site / 実験に依存するため、projects の dependencies で順序を固定する
  projects: [
    { name: "publish", testMatch: /publish-flow/, use: { browserName: "chromium" } },
    { name: "invite", testMatch: /invite-flow/, dependencies: ["publish"], use: { browserName: "chromium" } },
    { name: "audience", testMatch: /audience-flow/, dependencies: ["publish"], use: { browserName: "chromium" } },
    { name: "login-screen", testMatch: /login-screen/, dependencies: ["publish"], use: { browserName: "chromium" } },
    // testMatch は絶対パスに当たるので、ファイル名まで絞る(/write-freeze/ だけだと、チェックアウト先のディレクトリ名
    // 「…d13-write-freeze」にも当たり、e2e/ のすべてのファイル(fake-cf-api.mjs まで)を読み込んでしまう)
    { name: "write-freeze", testMatch: /write-freeze\.spec\.ts$/, dependencies: ["publish"], use: { browserName: "chromium" } },
  ],
});
