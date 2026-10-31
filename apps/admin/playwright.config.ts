import { defineConfig } from "@playwright/test";
import { ADMIN_URL, AUTH_SECRET, BREAK_GLASS_TOKEN, CONTROL_URL, E2E_RESULTS_VISITOR_KEY, SETUP_TOKEN, e2eWranglerEnv } from "./e2e/fixtures";

/**
 * admin の E2E。偽の Cloudflare API(8791)/ control + デプロイ専用の Worker(8799。1 プロセス)/ edge(8787)/ admin(3000)の 4 プロセスを起動して実際のブラウザで管理画面を操作し、
 * **control の Publish が設置タグの配信ファイルに現れる**ところまでを確認する(control → デプロイ専用の Worker → 偽の API。このプランの DoD 3)。
 *
 * 入口は必ずルートの `pnpm e2e:admin`。状態のリセット(`e2e/global-setup.ts`)は Playwright の `globalSetup` ではなく
 * その前段で走る — 理由は `e2e/global-setup.ts` のコメント参照。
 */
const STATE = "../control/.e2e-state"; // control と edge で共有(KV を共有するため)。edge の package ディレクトリからの相対

/**
 * wrangler の webServer に共通の設定(D9 ③ Task 17 の修正 1)。
 * - env: dev registry とログをこの実行の状態ディレクトリに閉じる(`e2eWranglerEnv`。理由は fixtures.ts)
 * - gracefulShutdown: 終わるときに SIGTERM で止め、wrangler に registry の登録を消させる(既定の SIGKILL だと古い登録が残る)
 */
