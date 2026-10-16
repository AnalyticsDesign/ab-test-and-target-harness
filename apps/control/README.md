# @wtt/control — control Worker

コントロールプレーンの Worker。D1(`DB`)を正本に、KV(`CONFIG_KV`)と R2(`ASSETS`。任意 — binding が無い導入では画像機能を無効にする)へ書く。
edge(`apps/edge`)は KV を読むだけで、control とは直接つながらない。設置タグのファイル(`/s/<siteId>.js`)は edge ではなく、配信専用の Worker(`wtt-static`。静的アセット)が配る。control は公開・設定の保存のたびに、デプロイ専用の Worker(`apps/deployer`、`wtt-deployer`。Service Binding `DEPLOYER` の RPC)へ配信ファイルの作り直しを頼む。デプロイ用のトークンを持つのはデプロイ専用の Worker だけで、control は持たない。

- 認証は Better Auth(Bearer。セッショントークンと API キー `wtt_…` が同じ入口)。人のログインは Google アカウントで、
  メール + パスワードの経路は非常用トークン(`AB_BREAK_GLASS_TOKEN`、16 文字以上)を置いているあいだだけ開く。
  ログイン状態を持てるのは「どこかの Workspace の Member」か「自分のメールアドレス宛ての有効な招待がある人」だけで(判定は `src/access.ts`)、
  Member から外す・招待を取り消すと、その人のログイン状態はその場で切れる。
- **認可判定は `src/roles.ts` の外に書かない**(`loadSite` / `requireWorkspaceRole`。システム管理者の判定 `actsAsInstanceAdmin` / `assertCanTouchInstanceAdmin` も同じ)。非メンバーは常に 404、Role 不足は 403。
- エラーは常に封筒 `{ error, message, hint?, path?, …details }`(`src/errors.ts`)。`/auth/*` は Better Auth 自身の形式なので対象外。
- 契約は `GET /openapi.json` が唯一の正本。ルート定義の zod から生成し、手書きしない。

### 書き込みの凍結と版のヘッダー

- 書き込みの凍結: D1 の `instance_settings` のキー `writeFreeze` に行があるあいだ、`/auth/*`・`/break-glass/*`・`POST /sites/:sid/evaluate` 以外の POST / PUT / PATCH / DELETE を `503 write_frozen` で断る(`src/write-freeze.ts`。行が読めなくても凍結中)。入切は `docs/deploy.md` 6.6。GET に伴う業務データの書き込み(`GET /sites/:sid` の配信の写しの自己修復と、設置タグの配信ファイルの自己修復(`reconcileStatic`)など)は `isWriteFrozen()` で凍結中かを確かめ、凍結中は見送る。後から足す Cron や自己修復も同じ関数を使う。`/auth/*` が開くパスの一覧は `src/auth-paths.ts`(業務の書き込みを足すと凍結から素通しになる)
- 版のヘッダー: 全応答に `x-wtt-api-version`(`@wtt/core` の `API_CONTRACT_VERSION`)。管理画面は `x-wtt-client-version` を付けてくる。今は判定しない

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
| `GET /capabilities` | 認証のみ | この導入で使える機能 `{ imageUpload, edgeOrigin, tagOrigin, edgeOnWorkersDev, passwordLogin }`(R2 と公開ベースの有無、edge の公開 origin、設置タグを配る origin、パスワードログインが開いているか) |
| `GET /me` | 認証のみ | 現在のセッション(または API キー)の持ち主 |
| `GET /me/api-keys` | 認証のみ | 自分の API キー一覧(平文は含まない) |
| `POST /me/api-keys` | 認証のみ | API キーを発行(平文はこの応答限り)。範囲 `workspaceId` は必須(`null` = フルはシステム管理者のみ) |
| `DELETE /me/api-keys/:kid` | 認証のみ | API キーを失効(他人の鍵は 404) |

### Workspace / Member / 招待

| ルート | Role | 内容 |
|---|---|---|
| `GET /workspaces` | 認証のみ | 自分が所属する Workspace(Role 付き) |
| `POST /workspaces` | システム管理者 | ワークスペースを作る(システム管理者全員がオーナー)。それ以外・上限付きの API キーは 403 `forbidden` |
| `DELETE /workspaces/:wid` | システム管理者 | Workspace を削除。最後に残った 1 つは削除できない(409 `last_workspace`)。実行中のエクスペリエンスがあれば 409 `workspace_has_running_experiments` |
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
| `POST /workspaces/:wid/sites` | ADMIN | Site を作成 |
| `GET /sites/:sid` | VIEWER | Site 1 件(+ `hasUnpublishedChanges` / `activeKvStale` / `staticStale` / `staticRemoving`) |
| `PATCH /sites/:sid` | ADMIN | Site 設定を更新(Identity / Analytics 命名は KV 即時反映で Publish 不要) |
| `DELETE /sites/:sid` | OWNER | Site を削除(KV の settings / host / active / config と R2 の画像(binding があるとき)も消す) |

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
| `POST /sites/:sid/experiments` | EDITOR | 作成(`kind` = test はパターン a / b を 50 / 50、single はパターン a を重み 100 で自動作成) |
| `GET /sites/:sid/experiments/:eid` | VIEWER | 1 件(Variant と Change を含む) |
| `PATCH /sites/:sid/experiments/:eid` | EDITOR | 更新(id は不変、status は `/status` 経由) |
| `DELETE /sites/:sid/experiments/:eid` | EDITOR | 削除(draft / archived のみ) |
| `PUT /sites/:sid/experiments/:eid/variants` | EDITOR | Variant を全置換(test は 2 つ以上・single は 1 つ・weight 合計 100。draft のみ) |
| `PUT /sites/:sid/experiments/:eid/variants/:vid/changes` | EDITOR | Change を全置換(1 件でも保存時検証に落ちれば何も書かない) |
| `POST /sites/:sid/experiments/:eid/duplicate` | EDITOR | 複製(下書きを作る。mode = same / variant) |
| `POST /sites/:sid/experiments/:eid/status` | ADMIN | status 遷移(成功した遷移は必ず Site を自動 Publish) |

### Publish

| ルート | Role | 内容 |
|---|---|---|
| `POST /sites/:sid/publish` | ADMIN | Publish(失敗も 200 + `ok:false`)。成功の結果の `staticDeploy`(`deployed` / `pending` / `skipped`)が設置タグの配信ファイルの更新の状態 |
| `POST /sites/:sid/static/redeploy` | ADMIN | 設置タグの配信ファイルを今の公開内容で作り直す(更新が済んでいないとき、削除が途中で止まったとき。結果 `{ staticDeploy }`) |
| `GET /sites/:sid/publish-preview` | VIEWER | 前回 activation 以降に変わった Experiment / Change |
| `GET /sites/:sid/publishes` | VIEWER | 公開履歴(新しい順・最大 100 件) |
| `GET /sites/:sid/publishes/:version` | ADMIN | その version の compiled config |

### Asset(R2)

| ルート | Role | 内容 |
|---|---|---|
| `POST /sites/:sid/assets` | EDITOR | 画像を R2 へ(multipart: `file` / `experimentId`)。201 `{ id, publicUrl, mime, size, key }` |
| `GET /sites/:sid/assets` | VIEWER | Site(`?experimentId=` で絞る)配下の画像一覧 |
| `GET /dev-assets/*` | — | ローカル用に R2 をそのまま返す。**`AB_ASSET_PUBLIC_BASE === ${AB_CONTROL_URL}/dev-assets` のときだけ有効**(本番は R2 カスタムドメインなので常に 404) |

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
