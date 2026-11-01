# @wtt/control — control Worker

コントロールプレーンの Worker。D1(`DB`)を正本に、KV(`CONFIG_KV`)と R2(`ASSETS`。任意 — binding が無い導入では画像機能を無効にする)へ書く。
テストの結果は、計測用の D1(`RESULTS_DB` = `wtt-results`。edge が書く個票)を読み取りと削除にだけ使い、評価計画・結果の記録・採用は `DB` に持つ。
計測用 D1 の表の形の正は edge の `results-migrations/`(`wrangler.jsonc` の `migrations_dir` はローカルの開発・vitest・E2E のため。本番への適用は edge の `results:migrate:remote` だけ)。
`RESULTS_DB` の binding が無い導入では、結果の記録を有効にできず(409 `results_store_missing`)、結果の API は `collection: "store_missing"` を返す。
edge(`apps/edge`)は KV を読むだけで、control とは直接つながらない。設置タグのファイル(`/s/<siteId>.js`)は edge ではなく、配信専用の Worker(`wtt-static`。静的アセット)が配る。control は公開・設定の保存のたびに、デプロイ専用の Worker(`apps/deployer`、`wtt-deployer`。Service Binding `DEPLOYER` の RPC)へ配信ファイルの作り直しを頼む。デプロイ用のトークンを持つのはデプロイ専用の Worker だけで、control は持たない。

- 認証は Better Auth(Bearer。セッショントークンと API キー `wtt_…` が同じ入口)。人のログインは Google アカウントで、
  メール + パスワードの経路は非常用トークン(`AB_BREAK_GLASS_TOKEN`、16 文字以上)を置いているあいだだけ開く。
  ログイン状態を持てるのは「どこかの Workspace の Member」か「自分のメールアドレス宛ての有効な招待がある人」だけで(判定は `src/access.ts`)、
  Member から外す・招待を取り消すと、その人のログイン状態はその場で切れる。
- **認可判定は `src/roles.ts` の外に書かない**(`loadSite` / `requireWorkspaceRole`。システム管理者の判定 `actsAsInstanceAdmin` / `assertCanTouchInstanceAdmin` も同じ)。非メンバーは常に 404、Role 不足は 403。
- エラーは常に封筒 `{ error, message, hint?, path?, …details }`(`src/errors.ts`)。`/auth/*` は Better Auth 自身の形式なので対象外。
- 契約は `GET /openapi.json` が唯一の正本。ルート定義の zod から生成し、手書きしない。

### 書き込みの凍結と版のヘッダー

- 書き込みの凍結: D1 の `instance_settings` のキー `writeFreeze` に行があるあいだ、`/auth/*`・`/break-glass/*`・`POST /sites/:sid/evaluate` 以外の POST / PUT / PATCH / DELETE を `503 write_frozen` で断る(`src/write-freeze.ts`。行が読めなくても凍結中)。入切は `docs/deploy.md` 6.6。GET に伴う業務データの書き込み(`GET /sites/:sid` の配信の写しの自己修復と、設置タグの配信ファイルの自己修復(`reconcileStatic`)など)は `isWriteFrozen()` で凍結中かを確かめ、凍結中は見送る。Cron(下の「Cron」)と、後から足す自己修復も同じ関数を使う。`/auth/*` が開くパスの一覧は `src/auth-paths.ts`(業務の書き込みを足すと凍結から素通しになる)
- 版のヘッダー: 全応答に `x-wtt-api-version`(`@wtt/core` の `API_CONTRACT_VERSION`)。管理画面は `x-wtt-client-version` を付けてくる。今は判定しない

### Cron

