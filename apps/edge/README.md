# @wtt/edge — edge Worker

データプレーンの Worker。設定は KV(`CONFIG_KV`)だけを読む(control が Publish 時に書く)。テストの結果の記録は、計測用 D1(`RESULTS_DB` = `wtt-results`)に書く(下の「結果の記録」)。

## エンドポイント

| ルート | 内容 |
|---|---|
| (`GET /s/<siteId>.js`) | edge は返さない。bootstrap は配信専用の Worker が静的ファイルとして返す(control が Publish のたびに焼いて出し直す。`docs/deploy.md`) |
| `POST /v1/sites/:siteId/decision` | Mode A 直接経路。形式検証 → レート制限 → Origin 検証 → 評価。`needsProfile` なら URL 一致の部分集合を DO `VisitorProfile` に渡して 1 往復で評価。Experiment にも patterns にも不一致なら DO 非接触で空応答。DO 例外は 503 |
| `POST /v1/sites/:siteId/event` | `{ type: "goal", goalId, visitorId }` で Profile の達成回数を加算、`{ type: "forget", visitorId }` で Profile を削除(撤回時)。常に 204。`goal` は `needsProfile=false` / 未知 goalId で DO 非接触、`forget` は config に依存せず常に DO に届き、`forgetOnRevoke` が false でなければ計測用 D1 のその訪問者の行も消す。順序・レート制限・Origin は decision と同じ。結果の送信 `{ type: "participant" \| "conversion", … }` は常に 200 + 本文 `{ result: "stored" \| "ignored" \| "stopped" \| "failed" }`(下の「結果の記録」) |
| `OPTIONS /v1/sites/:siteId/{decision,event}` | CORS preflight |
| `POST /__ab/decision` | Mode B(サーバー発行 Cookie、旧称 D-lite)の decision。応答に訪問者 ID の短いハッシュ `vh`(runtime の送信済みの印に使う)を足す。revoke は Profile の DO に非接触で、`forgetOnRevoke` が false でなく正本 Cookie があれば計測用 D1 のその訪問者の行を消す |
| `POST /__ab/event` | Mode B の event。Cookie が Identity。Cookie 無し・不正は Cookie を発行せず DO 非接触で 204。結果の送信は Mode A と同じ判定・同じ応答(CORS なし) |

## 結果の記録

結果を記録するサイト(compiled config に `results` がある)の runtime が、テストの参加(`participant`)と目標の達成(`conversion`)を `/event` に送る。edge は D1 に書く前に、active な config の `results.runs`・実験・パターン・訪問者 ID から計算した割当(`pickVariant`)・収集の締め切り(settings の `resultsCollectUntil`)・目標を照合し、合わないものは書かずに `ignored`(変わらない理由なら `retry: false`)を返す。時刻は edge の受信時刻。

| binding / 設定 | 内容 |
|---|---|
| `RESULTS_DB`(D1 `wtt-results`) | 個票の表 `participants` と `conversions`。マイグレーションは `results-migrations/`(表の形の正はここ。control は同じファイルをテストで当てる)。`pnpm -C apps/edge results:migrate:local` / `results:migrate:remote`。リポジトリの `database_id` は仮の値で、導入では `wrangler d1 create wtt-results` の値に書き換える |
| `RESULTS_VISITOR_KEY`(secret) | `visitor_key = HMAC-SHA-256(鍵, siteId + ":" + visitorId)` の先頭 16 バイトを書く(訪問者 ID そのものは置かない)。鍵は base64 で、復号して 32 バイト以上。無い・読めない・短いときは書かずに `failed` を数える(fail-closed。ログは isolate ごとに 1 回)。ローカルの `wrangler dev` は `.dev.vars.example` を `.dev.vars` に写して値を入れる(sample-site の E2E は playwright の設定が `--var` で固定値を渡す) |
| `RESULTS_BUDGET`(DO `ResultsBudget`) | 結果の書き込み・読み取りの 1 日(UTC)の予算と停止。導入全体で 1 つ(`idFromName("global")`)。isolate は書く前に枠(既定 200 行)を受け取り、`meta.rows_written` で精算する。予算を使い切る・D1 の日次上限のエラー・control の Cron の使用量の判定で止まり、次の UTC 0 時まで `stopped` を返す。DO に届かないときは `failed`(停止ではない) |
| `RESULTS_HEALTH`(DO `ResultsHealth`) | 書けなかった送信を run × UTC の時で数える。サイトごと(`idFromName(siteId)`)。isolate がメモリで合算し、DO を呼ぶのはサイトごとに 1 分に 1 回まで |
| vars `RESULTS_WRITE_BUDGET` / `RESULTS_READ_BUDGET` / `RESULTS_LEASE_ROWS` | 予算の値(既定 `"70000"` / `"3000000"` / `"200"`)。正の整数の文字列。`"0"`・数でない値・省略は既定値になる |