const wranglerServer = (name: "control" | "edge" | "admin") => ({
  env: e2eWranglerEnv(name),
  gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
});

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
      // control と edge は各 app の wrangler(`pnpm exec`)で起動する。dev registry で互いの Durable Object を呼ぶプロセスどうしの
      // 版(workerd の build)が違うと RPC が落ちる疑いがあり(D9 ③ では版をそろえてから落ちなくなった)、wrangler の版は apps の
      // package.json でそろえてある(B92)。D9 ③ Task 17 の修正 1 では E2E の起動だけ admin の wrangler を使っていたが、版がそろったので外した。
      // `--var` は `.dev.vars` より優先される(wrangler 4.128.0 で実測。apps でそろえた 4.133.0 でも E2E の値で走ることを確認)。開発者のローカル `.dev.vars` があっても E2E 用の値で走る
      // URL 系 3 つも上書きする(wrangler.jsonc の vars は本番値)。
      // 決定 46: E2E は Google を呼べないので、非常用のパスワードログインを開けた状態で起動する(fixtures.ts の login())
      // 決定 52: デプロイ専用の Worker は 2 つ目の -c で同じプロセスに載せる(control の DEPLOYER が確実に繋がる。別プロセス + dev registry だと
      // RPC が「Network connection lost」になる実行があった)。その Worker の vars(偽の API の向き先・偽の鍵)は e2e/deployer.wrangler.jsonc に書く(--var は効かない)
      cwd: "../control",
      command: `pnpm exec wrangler dev -c wrangler.jsonc -c ../admin/e2e/deployer.wrangler.jsonc --port 8799 --persist-to .e2e-state --var AB_SETUP_TOKEN:${SETUP_TOKEN} --var BETTER_AUTH_SECRET:${AUTH_SECRET} --var AB_ADMIN_URL:${ADMIN_URL} --var AB_CONTROL_URL:${CONTROL_URL} --var AB_ASSET_PUBLIC_BASE:${CONTROL_URL}/dev-assets --var AB_EDGE_ORIGIN:https://wtt-edge.example.workers.dev --var AB_GOOGLE_CLIENT_ID:e2e-google-client-id --var AB_GOOGLE_CLIENT_SECRET:e2e-google-client-secret --var AB_BREAK_GLASS_TOKEN:${BREAK_GLASS_TOKEN} --var CF_USAGE_TOKEN: --var CF_ACCOUNT_ID:`,
      url: "http://127.0.0.1:8799/",
      ...wranglerServer("control"),
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      // control と同じディレクトリを指す(= 同じローカル KV と計測用 D1(wtt-results)を読む)。
      // D9 ③(plan ③ の K26): 結果の参加・CV を書くための訪問者の鍵を `--var` で渡す(edge のコードは変えない。無いと書かずに failed を返す)
      cwd: "../edge",
      command: `pnpm exec wrangler dev --port 8787 --persist-to ${STATE} --var RESULTS_VISITOR_KEY:${E2E_RESULTS_VISITOR_KEY}`,
      url: "http://127.0.0.1:8787/",
      ...wranglerServer("edge"),
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      // 本番と同じ経路(vinext build の出力を Workers ランタイムで動かす)。`next dev` で走らせると Workers で動くことを何も確かめない。
      // build はルートの `pnpm e2e:admin` が playwright の前に済ませる(global-setup.ts と同じ理由でここには置かない)
      // `--var` で wrangler.jsonc の本番値(AB_CONTROL_URL)をローカル control に上書きする。
      // BFF は control を service binding(wrangler.jsonc の services → build の出力の dist/server/wrangler.json)で呼び、
      // 接続元 IP を x-wtt-client-ip で渡す(plan12 K8)。binding の相手は、同じ WRANGLER_REGISTRY_PATH(wranglerServer)の dev registry に
      // 登録された上の control。起動の順は問わない(相手が居ない間は binding が 503 を返す)
      // `package.json` の `preview` と同じコマンド(生成設定のパスは scripts にだけある)
      command: `pnpm preview --var AB_CONTROL_URL:${CONTROL_URL}`,
      url: `${ADMIN_URL}/login`,
      ...wranglerServer("admin"),
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
    { name: "experiment-kind", testMatch: /experiment-kind-flow/, dependencies: ["publish"], use: { browserName: "chromium" } },
    { name: "results-settings", testMatch: /results-settings\.spec\.ts$/, dependencies: ["publish"], use: { browserName: "chromium" } },
    // plan12 K6: 版のバナー(/capabilities を差し替えて確かめるだけで、状態は変えない)
    { name: "version-banner", testMatch: /version-banner\.spec\.ts$/, dependencies: ["publish"], use: { browserName: "chromium" } },
    // B77: パターン UI と目標名(専用のサイトを作るので publish-flow の状態には触らないが、owner の setup は publish-flow が行う)
    { name: "variant-ui", testMatch: /variant-ui\.spec\.ts$/, dependencies: ["publish"], use: { browserName: "chromium" } },
    // D9 ③: 結果の記録の流れ(評価計画 → 開始 → edge への参加・CV → 結果のタブ → 終了と採用 → 複製の下書き)。専用のサイトを作る
    { name: "results-flow", testMatch: /results-flow\.spec\.ts$/, dependencies: ["publish"], use: { browserName: "chromium" } },
    // 管理画面の速さ: 主な画面(ホーム〜公開履歴の 11 画面)を開くときの control への要求の回数と上限(admin の wrangler dev の手元の観測で数える)。専用のサイトを作る
    { name: "request-count", testMatch: /request-count\.spec\.ts$/, dependencies: ["publish"], use: { browserName: "chromium" } },
    // 管理画面の速さ(最終レビュー CX-R1): 読み込み中の枠が、別のサイト・ワークスペースの上部バーを出さない。専用のサイト 4 つと、2 つ目のワークスペースを作る
    // 管理画面の速さ CE-R9: 書き込みの後の読み直しの反映の前に押した遷移・節の切り替えが、捨てられない・戻されない(読み直しを遅らせて窓を決まって作る)。専用のサイトを作る
    { name: "refresh-race", testMatch: /refresh-race\.spec\.ts$/, dependencies: ["publish"], use: { browserName: "chromium" } },
    { name: "shell-reuse", testMatch: /shell-reuse\.spec\.ts$/, dependencies: ["publish"], use: { browserName: "chromium" } },
    // 7o K14: 設置タグの配信ファイルの帯と全サイトの作り直し。偽の API を一時的に失敗にする(終わりに必ず戻す)。専用のサイトを作り、メンバーを 1 人招待する。
    // 失敗の窓がほかの project の公開に重ならないよう最後に置く(workers: 1 なので並んで走らない)
    { name: "static-delivery", testMatch: /static-delivery\.spec\.ts$/, dependencies: ["publish"], use: { browserName: "chromium" } },
  ],
});