- Cron Trigger は 1 本だけ(`*/15 * * * *`。`wrangler.jsonc` の `triggers`)。ジョブは `src/cron/jobs.ts` の登録表に足し、Trigger は増やさない(Cron Trigger の数はアカウント単位の上限がある)。実行の枠は `src/cron/runner.ts`
- ジョブの形 = `{ name, cadence: { every: "tick" } | { daily: { afterUtcHour } }, writesControl, run(ctx) }`。1 回の実行でジョブを登録の順に 1 本ずつ走らせ、1 本の例外はほかのジョブを止めない(どのジョブも冪等に作る)。`daily` は UTC のその時以降の最初の実行で 1 日 1 回動き、成功を `cron_job_runs` に記録する(失敗・凍結で見送った日は次の実行で取り直す)。`daily` は `writesControl: true` に限る
- 書き込みの凍結: 実行の最初に 1 回凍結を読み、`writesControl: true` のジョブは凍結中なら丸ごと見送る。さらにジョブは `wtt-control` に書く区切りの直前に毎回 `ctx.assertNotFrozen()` を呼び、凍結中ならそこで止まる(残りは次の回)。`writesControl: false` のジョブは凍結中も動く
- 今のジョブ(登録の順):
  - `results-account-guard`(毎回・`writesControl: false`)。使用状況(`getUsage`)で、Free のアカウント全体の Workers のリクエストか D1 の書き込みの行数が日次上限の 8 割以上なら、edge の `ResultsBudget`(binding `RESULTS_BUDGET`。`script_name: "wtt-edge"`)に `stop("account_usage", 次の UTC 0 時)` を立てる。使用量が取れない・Paid・binding が無いときは何もしない(ログだけ)
  - `results-delivery`(毎回): 配信の確認を待つ届く定義の行がある Site について、デプロイ専用の Worker に配った世代を問い合わせ、配信を確かめた行に `delivered_from` を入れる(テスト中の変更もここで記録する)
  - `results-collect-until`(毎回): 印(`sites.collect_until_dirty`)の付いた Site と、KV の締め切りの表が D1 から計算した値と違う Site の、KV の Site の設定の `resultsCollectUntil` を書き直す
  - `results-daily`(UTC 0 時以降に 1 日 1 回): 目標参加者数の到達の確認 → 評価時点の記録 → 評価時点の前に終了したテストの終了の記録の補完
  - `results-capacity`(毎回): 計測用 D1 の大きさを測って保存し、95% 以上なら `ResultsBudget` に `stop("capacity", …)` を立てる(UTC 23 時台の削除を終えるまでは立てない)
  - `results-purge`(UTC 23 時以降に 1 日 1 回): 保持期間を過ぎた個票 → 削除待ち(`results_purge_queue`)の run → 対応する run の無い個票(孤児)の削除。書き込みの予算の残りの範囲で `ResultsBudget.lease` を受けてから消す
- 1 回の実行の D1 の問い合わせは 40 まで(`QUERY_LIMIT`。Free の 1 回の起動あたり 50 から runner と予備を残した値)を、各ジョブの配分(`queryShare`)で分け合う。配分は `allotQueries`(`src/cron/runner.ts`。1 日 1 回のジョブがある実行では 15 分の枠ごとに優先を入れ替える)。配分を使い切ったジョブは `{ more: true }` を返し、同じ日の次の実行で続ける。各ジョブは処理した位置を `cron_cursors` に持つ
- `RESULTS_BUDGET`・`RESULTS_HEALTH` は edge の Durable Object を参照するので、`ResultsBudget`・`ResultsHealth` を含む edge を先にデプロイしないと control をデプロイできない

## ルート

`Role` は必要な最小 Role。`—` は認証不要。

### 認証・セットアップ

| ルート | Role | 内容 |
|---|---|---|
| `POST /setup` | — | 初回セットアップ。システム管理者(最初のオーナー)と最初のワークスペースを作る(`x-setup-token`。user が 1 件でもあれば拒否)。パスワードは受け取らず、セッションも返さない |
| `GET /auth/google/start` | — | Google ログインの入口。管理画面が開く top-level 遷移で、Google の認可画面へ 302 |
| `GET /auth/callback/google` | — | Google からの戻り。成功なら使い捨てコードを付けて管理画面へ 302(control のオリジンにセッション Cookie を残さない) |
| `POST /auth/handoff/exchange` | — | 使い捨てコードをセッショントークンに引き換える(管理画面のサーバー側が呼ぶ。1 分・1 回限り) |
| `GET /login-options` | — | この導入で使えるログイン方法 `{ google, passwordLogin }`(ログイン画面は認証前なので `/capabilities` を読めない) |
| `POST /break-glass/reset-link` | — | 非常時に OWNER のパスワード再設定リンクを発行(非常用トークン + OWNER のメール。条件を満たさない要求はすべて 404) |
| `POST /auth/sign-in/email` ほか | — | Better Auth のパススルー(`sign-in/email` `sign-out` `sign-up/email` `get-session` `request-password-reset` `reset-password` のみ公開)。**このうちパスワードを使う 4 経路は非常用トークンがあるときだけ開き、普段は 404** |
| `GET /capabilities` | 認証のみ | この導入で使える機能 `{ imageUpload, edgeOrigin, tagOrigin, edgeOnWorkersDev, passwordLogin, resultsStore, writeFreeze }`(R2 と公開ベースの有無、edge の公開 origin、設置タグを配る origin、パスワードログインが開いているか、計測用 D1(`RESULTS_DB`)の binding があるか、書き込みの凍結の状態) |
| `GET /me` | 認証のみ | 現在のセッション(または API キー)の持ち主 |
| `GET /me/api-keys` | 認証のみ | 自分の API キー一覧(平文は含まない) |
| `POST /me/api-keys` | 認証のみ | API キーを発行(平文はこの応答限り)。範囲 `workspaceId` は必須(`null` = フルはシステム管理者のみ)。非常用のパスワードログインのセッションからは 403 `password_session` |
| `DELETE /me/api-keys/:kid` | 認証のみ | API キーを失効(他人の鍵は 404) |