- 書き込みは 1 要求 = 1 回の `batch`。参加は 1 batch で最大 3 行、目標の達成は run 1 つあたり最大 3 行を枠の見込みにする(`@wtt/core` の `RESULTS_ROWS`。インデックスの書き込みを含む実測の最大 + 1)
- 撤回(Mode A の `forget`・Mode B の consent の revoke)で消す行は少ないので、予算の枠を使わない
- control は同じ `wtt-results` を binding `RESULTS_DB` で読み(結果の集計)、保持期限・エクスペリエンスやサイトの削除・孤児の個票を消す(edge は消さない。撤回だけ)。control は `ResultsBudget` を script 間の binding で呼び、Cron の停止(`stop`)・削除の書き込みの枠(`lease`)・集計の読み取りの予約(`reserveRead` / `settleRead`)・予算と停止の状態(`status` / `stopPeriods`)を使い、`ResultsHealth` の `read` で失敗の数を読む。そのため edge を control より先にデプロイする
- 収集の締め切り(settings の `resultsCollectUntil`)は control が評価時点から計算して KV の Site の設定に書く。edge は受信時刻が締め切り以降の参加・CV を書かずに `ignored`(`retry: false`)を返す

## ローカルでの動作確認

edge 自体は runtime を持たない。ただし `pnpm edge:seed`(fixture CLI)と E2E は `packages/runtime` のビルド成果物を bootstrap に焼くため、**先に `pnpm runtime:build` が必要**(runtime を変更した直後は特に)。`pnpm edge:dev` と `pnpm e2e` はこれを自動実行するので、単体で叩く場合を除き手動で呼ぶ必要はない。

    pnpm runtime:build   # packages/runtime をビルドし packages/runtime/generated/source.ts に焼き込む(サイズ予算 + zod 不在チェック込み)
    pnpm edge:seed       # fixtures/*.json → compile → ローカル KV(--local)へ bulk put
    pnpm edge:dev        # runtime:build → wrangler dev(http://localhost:8787)

E2E は `pnpm e2e` 一発で完結する: `runtime:build` → fixture seed → 静的サンプルサイト(`http://localhost:4173`)+ 同一オリジンプロキシ(`/s` は fixture CLI が焼いたファイル(`packages/sample-site/.static`)を配信専用の Worker の代わりに返し、`/v1` `/__ab` は wrangler dev へ転送)を起動 → Playwright 実行。

- bootstrap: edge は返さない。`pnpm edge:seed` が焼いたファイルは `packages/sample-site/.static/s/site_demo.js`(E2E のサーバーが `http://localhost:4173/s/site_demo.js` で配る)
- Mode A decision(Origin は demo settings の allowedOrigins に一致させる):

      VID=$(pnpm exec tsx -e "import('./packages/core/src/index.ts').then(m=>console.log(m.generateVisitorId()))")
      curl -s -X POST http://localhost:8787/v1/sites/site_demo/decision \
        -H 'Origin: http://127.0.0.1:8080' -H 'Content-Type: application/json' \
        -d "{\"v\":1,\"url\":\"http://127.0.0.1:8080/\",\"referrer\":\"\",\"device\":\"desktop\",\"visitorId\":\"$VID\"}"

- Mode B の経路は `site_demo_dlite`(mode B、hosts に `localhost`)に対して動く。`site_demo` は Mode A なので `/__ab/*` では 404:

      curl -si -X POST http://localhost:8787/__ab/decision -H 'Content-Type: application/json' \
        -d '{"v":1,"url":"http://localhost/","referrer":"","device":"desktop"}' | grep -i -e '^set-cookie' -e '"experiments"'

## デプロイ(実環境)

運用者向けの手順は `docs/deploy.md`(本節は開発者向けの要点)。

0. edge は bootstrap を配らないので runtime のビルドは要らない(runtime の更新はデプロイ専用の Worker が焼き直す)
1. `pnpm -C apps/edge exec wrangler kv namespace create wtt-config` で KV を作り、`wrangler.jsonc` の `kv_namespaces[0].id` を差し替える
2. `pnpm -C apps/edge exec wrangler deploy`。**core のスキーマにフィールドを足したときは、この再デプロイを先に済ませてから新しい形の record を KV に書く。** `SiteSettingsSchema` / `CompiledConfigSchema` は `z.strictObject` で未知フィールドを拒否するため、逆順にすると旧 edge が record を parse できず当該 Site の decision / event が 404(fail-closed)になる。 Analytics 命名設定の `analytics`(site-settings)/ `exposurePayloads`(compiled config)がこの順序を要する最初の実例 — 該当 Site の record を fixture CLI で書き直す前に、この変更を含む edge をデプロイしておく

   2a. **初回デプロイは DO の migration(`wrangler.jsonc` の `migrations[].tag` = `"v1"`(`VisitorProfile`)と `"v2"`(`ResultsBudget`・`ResultsHealth`)。どれも `new_sqlite_classes`)を含む。** `wrangler deploy` が自動で適用する。以後 class 名を変えない限り tag を増やさない。デプロイの前に計測用 D1 を作り(`database_id` を書く → `results:migrate:remote`)、secret `RESULTS_VISITOR_KEY` を入れる(`docs/deploy.md` 2.2)。control は `ResultsBudget` を script 間の binding で参照するので、edge を先にデプロイする。core に `retentionDays` / `forgetOnRevoke` が増えたので、**この edge を先にデプロイしてから** control(migration 0004 + 再デプロイ)を更新する(手順の順序規則)

   2b. `needsProfile` の Site を持つゾーンは `wrangler.jsonc` の `routes` に `<site-domain>/v1/*` → `wtt-edge` を追記してデプロイする。WAF ルールとしきい値の指針は `docs/deploy.md` の「2.7 WAF Rate Limiting Rule(推奨)」
3. 公開アドレスを与える。既定はゾーンに紐づく公開(ゾーンの WAF Rate Limiting Rule と Cache Rule を掛けられる)。`*.workers.dev` はドメインなし構成として選べる(`docs/deploy.md` 1 節の制約表)。ゾーンに載せるならカスタムドメインでも既存ゾーンの Workers Route(`<site-domain>/v1/*`)でもよい。**Route なら decision / event が同一オリジンになり CORS も DNS・証明書の追加も要らない**(bootstrap の `/s/*` は配信専用の Worker の Route。`docs/deploy.md`)。Route を張る前に、そのパス配下に既存コンテンツが無いことを実 URL で確認する
4. Mode B を使う Site: 対象ゾーンに Workers Route `<site-domain>/__ab/*` → `wtt-edge` を追加し、KV にホスト対応(`host:<hostname>` → siteId)と site-settings record があることを確認する。これらは control(`apps/control`)の Site 設定(mode = B、hosts)から Site 作成 / 更新時に投入される(`docs/deploy.md`)。fixture CLI(`pnpm fixture`)は E2E / ローカル開発専用で、本番 KV への投入には使わない
5. **`routes` を `wrangler.jsonc` に書いたら `"dev": { "host": "localhost" }` も併記する(2026-09-02 実測)。** `routes` があると `wrangler dev` のローカル origin host が route のホスト名になる(`--local-upstream` の既定が「dev.host or route」)。host から Site を引く Mode B の経路がローカルで 404 になり、`pnpm e2e` が dlite の 3 件で落ちる
6. Rate Limiting binding は wrangler >= 4.36 が必要。`namespace_id` はアカウント内で一意な整数文字列(既定 "1001")
7. `/__ab/*` の保護は運用者ゾーンの WAF / レート制限ルールに委ねる(任意)

## 既知の制約

- **SPA の `pushState` では再評価しない。** runtime は DOM の `MutationObserver` で変更対象要素の再出現(フレームワークによる再描画で戻された場合)には追随して再適用するが、URL だけが変わって新しいコンテンツが挿入される SPA 遷移そのものを検知して条件を再評価する仕組みは無い。フルリロードを跨ぐ遷移でのみ新しい評価が走る
- **React・Vue 等のフレームワークが管理する要素は、フレームワーク側の再レンダリングで書き換えが戻ることがある。** runtime は MutationObserver で再適用を試みるが、フレームワークの仮想 DOM 差分がそれより高頻度・高優先度で走るケースでは打ち勝てない
- **CUSTOM_JS と HTML 内の `<script>` はページ読込ごとに 1 回だけ実行される。** SPA の再描画で要素が作り直されても HTML の DOM 挿入だけが再適用され、`<script>` は不活性のまま挿入される。CUSTOM_JS は再実行されない。consent の撤回 → 再許可でも再実行されない
- **CSS Change は prehide の対象外。** `<style>` は decision 後に注入されるため、CSS だけで見た目を変える実験はチラつく可能性がある。Exposure は対照・処理群とも起動直後に出る(compile が `exposureSelectors` に `:root` を足す)
- **Trusted Types(`require-trusted-types-for 'script'`)を強制するサイトでは HTML / CUSTOM_JS が動かない。** CSP の nonce は引き継ぐが、Trusted Types のポリシーは提供しない。その例外は当該 Change だけの失敗として隔離され、他の Change は動く(`docs/site-install.md`「Code Change と CSP」)
- **適用済みの Change は撤回(consent の revoke)で元に戻さない。** HTML 挿入 / CSS / CUSTOM_JS は原理的に巻き戻せないため
- **DO は列挙できないため、Site 削除時に Visitor Profile は即時削除されない**(retention の alarm で自然に消える)
- settings record に `retentionDays` / `forgetOnRevoke` が無い間(Visitor Profile の設定項目が入る前に作った Site を、その後に一度も保存していない間)、edge は既定の 90 / true を使う(D1 の値と食い違う)
- Profile の `assignments` / `goals` は Experiment / Goal を削除しても retention まで残る(掃除されるのは patterns のみ)