### Workspace / Member / 招待

| ルート | Role | 内容 |
|---|---|---|
| `GET /workspaces` | 認証のみ | 自分が所属する Workspace(Role 付き) |
| `POST /workspaces` | システム管理者 | ワークスペースを作る(システム管理者全員がオーナー)。それ以外・上限付きの API キーは 403 `forbidden` |
| `DELETE /workspaces/:wid` | システム管理者 | Workspace を削除。最後に残った 1 つは削除できない(409 `last_workspace`)。実行中のエクスペリエンスがあれば 409 `workspace_has_running_experiments`。配下のサイトの ID は、削除と同じ処理の中で D1 のトリガーが `retired_site_ids` に残し、以後はシステム管理者だけが作り直せる(`POST /workspaces/:wid/sites` の 409 `site_id_taken`) |
| `GET /workspaces/:wid/members` | ADMIN | Member 一覧 |
| `PATCH /workspaces/:wid/members/:memberId` | ADMIN | Role 変更(owner の付け外しは OWNER のみ)。システム管理者は 409 `instance_admin_member` |
| `DELETE /workspaces/:wid/members/:memberId` | ADMIN | Member を外す(owner を外せるのは OWNER のみ)。システム管理者は 409 `instance_admin_member` |
| `POST /workspaces/:wid/members/:memberId/reset-link` | ADMIN | パスワード再設定リンクを発行(OWNER 宛は OWNER のみ。システム管理者宛はシステム管理者のみで、そうでなければ 403)。パスワードログインが閉じているときは 409 `password_login_disabled` |
| `POST /workspaces/:wid/invitations` | ADMIN | 招待リンクを発行(メールは送らず url を返す)。同じ宛先に有効な招待があり Role が同じなら期限を 7 日後まで延ばして `extended: true` と同じ url を返し、Role が違えば 409 `already_invited` で何も変えない。既にそのワークスペースのメンバー(システム管理者を含む)宛ては 409 `already_member` |
| `GET /workspaces/:wid/invitations` | ADMIN | まだ受けられていない招待の一覧(受諾済み・取り消し済みは出ない) |
| `DELETE /workspaces/:wid/invitations/:id` | ADMIN | 招待を取り消す(リンクが使えなくなる。すでに受諾済み・取り消し済み・別 Workspace の ID は 404) |
| `GET /invitations/:id` | — | 招待の内容(受諾画面が表示するぶんだけ) |
| `POST /invitations/:id/accept` | — | 招待を受諾(Bearer 付き = ログイン済みの本人が参加)。Bearer 無しの「その場でアカウントを作って参加」はパスワードログインが開いているときだけで、普段は 401 |
| `GET /instance-admins` | システム管理者 | システム管理者の一覧。各行に、外したときに戻るワークスペースとロール(`priorRoles`) |
| `GET /instance-admins/candidates` | システム管理者 | システム管理者にできる人(どこかのワークスペースのメンバーで、まだシステム管理者でない人)の一覧 |
| `POST /instance-admins` | システム管理者(セッションのみ) | どこかのワークスペースのメンバーをメールアドレスでシステム管理者にする(全ワークスペースのオーナーになる。メンバーでなければ 404) |
| `DELETE /instance-admins/:userId` | システム管理者(セッションのみ) | システム管理者から外す(システム管理者になる前に参加していたワークスペースでは元のロールに戻り、それ以外のワークスペースからは外れる。`?restore=false` なら元のロールに戻さず、すべてのワークスペースから外す)。最後の 1 人は 409 `last_instance_admin` |

### Site

| ルート | Role | 内容 |
|---|---|---|
| `GET /workspaces/:wid/sites` | VIEWER | Workspace 配下の Site 一覧 |
| `POST /workspaces/:wid/sites` | ADMIN | Site を作成(計測用 D1 の binding があれば「結果を記録する」を有効で作る)。削除した Site の ID は、そのサイトがあった Workspace でだけ作り直せる。別の Workspace からは 409 `site_id_taken`。元の Workspace を見られる人(その Workspace のメンバー。多くの場合はシステム管理者)にだけ `reason: "retired_elsewhere"` と詳しい文を返し、見られない人には今ある Site と同じ応答(`reason` なし)を返す。Workspace ごと削除した Site の ID は、システム管理者だけが作れる(D1 のトリガーが別の Workspace の INSERT を断る) |
| `GET /sites/:sid` | VIEWER | Site 1 件(+ `hasUnpublishedChanges` / `activeKvStale` / `staticStale` / `staticRemoving` / `resultsCapacity`(計測用 D1 の大きさと `ok` / `warning`(80% 以上)/ `stopped`(95% 以上))) |
| `PATCH /sites/:sid` | ADMIN | Site 設定を更新(Identity / Analytics 命名は KV 即時反映で Publish 不要)。`resultsEnabled`(結果を記録する。切り替えは未公開の変更に数え、次の Publish で効く)と `resultsRetentionDays`(個票の保持期間 7〜365 日、既定 90)。計測用 D1 の binding が無い導入で無効 → 有効にすると 409 `results_store_missing` |
| `DELETE /sites/:sid` | OWNER | Site を削除(KV の settings / host / active / config と R2 の画像(binding があるとき)も消す)。削除した Site の ID は `retired_site_ids` に残し(D1 のトリガー。期限なし)、別の Workspace では使えなくなる。同じ ID で作り直しても、削除した Site の結果の消去の待ち行列(`results_purge_queue`)は取り消さない |

### オーディエンス / Goal

| ルート | Role | 内容 |
|---|---|---|
| `GET /sites/:sid/audiences` | VIEWER | オーディエンス一覧(参照しているエクスペリエンス `usedBy` を含む) |
| `POST /sites/:sid/audiences` | EDITOR | 作成(定義は正規化して保存。参照する Goal の存在と、期間が保存期間以下であることを検査) |
| `GET /sites/:sid/audiences/:aid` | VIEWER | 1 件 |
| `PATCH /sites/:sid/audiences/:aid` | EDITOR | 更新(id は不変。定義の変更は次の Publish で参照するすべてのエクスペリエンスに効く) |
| `DELETE /sites/:sid/audiences/:aid` | EDITOR | 削除(参照するエクスペリエンスがあれば 409) |
| `GET /sites/:sid/goals` | VIEWER | Goal 一覧 |
| `POST /sites/:sid/goals` | EDITOR | 作成(config は type ごとに検証) |
| `PATCH /sites/:sid/goals/:gid` | EDITOR | 更新(name / config のみ。type は不変) |
| `DELETE /sites/:sid/goals/:gid` | EDITOR | 削除(参照するエクスペリエンスかオーディエンスがあれば 409) |

### Experiment / Variant / Change

| ルート | Role | 内容 |
|---|---|---|
| `GET /sites/:sid/experiments` | VIEWER | Experiment 一覧 |
| `POST /sites/:sid/experiments` | EDITOR | 作成(`kind` = test はパターン a / b を 50 / 50、single はパターン a を重み 100 で自動作成)。一度開始してから削除したエクスペリエンスの ID は 409 `id_taken` |
| `GET /sites/:sid/experiments/:eid` | VIEWER | 1 件(Variant と Change を含む) |
| `PATCH /sites/:sid/experiments/:eid` | EDITOR | 更新(id は不変、status は `/status` 経由)。開始後のテストで配信率を下げる・`persistAssignment` を変えると 409 `test_setting_locked`。終了したテストは `description` だけの更新以外 409 `experiment_archived_readonly` |
| `DELETE /sites/:sid/experiments/:eid` | EDITOR | 削除(draft / archived のみ)。一度開始したエクスペリエンスの ID は、削除しても使い直せない(`retired_experiment_ids` に残し、同じ ID の作成・複製は 409 `id_taken`)。`run_id` を持つものは、削除と同じ batch で `results_purge_queue` に積み、応答の後に個票を消し始める(残りは Cron)。評価計画・結果の記録・採用は CASCADE で消える |
| `PUT /sites/:sid/experiments/:eid/variants` | EDITOR | Variant を全置換(test は 2 つ以上・single は 1 つ・weight 合計 100。draft のみ。終了したテストは 409 `experiment_archived_readonly`) |
| `PUT /sites/:sid/experiments/:eid/variants/:vid/changes` | EDITOR | Change を全置換(1 件でも保存時検証に落ちれば何も書かない。終了したテストは 409 `experiment_archived_readonly`) |
| `POST /sites/:sid/experiments/:eid/duplicate` | EDITOR | 複製(下書きを作る。mode = same / variant。`runId` は写さない)。`same` のテストは評価計画も写す。`variant` は配信を確かめた届く定義の変更を写す(無ければ保存済みの変更)。退役した ID は 409 `id_taken` |
| `POST /sites/:sid/experiments/:eid/status` | ADMIN | status 遷移(成功した遷移は必ず Site を自動 Publish)。テストの開始(`draft → running`)で、Site が結果を記録し計測用 D1 の binding があれば、評価計画を検査して(判定に使う目標が無い・基準の重みが 0 は 422 `evaluation_plan_incomplete`)固定し、`runId`(結果の記録の ID)を振る。再開では振らない。結果を記録しないテストの開始は応答の `warnings` に `path: "results"` を足す。テストの終了に `adoption` を付けられ、公開の後に終了の記録と採用を同じ batch で書く(失敗は 200 で `results.recorded: false`。Cron が記録を補う) |
| `GET /sites/:sid/experiments/:eid/evaluation-plan` | VIEWER | 評価計画(既定値で埋めた形)・固定の有無・評価時点の見込み・注意・変更の履歴。パーソナライズは 404 `results_not_applicable` |
| `PUT /sites/:sid/experiments/:eid/evaluation-plan` | EDITOR | 下書きは全体、開始後は評価時点の前に延ばす向きだけ(409 `evaluation_plan_locked` / `evaluation_already_fixed`、終了は 409 `experiment_archived_readonly`)。到達を確かめる読み取りが断られたら 503 `results_read_unavailable`。未公開の編集に数えない |
| `GET /sites/:sid/experiments/:eid/results` | VIEWER | 結果(速報・評価時点の記録・評価時点前の終了の記録)。速報は読み取りを予算の DO に予約してから集計し、5 分は保存した値を返す。評価時点を過ぎたら記録を作って返す。下書きは 409 `results_not_started`、パーソナライズは 404 `results_not_applicable` |
| `PUT /sites/:sid/experiments/:eid/adoption` | ADMIN | 終了したテストの採用を記録・上書き(終了していなければ 409、パーソナライズは 422。どちらも `adoption_not_allowed`) |

### Publish

| ルート | Role | 内容 |
|---|---|---|
| `POST /sites/:sid/publish` | ADMIN | Publish(失敗も 200 + `ok:false`)。成功の結果の `staticDeploy`(`deployed` / `pending` / `skipped`)が設置タグの配信ファイルの更新の状態。compiled config の `results`(結果を記録する Site の running / paused のテストの `runId`。個票が残っている間は forget のために出し続ける)は Publish の経路でだけ足し、公開した収集の状態が変わったら `results_collection_log` に記録する |
| `POST /sites/:sid/static/redeploy` | ADMIN | 設置タグの配信ファイルを今の公開内容で作り直す(更新が済んでいないとき、削除が途中で止まったとき。結果 `{ staticDeploy }`) |
| `GET /sites/:sid/publish-preview` | VIEWER | 前回 activation 以降に変わった Experiment / Change |
| `GET /sites/:sid/publishes` | VIEWER | 公開履歴(新しい順・最大 100 件) |
| `GET /sites/:sid/publishes/:version` | ADMIN | その version の compiled config |

### Asset(R2)

| ルート | Role | 内容 |
|---|---|---|
| `POST /sites/:sid/assets` | EDITOR | 画像を R2 へ(multipart: `file` / `experimentId`)。201 `{ id, publicUrl, mime, size, key }` |
| `GET /sites/:sid/assets` | VIEWER | Site(`?experimentId=` で絞る)配下の画像一覧 |
| `GET /dev-assets/*` | — | R2 の画像をそのまま返す(認証なし)。**`AB_ASSET_PUBLIC_BASE === ${AB_CONTROL_URL}/dev-assets` のときだけ有効**で、それ以外は 404。ローカル開発のほか、R2 のバケットに公開ドメインをつながずに始める本番の構成(`docs/deploy.md` 3.2 の (3))でも使う。返すのはアップロードした画像だけで、画像はもともと訪問者に公開するもの |

受理する MIME は `image/png` / `image/jpeg` / `image/gif` / `image/webp` / `image/avif` で、**宣言(multipart の Content-Type)と先頭バイトの両方**が一致したものだけ。
SVG は `<script>` を含みうるので MVP では受けない。画像以外は 415 `unsupported_media_type`、`AB_ASSET_MAX_MB`(既定 5)超は 413 `asset_too_large`、`experimentId` 不明は 404。
R2 のキーは `sites/<sid>/experiments/<eid>/<assetId>.<ext>`。IMAGE Change の `src` に指定できるのは `AB_ASSET_PUBLIC_BASE/sites/<sid>/` 配下だけ(`src/validation.ts`)。

**R2 なし構成**(`r2_buckets` が無い、または `AB_ASSET_PUBLIC_BASE` が http(s) の URL でない)では `POST /sites/:sid/assets` = 409 `image_upload_disabled`、IMAGE Change の保存 = 422 同コード(配下検査より先)、`GET /sites/:sid/assets` = `[]`、`GET /dev-assets/*` = 404。判定は `src/capabilities.ts` の `imageStore()` 1 か所。

### エージェント面

| ルート | Role | 内容 |
|---|---|---|
| `POST /sites/:sid/evaluate` | VIEWER | 割当の what-if(`reason` で出ない理由を返す。KV / DO / edge には触れない) |
| `GET /sites/:sid/experiments/:eid/draft-bootstrap` | VIEWER | 下書きの bootstrap JS(この Experiment だけを running として compile + bake) |
| `GET /sites/:sid/experiments/:eid/analytics-recipe` | VIEWER | 結果を読むためのクエリ(GA4 Data API リクエストと BigQuery SQL。数値は返さない) |

### 契約

| ルート | Role | 内容 |
|---|---|---|
| `GET /llms.txt` | — | エージェント向けガイド(`docs/agent-guide.md` の写し。認証不要) |
| `GET /openapi.json` | — | OpenAPI 3.1。エラーは全ルートが `#/components/schemas/ErrorEnvelope` を参照する |
| `GET /` | — | `wtt-control`(疎通確認) |

## ローカル起動

`.dev.vars`(git 管理外)に秘密を置く:

    BETTER_AUTH_SECRET=<32 バイト以上のランダム文字列>
    AB_SETUP_TOKEN=<初回セットアップ用の使い捨てトークン>

雛形は `.dev.vars.example`。D1 を用意してから起動する。`vars`(`AB_CONTROL_URL` / `AB_ASSET_PUBLIC_BASE` / `AB_ASSET_MAX_MB` / `AB_EDGE_ORIGIN` など)は `wrangler.jsonc` にある。

    pnpm -C apps/control d1:migrate:local   # migrations/ をローカル D1 に適用
    pnpm -C apps/control dev                # wrangler dev(http://localhost:8788)

非常用のパスワードログインのセッションからは API キーを発行できない(403 `password_session`)。Google の設定が無い手元の開発でキーの発行を試すときは、ローカルの D1 だけで、セッションの経路の印を書き換える(ローカルでの動作確認用。本番では使わない):

    pnpm -C apps/control exec wrangler d1 execute wtt-control --local --command "update session set \"loginMethod\" = 'google' where \"userId\" = (select id from \"user\" where email = '<メールアドレス>')"

`dev` は control とデプロイ専用の Worker(`apps/deployer`)を同じプロセスで動かす(`wrangler.jsonc` の `services` の DEPLOYER は、別のプロセスだと届かず、公開のたびに設置タグの配信が `pending` のまま残る)。
デプロイ専用の Worker の向き先は `apps/admin/e2e/deployer.wrangler.jsonc` の偽の Cloudflare API(`127.0.0.1:8791`)で、本物の Cloudflare API には届かない。
公開で設置タグのファイルが実際に作られるところまで見たいときは、別のターミナルで偽の API を起動しておく(受けたファイルを `/s/*` で配る):

    pnpm -C apps/admin exec node e2e/fake-cf-api.mjs

起動していなければ、公開の応答の `staticDeploy` は `pending` になり、管理画面のサイトの上部に配信ファイルの警告が出る(公開そのものは成功している)。

初回は `POST /setup` で OWNER と Workspace を作る(パスワードは受け取らず、応答にセッショントークンも載らない):

    curl -s -X POST http://localhost:8788/setup \
      -H 'content-type: application/json' -H "x-setup-token: $AB_SETUP_TOKEN" \
      -d '{"email":"owner@example.com","name":"Owner","workspaceName":"My Workspace"}'
    # → 201 {"workspaceId":"…","userId":"…"}

### 手元で Bearer を得る

普段のログインは Google なので、`curl` から試すときは非常口の手順をローカルで踏む。
`.dev.vars` の `AB_BREAK_GLASS_TOKEN`(16 文字以上)のコメントを外して起動し直し、上の `POST /setup` の後に:

    TOKEN=<AB_BREAK_GLASS_TOKEN の値>
    # 1. 再設定リンクを得る(OWNER のメール以外は 404)
    URL=$(curl -s -X POST http://localhost:8788/break-glass/reset-link \
      -H 'content-type: application/json' \
      -d "{\"token\":\"$TOKEN\",\"email\":\"owner@example.com\"}" | sed -E 's/.*"url":"([^"]+)".*/\1/')
    # 2. リンクの token でパスワードを決める
    curl -s -X POST http://localhost:8788/auth/reset-password \
      -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
      -d "{\"token\":\"$(echo "$URL" | sed -E 's/.*token=([^&]+).*/\1/')\",\"newPassword\":\"<8 文字以上>\"}"
    # 3. ログイン。応答の token を Authorization: Bearer <token> に付ける
    curl -s -X POST http://localhost:8788/auth/sign-in/email \
      -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
      -d '{"email":"owner@example.com","password":"<上で決めたもの>"}'

`AB_BREAK_GLASS_TOKEN` を外す(または 16 文字未満にする)と、この 4 経路はすべて 404 に戻る。
Google ログインそのものをローカルで通すなら `AB_GOOGLE_CLIENT_ID` / `AB_GOOGLE_CLIENT_SECRET` も置く
(redirect URI = `http://localhost:8788/auth/callback/google`)。

`AB_ASSET_PUBLIC_BASE` が既定(`http://localhost:8788/dev-assets`)のままなら、アップロードした画像は
control 自身の `GET /dev-assets/*` から読める。本番は R2 のカスタムドメイン(`assets.<運用者ドメイン>`)を指すので
このルートは自動的に閉じる。

## テスト

`@cloudflare/vitest-plugin`(miniflare の実 D1 / KV / R2 binding)で動く。D1 は `migrations/` を毎回適用する。

    pnpm -C apps/control test        # vitest run
    pnpm -C apps/control typecheck   # tsc --noEmit

`test/openapi.test.ts` は **Hono のルータ(`app.routes`)から**期待値を作る掃引テストで、`describeRoute` を付け忘れた
ルートを足すと(テストを書き換えなくても)落ちる。`test/envelope.test.ts` は代表的な status
(400 / 401 / 403 / 404 / 409 / 413 / 415 / 422 / 429)の封筒を実リクエストで固定する。

## Better Auth のスキーマ

`migrations/0001_better_auth.sql` は生成物。プラグイン構成を変えたら作り直す:

    pnpm -C apps/control auth:schema

## デプロイ(実環境)

`docs/deploy.md` の「3. control のデプロイ」を参照。
