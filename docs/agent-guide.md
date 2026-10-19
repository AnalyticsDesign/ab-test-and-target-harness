# エージェント向けガイド(AB Test and Target Harness)

このツールは **外部の AI エージェントが REST で直接操作できる**ように作られています。
本製品は LLM を呼ばず、GA4 / BigQuery への照会もヘッドレスブラウザも持ちません。それらはエージェント側の手足です。
本製品の責務は「エージェントが自分の手足で作業するのに必要な情報と操作を、機械可読な契約で出す」ことに限ります。

- 契約の正: `GET {AB_CONTROL_URL}/openapi.json`(OpenAPI 3.1。ルート定義の zod から生成しており手書きしません)
- この文書の配布: `GET {AB_CONTROL_URL}/llms.txt`(認証不要。中身はこのファイルと同一)

---

## 1. 人間の運用者が最初にやること

### 1.1 鍵の範囲と権限を決める(必要なら専用ユーザーも)

エージェントは**人間のユーザーに紐づいた API キー**で動きます。鍵は発行時に**範囲**と**権限**を持ちます。

- **範囲**: **ワークスペース**(指定した 1 つのワークスペースだけで使える。API の値は `workspace`。そのワークスペースのメンバーなら誰でも発行できる)か、**すべてのワークスペース**(API の値は `full`。システム管理者だけが発行・使用できる)。範囲外のワークスペースとその配下のサイトは、存在しないのと同じ 404 になり、`GET /workspaces` にも出ません。迷ったらワークスペースの鍵にします(漏れたときの被害がそのワークスペースに留まる)
- **権限**(API の `roleCap`): 実際の権限は **そのワークスペースでの持ち主のロールと、鍵の権限の低い方**です。権限は 閲覧者(`viewer`)/ 編集者(`editor`)/ 管理者(`admin`)/ 本人と同じ(`null`)から選び、ワークスペースの鍵はそのワークスペースでのロール、すべてのワークスペースの鍵は持ち主が持つ最高位のロールと同等かそれ以下だけ選べます。権限は付与ではありません(ロールより上には行かない)

権限を絞った鍵とワークスペースの鍵は、持ち主がシステム管理者でもシステム管理者の操作(ワークスペースの作成・削除・システム管理者の一覧)はできません。**鍵は、持ち主が範囲を使えなくなった時点で 401 になります**: すべてのワークスペースの鍵は持ち主がシステム管理者でなくなったとき、ワークスペースの鍵は持ち主がそのワークスペースから外れたときやワークスペースが削除されたとき。

**鍵ではできないこと(人とアクセス権の書き込み)**: 次の操作は、人が管理画面から行います。API キーで呼ぶと、鍵の種類(すべてのワークスペースの鍵・本人と同じ権限の鍵・システム管理者の鍵)に関わらず 403 `session_required` です。漏れた鍵で、鍵を増やす・自分を招待して居座る・他人のパスワードを変える・ワークスペースを消す、を防ぐためです(鍵を失効させても、増やした鍵や招待で入ったメンバーは残ってしまう)。

- API キーの発行・一覧・失効(自分の鍵も、メンバーの鍵も)
- 招待の発行・取り消し・受諾
- メンバーのロールの変更・削除、パスワードのリセットリンクの発行
- システム管理者の追加・外す
- ワークスペースの作成・削除
- ログインとログイン状態の操作(`/auth/*`)

読み取り(メンバー・招待・システム管理者の一覧)は鍵でもできます。鍵の用途は、サイト・エクスペリエンス・目標・オーディエンスの運用(作る・直す・公開する・読む)です。

| ロール | エージェントにできること | 使いどころ |
|---|---|---|
| 閲覧者(`viewer`) | 読み取り(エクスペリエンス(`experiment`)の閲覧・`evaluate`・`draft-bootstrap`・`analytics-recipe`) | 分析・監査だけを任せる |
| 編集者(`editor`) | 上記 + エクスペリエンス / パターン(`variant`)/ 変更(`change`。コードの変更を含む)の**下書き**作成・編集 | 人間が公開する運用(推奨) |
| 管理者(`admin`) | 上記 + **公開・開始・一時停止・再開・終了**(= 訪問者に届く操作) | 人間のゲートを置かない運用 |

**被害半径**: 管理者の権限の鍵は、コードの変更(HTML / CSS / CUSTOM_JS)を含むエクスペリエンスを**そのまま本番のサイトで実行**できます。
これは GTM のカスタム HTML と同じ信頼レベルです。人間が公開のボタンを押す運用にしたいなら権限を「編集者」にした鍵にし、公開は管理画面から人間が行ってください。**ただし、公開されるのは「公開を押した時点でサイトに保存されているすべての内容」で、公開の直前に見た確認画面の内容に固定されるわけではありません**。また、エクスペリエンスの開始・一時停止・再開・終了は確認画面を通らずにサイト全体を自動で公開します(実行中・一時停止中のエクスペリエンスの変更も、編集者がいつでも保存できます)。編集者の鍵が保存した内容を人間が確かめてから本番に出す運用にするなら、公開や状態の変更の前に `GET /sites/{sid}/publish-preview` で未公開の変更(著者・時刻・コードを含むか)を見て、その内容のまま公開します。

手順(管理画面): ユーザーメニュー →「設定」→「API キー」(`/w/me/api-keys`)の「新しい API キーを発行」で、名前と**範囲**と**権限**と**有効期限**(期限なし / 1・7・30・90 日。API の `expiresInDays` は 1〜365 の整数で、省略すると期限なし。管理画面で選べるのは上の 5 つだけ)を選んで発行します。キーは発行の直後に 1 度だけ表示されます。**個人で運用するなら、自分の鍵の権限を「編集者」にするだけで「人間が公開する運用」になります**(専用ユーザーは要りません)。更新や確認のためだけに使う鍵は有効期限を 1 日にします。期限を過ぎた鍵は 401 になり、`hint` に「この API キーは有効期限を過ぎています。管理画面で発行し直してください」と出ます。エージェントを別のユーザーとして分けたい(誰の操作かをメンバーの一覧で見分けたい)ときは、招待リンクを発行 → エージェント用の Google アカウントのメールアドレスで受諾(受諾もログインも Google アカウントで行うので、招待するのは Google アカウントのあるメールアドレスにします)→ その利用者でログインして鍵を発行します。鍵の発行は人が行う操作で、エージェントが自分で作ることはできません。管理者以上は、ワークスペースのサイドバーの「メンバーの API キー」(`/w/<ワークスペース ID>/api-keys`)で、そのワークスペースで使える鍵(そのワークスペースの鍵と、システム管理者の「すべてのワークスペース」の鍵)を持ち主付きで一覧し、失効させられます(鍵が漏れたときの止め方)。

### 1.2 環境変数

```
AB_CONTROL_URL=https://<control のホスト>
AB_API_KEY=wtt_...
```

導入を AI エージェントに任せた場合は、この 2 行がリポジトリ直下の `.env.agent`(git 管理外)に入っています([デプロイガイド 5.1](deploy.md#51-エージェント向けの設定推奨任意))。読み込みは `set -a; eval "$(tr -d '\r' < .env.agent)"; set +a`。

呼び出し方(どちらでも受け付けます):

```bash
curl -sS "$AB_CONTROL_URL/me" -H "Authorization: Bearer $AB_API_KEY"
curl -sS "$AB_CONTROL_URL/me" -H "x-api-key: $AB_API_KEY"
```

`GET /me` は持ち主と、その鍵の権限 `roleCap`(本人と同じなら `null`)・範囲 `keyScope`(`full` / `workspace`)・`keyWorkspaceId`(ワークスペースの鍵のときその ID)を返すので、最初に自分の鍵でどこで何ができるかを確かめられます。鍵の平文は発行時の応答にしか出ません。失効は `DELETE /me/api-keys/:kid`。失効した鍵と期限を過ぎた鍵はその時点から認証に通らず、一覧には失効または期限切れから 30 日間残ります(どの鍵を失効させたかを後から確かめられるように)。

### 1.3 エージェント側(横断側)で用意するもの

- **GA4 Data API または BigQuery への経路**(結果を読むレシピで使う。本製品は照会しません)
- **ヘッドレスブラウザ**(Playwright など。下書きの検証で使う)
- MCP サーバは **v1.1 で追加予定**です(REST の 1:1 ラッパ。まだリポジトリにありません)。当面は REST + OpenAPI を直接使ってください。CLI は作りません。

### 1.4 エラーの読み方

すべてのエラーは 1 つの封筒で返ります:

```json
{ "error": "validation_failed", "message": "…", "hint": "次にどうすればよいか", "path": ["variants", 0, "weight"], "issues": [] }
```

`error` は機械可読コード、`hint` は次に取るべき行動です。自己修正はこの 2 つを見てください。

**正規表現の 422** は、理由のコード(`error`。`regex_syntax` / `regex_unsupported_escape` / `regex_too_large` など)を返し、`message` に理由と書き換え方を書きます。式の中の位置は `index`(0 始まり)と `length` で示します。書き換えの例があるときだけ、`hint` に `書き換えの例: …` が付きます(例が無い理由では `hint` は付かないので、`message` を読んで書き換えてください)。`path` は値の欄を指します。

**メンテナンス中の 503**: 更新などの間は、ログイン以外の変更操作が `503 write_frozen` になります(`hint` に理由と再開の見込み、`Retry-After` ヘッダーと封筒の `retryAfter` に待つ秒数)。読み取り(GET)と配信条件の確認(`POST /sites/{sid}/evaluate`)は使えます。`Retry-After` の秒数だけ待ってから再試行し、長引くときは人に知らせてください。凍結の状態は `GET /capabilities` の `writeFreeze`(`null` = 凍結していない)で事前に確かめられます。

---

## 2. レシピ

### レシピ 1: エクスペリエンスを作って公開まで(編集者 / 管理者)

```bash
# 1. サイトを確認する(id は人間が管理画面で作ったもの)
curl -sS "$AB_CONTROL_URL/workspaces/$WID/sites" -H "Authorization: Bearer $AB_API_KEY"

# 2. エクスペリエンス(experiment)を作る(パターン a(名前 A・オリジナル)と b(名前 B)が 50:50 で自動生成される。`"kind":"single"` を足すとパーソナライズで、パターン a(名前 A)が重み 100 で 1 つ。省略は `test`)
curl -sS -X POST "$AB_CONTROL_URL/sites/$SID/experiments" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"id":"exp_hero_q1","name":"Hero Q1","urlMatch":{"part":"path","op":"startsWith","value":"/lp/"},"trafficPercentage":100}'

# 3. パターン b の変更(change)を全置換する(空配列で全消し。オリジナルの a には変更を保存できない)
curl -sS -X PUT "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/variants/b/changes" \
  -H "Authorization: Bearer $AB_API_KEY" -H 'content-type: application/json' \
  -d '[{"id":"c_text","type":"TEXT","selector":"h1.hero","payload":{"text":"新しい見出し"}}]'

# 4. 評価計画を決める(テストだけ。判定に使う目標の g_lead は下の「目標名」の例で作る。ほかの項目は省けば既定値)
curl -sS -X PUT "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/evaluation-plan" \
  -H "Authorization: Bearer $AB_API_KEY" -H 'content-type: application/json' \
  -d '{"plan":{"primaryGoalId":"g_lead","targetPerVariant":5000}}'

# 5. 開始(管理者。成功するとサイトが自動で公開される)
curl -sS -X POST "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/status" \
  -H "Authorization: Bearer $AB_API_KEY" -H 'content-type: application/json' -d '{"status":"running"}'
```

**評価計画と開始**(テストだけ。パーソナライズには評価計画も結果も無く、404 `results_not_applicable`):

- 評価計画は、何を・いつまで集めて・どう判定するかの約束で、結果を記録するサイト(`GET /sites/:sid` の `resultsEnabled` が `true`)で開始した時点に固定されます。必須は判定に使う目標(`primaryGoalId`)だけです。目標が無い開始と、基準(`baselineVariantId`。既定はオリジナルの中で先頭のパターン、オリジナルが無ければ先頭のパターン)の重みが 0 の開始は 422 `evaluation_plan_incomplete` です
- `GET …/evaluation-plan` は、保存していない項目を既定値で埋めた形(最低期間 14 日・最大期間 8 週・確率のしきい値 95 など)と `cautions`(最低期間が短い・しきい値が低い・目標参加者数が無い。開始は止めない)を返します。目標参加者数(`targetPerVariant`、パターンごと)が空だと、人数に関係なく最低期間の終わりに判定します
- 開始後に受けるのは、評価時点の前に `minDays`・`maxWeeks` を増やす・`targetPerVariant` を増やす(新しく設ける)変更だけです(`reason` を添えると変更の履歴に残ります)。縮める変更、判定の基準(`delta`・`rope`・`threshold`)・判定に使う目標・基準の変更は 409 `evaluation_plan_locked`、評価時点の後は 409 `evaluation_already_fixed` です。早く終えるときは終了し、基準を変えるときは複製して新しいテストにします。目標参加者数のある計画を延ばすときに、到達を確かめる読み取りができなければ 503 `results_read_unavailable`(時間をおいてやり直す)
- 結果を記録しないサイトでの開始は成功し、応答の `warnings` に `path: "results"` が出ます(結果はツールに残らず、後から記録を有効にしても、このテストは記録されません)。`path: "resultsCapacity"` は計測用のデータベースの空きが少なくなる見込みの警告です(開始は止めない)
- 評価計画の保存は公開の対象になりません(「未公開の編集あり」になりません)

対象 URL(`urlMatch`)は `{ "part": "url" | "path" | "host", "op": …, "value": … }` の形で書きます(`part` を省略すると URL 全体)。目標(`goal`)の `PAGEVIEW` も同じ形で、`config` は `{ "page": { "part": "path", "op": "equals", "value": "/thanks/" } }` です。目標の古い形 `{ "urlOp", "urlValue" }` は受け付けず 422 です。対象 URL の `part` を省略した `{ "op", "value" }` は URL 全体への一致として今までどおり使えますが、URL 全体の正規表現は使えません(下の「踏みやすい制約」)。

変更の型(`type`)は `TEXT` / `IMAGE` / `HIDE` / `ATTRIBUTE` / `HTML` / `CSS` / `CUSTOM_JS` の 7 種で、正確な形は `/openapi.json` にあります。

画像アップロードと IMAGE の変更が無効な導入があります(R2 を使わない構成)。IMAGE を使う前に `GET /capabilities` の `imageUpload` を見てください。`false` のときはアップロードが 409、IMAGE の変更の保存が 422(`image_upload_disabled`)になるので、画像の差し替えは ATTRIBUTE の `src` で行います。

公開の失敗は **HTTP 200 + `{"ok": false, "error": …}`** で返るので、`ok` を必ず見てください。

**パターンの組み替え・メモ・目標名**:

```bash
# パターンの集合を全置換する(下書きのときだけ)。original / description を省いたパターンは保存済みの値を保つ(新しいパターンは false / 空)
curl -sS -X PUT "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/variants" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' \
  -d '[{"id":"a","name":"A","weight":34,"original":true},{"id":"b","name":"B","weight":33},{"id":"c","name":"C","weight":33,"description":"見出しを短くした案","analytics":{"overrides":{"variantName":"short_headline"}}}]'

# パターンのメモだけを直す(状態にかかわらずできる。公開の対象にならない)
curl -sS -X PATCH "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/variants/b" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' -d '{"description":"ボタンの色だけを変えた案"}'

# 目標を作り、dataLayer に出す目標名を指定する(analytics を省くと ab_goal_name は目標 ID)
curl -sS -X POST "$AB_CONTROL_URL/sites/$SID/goals" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"id":"g_lead","name":"資料請求の完了","type":"PAGEVIEW","config":{"page":{"part":"path","op":"equals","value":"/thanks/"}},"analytics":{"overrides":{"goalName":"lead"}}}'
```

- **オリジナル**(`original: true`)は、変更を持たずに元のページをそのまま見せるパターンです。テストでだけ使え、数に制限はありません(A/A のテストも組めます)。パーソナライズで `true` にすると 422 `original_not_allowed`。`PUT …/variants` で `true` にしたパターンの変更は、同じ保存で消えます
- オリジナルのパターンへの `PUT …/variants/:vid/changes` は、空配列なら 200(`count: 0`。何もしない)、1 件以上なら 422 `variant_original` です
- テストからパーソナライズへの複製(`mode: "variant"`)でオリジナルのパターンを選ぶと 422 `duplicate_original_variant` です。複製はオリジナルの印とメモも写します
- **メモ**(`description`)は社内用の欄で、1,000 字まで(超えると 422 `description_too_long`)。設置タグのファイルにも dataLayer にも出ません。エクスペリエンスのメモは body が `description` だけの `PATCH /sites/:sid/experiments/:eid` で、パターンのメモは `PATCH /sites/:sid/experiments/:eid/variants/:vid` で直します。どちらも状態にかかわらずでき、「未公開の編集あり」になりません(ほかのキーと一緒に送ると、ふつうの更新として扱います)
- **目標の外部計測**(`analytics`)は、目標の作成と `PATCH /sites/:sid/goals/:gid` で受けます。`PATCH` で `"analytics": null` を送ると指定を消し、次の公開から `ab_goal_name` は目標 ID に戻ります。目標名はいつでも変えられ、変えて公開した時点から `ab_goal_name` の値が変わります(集計は `ab_goal_id` で行ってください)。応答の目標の `analytics` は、指定が無ければ `null` です

### レシピ 2: 下書きを検証する(公開前に本物のページで見る)

```bash
curl -sS "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/draft-bootstrap" \
  -H "Authorization: Bearer $AB_API_KEY" > /tmp/draft-bootstrap.js
```

得られるのは設置タグのファイルと同形式の**完全に機能する** bootstrap JS(compiled config + runtime)です。KV にも本番の配信ファイルにも書き込まれませんが、隔離されるかどうかは**ページの URL に `#__ab_preview=` フラグメントが付いているかだけ**で決まります。

**警告**: `addInitScript` で注入したのに URL にフラグメントを付け忘れると、下書きは**本番として**動きます。`needsProfile: false` のサイトでは未公開のエクスペリエンスがそのまま適用され、`_ab_vid` Cookie が作られ、`ab_exposure` が dataLayer / GA4 に送られます(存在しないエクスペリエンス ID のイベントとして実データに混入します)。加えて二重起動ガードにより、そのページに設置タグがあっても本番側のエクスペリエンスは止まります。**`goto` する URL には毎回 `#__ab_preview=<エクスペリエンス ID>:<パターン ID>` を付けてください**。付け忘れに気づく手段は無いので、注入と `goto` は必ずセットで書くこと。

これをヘッドレスブラウザに注入し、`#__ab_preview=<エクスペリエンス ID>:<パターン ID>` でパターンを固定します:

```js
// Playwright
const boot = require("fs").readFileSync("/tmp/draft-bootstrap.js", "utf8");
await page.addInitScript({ content: boot });
await page.goto("https://www.example.com/lp/#__ab_preview=exp_hero_q1:b");
const report = await page.evaluate(() => window.AB.getPreviewReport());
```

`report` は変更ごとの当たり外れです:

```json
[{ "experimentId": "exp_hero_q1", "variantId": "b",
   "changes": [{ "changeId": "c_text", "type": "TEXT", "selector": "h1.hero", "matched": 1, "applied": true }] }]
```

- `matched: 0` = **セレクタが外れている**(最頻の失敗)。`applied: false` と合わせて修正の根拠にしてください
- `error` は適用時の例外メッセージ(CUSTOM_JS の throw、CSP でのブロックなど)。HTML `runScripts` の `<script src>` は、**読込に成功した後で投げた例外**も後から `applied: false` / `error` に反映されます。ただし **inline スクリプトがタイマー等から後で投げた例外**は、どの変更のものか帰属できないため report には出ません(同期の例外は出ます)
- プレビューは**完全隔離モード**です: 指定したエクスペリエンスだけを強制適用し、Cookie・consent・decision 通信・目標・Exposure に一切触れません。したがって**プレビューの閲覧は計測に混ざりません**
- 通常表示では `window.AB.getPreviewReport()` は `null` を返します
- **注入は `addInitScript`(ページのどのスクリプトよりも先に走らせる)**。`page.evaluate` や `page.goto` の後に流し込むと DOM の適用が間に合いません。対象ページに**設置タグがあっても下書きが勝ちます** — runtime は 1 ページ 1 起動で、後から走った設置タグの bootstrap は何もしません(`window.AB` も上書きされません)
- **CSP を出しているページでは設置タグを消さずに注入してください**。注入したコードには `document.currentScript` が無く nonce を取れないため、runtime は**設置タグの nonce を引き継いで** CSS / HTML の `<script>` / CUSTOM_JS を適用します。設置タグを外したページに注入すると、nonce が要るページでは適用がブロックされます

### レシピ 3: 結果を読む

結果は 2 通りで読めます。管理画面の結果のタブと同じ数字(このツールが記録した参加と CV。結果を記録するサイトのテストだけ)と、GA4 / BigQuery で集計するためのクエリです。

**管理画面と同じ結果**(閲覧者以上):

```bash
curl -sS "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/results" -H "Authorization: Bearer $AB_API_KEY"
```

- 状態は軸ごとに分かれています: `phase`(`interim` = 速報 / `fixed` = 評価時点の記録 / `stopped` = 評価時点前に終了したときの記録)・`quality`(`ok` / `warning` / `blocked`)・`records`(`available` / `purged` = 参加者ごとの記録は保持期間を過ぎて削除済み)・`collection`(`enabled` / `site_disabled` / `store_missing` / `not_recorded` = 結果を記録せずに開始したテスト)
- **速報の数字で採用を決めないでください**。評価時点(`evaluation.evaluationAt`)の前は、各パターンの `state` が `null` で、判定を出しません。速報の確率は、見るたびに偶然高く出た値に当たる機会が増えます。差の無い 2 つのパターンでも、毎日判定して最初に勝ちと出た日に止めると約 27% が勝ちと出ます(評価時点を固定すると約 5%)
- 評価時点を過ぎると、その時点の値で判定を 1 回だけ出して記録し、以後は同じ値を返します(参加者ごとの記録を消した後も)。誰も読まなくても、1 日 1 回の定期処理が記録を作ります
- 判定 `variants[].state` は基準以外のパターンごとに、上から順に当てはめます: `blocked_quality`(データ品質の問題で判定不可。割り振りの偏り・混在・収集の停止)/ `adopt`(採用候補)/ `worse`(悪化の可能性が高い)/ `equivalent`(実務上ほぼ同等。同等とみなす幅を決めたときだけ)/ `insufficient`(判断材料が不足。「差が無い」ではなく「この人数では決着しなかった」)。判定に要る最低の件数を満たさない比較(`minCountMet: false`)は `insufficient` です。パターンが 3 つ以上のときは、比べる回数でしきい値を引き上げて使います
- 注記は `notes: [{ key, params }]` の形で、文言を持ちません。各鍵の意味は下の「注記の鍵」の表にあり、数値の読み方は表の「説明の項目」(`docs/experiment-results.md` の見出し)にあります(`helpKeys` は、その応答に関係する説明の項目の鍵)。人に報告するときは、品質の注記(`quality_blocked_*`・`collection_failures`・`collection_stops`・`apply_failures`)と `stopped_early`(評価時点前に終了)も必ず伝えてください
- 速報は 5 分間同じ値を返します。読み取りが混み合っているか今日の読み取りの上限に達したときは、前に計算した速報に注記 `interim_stale` を付けて返します(繰り返し読み直さないでください)
- 下書きは 409 `results_not_started`、パーソナライズは 404 `results_not_applicable` です

**注記の鍵**(`notes[].key`)。`params` の割合は 0〜1 の小数、時刻は epoch ミリ秒、時間は時間(h)です。「説明の項目」は `docs/experiment-results.md` の見出しです(`helpKeys` に入る鍵の項目)。

| 鍵 | 出るとき | `params` | 説明の項目 |
|---|---|---|---|
| `interim` | 評価時点の前の速報。判定の状態は出ない | `evaluationAt`(判定が出る時刻) | 評価時点の決まり方 |
| `interim_stale` | 読み取りが混み合っているか今日の読み取りの上限に達したので、前に計算した速報を返した(保存した速報も無ければ数値なし) | `reason`(`budget` = 今日の読み取りの上限 / `busy` = ほかの再計算の最中)、`computedAt`(返した速報の計算時刻。数値なしのときは付かない) | — |
| `stopped_early` | 評価時点の前に終了した。判定は終了の時点の値 | `evaluationAt`(本来の評価時点)、`stoppedAt` | 評価時点の決まり方 |
| `min_count_not_met` | そのパターンと基準の比較が、判定に要る最低の件数(各群で CV の見込みと CV しない人の見込みが 10 件以上)を満たさない。状態は `insufficient` | `variantId` | 判定の 5 つの状態 |
| `zero_weight` | 重み 0 のパターン(配信していない)。判定・割り振りの偏りの検査・比べる回数から外す | `variantId` | パターンが 3 つ以上のとき |
| `quality_blocked_srm` | 割り振りの偏り(p < 0.001)。判定不可 | `p` | 割り振りの偏り |
| `quality_blocked_mixed` | 混在の割合が 1% を超えた。判定不可 | `rate` | 混在 |
| `quality_blocked_stops` | 収集の停止の割合が上限を超えた。判定不可 | `ratio`、`limit`(上限 = min(5%, 0.5 ÷ √C)) | 収集の停止 |
| `collection_stops` | 収集の停止があったが上限以下。警告(判定は出す) | `ratio`、`hours`(止まっていた時間)、`limit` | 収集の停止 |
| `collection_failures` | 収集できなかった送信の割合(目安)が 1% 以上。警告。記録では記録を作った時点の値 | `ratio`、`failedSends` | 収集できなかった送信 |
| `apply_failures` | そのパターンで、変更が効かず回復していない参加者の割合が 1% 以上。警告 | `variantId`、`rate` | 適用に失敗した人 |
| `aa_test` | 基準と、ほかのどれかのパターンの両方に変更が無い(A/A テスト)。記録では記録に写した定義から、速報では今の定義から判断する | — | 基準のパターン |
| `baseline_not_original` | 基準に変更がある(結果は「そのパターンとの比較」) | — | 基準のパターン |
| `test_changes` | 開始後に配信中の中身を変えて公開し、配信を確かめた | `count` | テスト中の変更 |
| `plan_changes` | 開始後に評価計画を延ばした | `count` | 計画を変えるとき |
| `purged` | 参加者ごとの記録は保持期間を過ぎて削除済み(表示は固定した結果) | `days`(サイトの保持期間の日数) | データの保持 |
| `not_recorded` | 結果を記録せずに開始したテスト(`collection: "not_recorded"`)。数値は無い | — | 結果を記録するには |
| `store_missing` | 計測用のデータベースが導入されていない(`collection: "store_missing"`)。数値は無い | — | 結果を記録するには |
| `definition_missing` | 結果の記録に、配信していた定義の写しが無い(数値と判定は記録のとおり) | — | — |
| `unpublished_changes` | そのパターンの保存済みの変更が、配信していた定義(実行中は今、終了したテストは終了の直前)と違う。テストで配信したのは編集の前の中身 | `variantId` | 採用と複製 |
| `edited_after_evaluation` | 評価時点の記録の後に、そのパターンの変更が編集された(記録に写した定義と保存済みの変更が違う) | `variantId` | 採用と複製 |

**終了と採用**(管理者):

```bash
# 終了して、採用したパターンを記録する(variantId: null は採用なし。note は任意で 1,000 字まで)
curl -sS -X POST "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/status" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' -d '{"status":"archived","adoption":{"variantId":"b","note":"評価時点で採用候補"}}'
# 終了したテストの採用を記録し直す(上書き)
curl -sS -X PUT "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/adoption" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' -d '{"variantId":"b"}'
```

- 終了は、先に配信を止め(自動で公開)、その後で結果と採用を記録します。応答の `results.recorded` が `false` なら、終了と公開は済んでおり、結果の記録は自動で作り直されます。採用は `PUT …/adoption` で記録し直してください
- 採用は判定と関係なく選べます(記録には判定も一緒に残ります)。変更の無い基準の ID は「採用なし」として記録します。基準を採用する意味があるのは、基準に変更があるときだけです
- 終了していないテストへの `PUT …/adoption` は 409、パーソナライズへの採用は 422(どちらも `adoption_not_allowed`)、パターンに無い ID は 422 `unknown_variant` です
- 採用したパターンをサイトに出し続けるには、レシピ 7 の `mode: "variant"` で下書きを作り、人が開始します
- エクスペリエンスの一覧(`GET /sites/:sid/experiments`)の各項目に、採用の要約(`adoption`)が付きます

**GA4 / BigQuery で集計するクエリ**:

```bash
curl -sS "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/analytics-recipe" -H "Authorization: Bearer $AB_API_KEY"
```

返るのは**クエリ**であって数値ではありません。上の結果とは、参加者の数え方(このツールは対象の要素が表示された人、GA4 の `ab_exposure` は変更を適用できた人)と ID(このツールは訪問者 ID、GA4 は GA4 の ID)が違うので、数字は一致しません(`notes` にも入ります)。

- `ga4.exposureByVariant` / `ga4.conversionsByGoal`: `{ "method": "POST", "url": "…/v1beta/properties/<id>:runReport", "body": { … } }`。**`url` に `body` をそのまま POST**してください(property は URL に入っています。認証ヘッダだけ足します)
- `bigquery.visitorCvrSql`(訪問者単位 = `user_pseudo_id`。既定)/ `bigquery.sessionCvrSql`(セッション単位)
- **複数のパターンに露出した訪問者 / セッションは除外せず、期間内の初回露出のパターンに帰属させます**(intention-to-treat)。混在の規模は `bigquery.mixedExposureCountSql`(複数のパターンに露出した訪問者数 / セッション数)で確認してください
- **同じ `event_timestamp` の露出**は GA4 export の batch 内順序列(`batch_page_id` / `batch_ordering_id` / `batch_event_index`)で並べて初回を決めます。**順序列も等しい場合は不定**です
- BigQuery SQL の `_TABLE_SUFFIX` は、エクスペリエンスの実施期間の UTC 日付の**前後 1 日を含む**範囲です。GA4 export の日次テーブルの日付はプロパティのタイムゾーンで付くため(UTC と最大 1 日ずれる)、走査範囲を広げたうえで**採否は `event_timestamp`(UTC マイクロ秒)の条件**で決めています。広げた分の期間外イベントは数えません
- `notes` に上の帰属の規則が入ります。結果を報告するときはこの注記も併せて伝えてください
- `{{GA4_PROPERTY_ID}}` / `{{BQ_DATASET}}` は、サイトに外部の ID が未設定のときのプレースホルダです。`PATCH /sites/:sid` で管理者が設定します(管理画面に入力欄はありません)
- `runReport` が **400 `Field customEvent:… is not a valid dimension`** を返すときは、GA4 プロパティに `ab_experiment_id` / `ab_variant_id` / `ab_goal_id`(名札を変えていればその名前)が**イベントスコープのカスタムディメンション**として登録されていません。これはサイトの設置側(人間)の GA4 設定作業です — `docs/site-install.md` の「4. GA4 と GTM をつなぐ」を運用者に伝えてください。登録前のイベントは遡って次元にならないので、行が 0 でも契約の失敗ではありません

**パターン別の CVR は GA4 だけでは出せません**。conversion イベントにはエクスペリエンス / パターンが付かない設計のため、パターン × 目標の CVR は BigQuery(GA4 export)で出します。
GA4 単体で見る手段(v1alpha `runFunnelReport` のセグメントや GTM のユーザープロパティ)は alpha 依存 / 追加設定前提のため、レシピには含めていません。
GA4 側の 2 本は「配分どおりに露出しているか(SRM の確認)」と「目標ごとの発生数」を見るために使ってください。

人間の運用者向けの手順(GA4 探索レポートと BigQuery)は `docs/analytics.md` にあります。

### レシピ 4: 配信条件の what-if(なぜこの URL で出ないのか)

```bash
curl -sS -X POST "$AB_CONTROL_URL/sites/$SID/evaluate" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.example.com/lp/?utm_source=x","userAgent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1","viewportWidth":390,"visitorId":"test-visitor-1"}'
```

```json
{ "source": "published", "version": 7,
  "experiments": [ { "experimentId": "exp_hero_q1", "status": "running", "published": true, "eligible": false, "reason": "url_mismatch",
                     "weights": [{"variantId":"a","weight":50},{"variantId":"b","weight":50}] } ] }
```

- `reason` は `not_running` → `not_published` → `url_mismatch` → `needs_history` → `input_missing` → `targeting_false` → `traffic_excluded` の順に判定した結果です
- `status` は**状態(Desired Status)**(管理画面で設定した状態)、`published` は**公開 config に載っているか**です。`status: "running"` でも `published: false` なら `reason` は `not_published`(まだ公開していない、または公開後に消えた)。`paused` / `draft` / `archived` は `not_running` です
- 配信条件が使う入力は次のとおりです。**与えないと、その入力を使う条件を含むエクスペリエンスは `input_missing`(本番でも判定できず対象外になるのと同じ扱い)になります**。`device` と `userAgent` の両方を省くと端末は不明として扱い、端末の条件を含むエクスペリエンスは `input_missing` になります(端末に依らないエクスペリエンスは今までどおり評価します。`device` の既定値 `desktop` はありません)
  - `userAgent`: 端末・ブラウザ・OS をここから判定します(`device` / `browser` / `os` を直接指定するとそちらが優先)
  - `viewportWidth`: 画面の幅(px)
  - `now`: 判定時刻(epoch ミリ秒。省略するとサーバーの現在時刻。曜日・時間帯はサイトのタイムゾーンで判定します)
  - `firstVisitAt`: 初回の訪問時刻(epoch ミリ秒)。`null` は発行時刻が不明な古い訪問者を表し、「N 以上経過」の条件に当てはまります。省略とは区別されます(省略は `input_missing`)
  - `history` の各項目の `lastAt`(epoch 秒): 「最後の閲覧 / 達成が N 日以内」といった期間つきの履歴条件に使います。省略した項目では期間つきの条件は `input_missing` です
- `visitorId` は**省略できます**。省略すると ID に依存しない段まで(`weights` と `reason`)を返し、`traffic_excluded` / `variantId` には進みません
- 履歴条件(`visited` / `converted`)は Visitor Profile(Durable Object)を**見ません**。`history` で与えてください:
  `{"history":{"pages":[{"page":{"part":"path","op":"startsWith","value":"/pricing/"},"count":2,"lastAt":1759600000}],"goals":{"g_lead":{"count":1}}}}`。与えないと `needs_history` を返します
  - `pages` は URL パターンの ID ではなく、**ページの一致**(配信条件の `page` と同じ書き方)で書きます(URL パターンの ID は公開が値から決める内部の値です)。旧形(URL パターンの ID をキーにした object)は 422 です
- `"draft": true` で未公開の下書き(draft / paused)を running とみなして評価します(`source: "draft"`)。既定の `false` は **D1 に記録された active な公開 config**(`source: "published"`)を評価します。KV の伝播や、設置タグのファイルのブラウザキャッシュ(60 秒)とは差が出ることがあるので、`version`(評価した公開の版。未公開は `null`)で公開履歴と突き合わせてください
- **保存済み割当(`persistAssignment`)は参照しません**。DO に割当を持つ訪問者は本番でこれと違うパターンを受け取り得ます

### レシピ 5: オーディエンスを作って配信条件で使う(編集者)

オーディエンスは、名前を付けた訪問者の条件です。サイトごとに作り、複数のエクスペリエンスの配信条件から選べます。

```bash
# 1. オーディエンスを作る(料金ページを 30 日以内に 2 回以上見ていて、資料請求が未達成の人)
curl -sS -X POST "$AB_CONTROL_URL/sites/$SID/audiences" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"id":"aud_pricing","name":"料金ページ閲覧・資料請求前","definition":{"and":[{"hist":"visited","page":{"part":"path","op":"startsWith","value":"/pricing/"},"min":2,"withinDays":30},{"not":{"hist":"converted","goal":"g_lead"}}]}}'

# 2. エクスペリエンスの配信条件で使う(端末の条件と組み合わせる例)
curl -sS -X PATCH "$AB_CONTROL_URL/sites/$SID/experiments/$EID" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"targeting":{"and":[{"audience":"aud_pricing"},{"ctx":"device","op":"in","value":["mobile"]}]}}'

# 3. 開始(管理者。成功するとサイトが自動で公開される)
curl -sS -X POST "$AB_CONTROL_URL/sites/$SID/experiments/$EID/status" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' -d '{"status":"running"}'
```

- オーディエンスの応答の `usedBy` に、そのオーディエンスを配信条件で使っているエクスペリエンスが並びます
- オーディエンスの編集は**次の公開で**、参照するすべてのエクスペリエンスに効きます(保存しただけでは配信は変わりません)
- 公開の前に `GET /sites/$SID/publish-preview` で確かめられます。`audienceChanges`(オーディエンスの変更で配信対象が変わるエクスペリエンス)・`droppedPageConditions`(次の公開で数えるのをやめるページの条件)・`compileError`(いまの下書きが公開で止まる理由)を見てください
- 閲覧したページの条件・目標の条件・オーディエンスの書き方と、保存時の制限は「踏みやすい制約」にあります

### レシピ 6: 使用状況を監視して知らせる(閲覧者の鍵で可)

本製品は通知を送りません。監視はエージェントが `GET /usage` を定期的に(例: 1 時間ごと)読んで行います。鍵は閲覧者の権限・ワークスペースの範囲で足ります(導入の設定が「システム管理者のみ」なら、システム管理者が発行した鍵を使う。範囲と権限は問わない)。

1. `GET /usage` を読む。`worst.status` が `warning` / `critical` / `exhausted` なら知らせる(資源名・割合・`projectedExhaustAt`・`resetAt` を添える)
2. `status` の 2 系統を混ぜない: `ok` / `warning` / `critical` / `exhausted` は**止まる危険**、`within_reference` / `over_reference` は Paid の **月額 $5 に含まれる量との比較**(止まらない。超えた分が課金の対象)。`worst` は止まる危険のある資源だけから選ばれる
3. **応答が返らないこと自体を危険信号にする**: Workers の日次上限が尽きると control も止まり、`GET /usage` は Cloudflare のエラーページ(1027)になる。そのときは運用ガイドの「Cloudflare を直接見る」手順(別のトークンが要る)で確かめる
4. `503 usage_not_configured` は導入時にトークンを入れていない(監視できない)。`503 usage_upstream_failed` は Cloudflare 側の失敗で、時間をおいて読み直す。`403` は「見られる人」の設定の外

数値は Cloudflare 側の集計で数分遅れ、control は 60 秒の間同じ値を返す。日次の値は UTC 0 時(`resetAt`)に戻る。

### レシピ 7: 複製する(編集者)

```bash
# 同じ内容の下書き(種別・パターン・変更・設定をそのまま。id / name は省略可)
curl -sS -X POST "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/duplicate" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' -d '{"mode":"same"}'
# パターン b だけを表示するパーソナライズの下書き(配信率 100%・割当の固定 off で作られる)
curl -sS -X POST "$AB_CONTROL_URL/sites/$SID/experiments/exp_hero_q1/duplicate" -H "Authorization: Bearer $AB_API_KEY" \
  -H 'content-type: application/json' -d '{"mode":"variant","variantId":"b"}'
```

応答は `201` で新しいエクスペリエンス(いつも下書き)。開始は人の管理者に任せる。パーソナライズの元は `mode: "same"` だけ(`variant` は 422 `duplicate_mode_not_allowed`)。

- `mode: "variant"` が写す変更は、テストで**実際に配信していた中身**です(配信を確かめた定義。終了したテストは終了の直前のもの)。保存したが公開していない編集は入りません。配信を確かめた定義が無いとき(開始していない下書きなど)は、保存済みの変更を写します
- `mode: "same"` は保存済みの中身をそのまま写し、評価計画も初期値として写します(下書きの間は変えられます)
- どちらも、結果・採用の記録・履歴は写しません

---

## 3. 踏みやすい制約

- **ID は作成後に変更できません**(エクスペリエンス / パターン / 目標 / オーディエンス)。`experimentId` は割当ハッシュの入力なので、変えると全訪問者の割当が変わります。作り直す場合は新しい ID で作ります。オーディエンスの ID に `new` は使えません(管理画面の新規作成の画面と重なるため。422)
- **公開の反映**: 公開の結果の `staticDeploy` が `deployed` なら、訪問者のブラウザには 60 秒以内に届きます。`pending` なら配信ファイルの更新を再試行中です(`GET /sites/:sid` の `staticStale` が `true`。続くときは `POST /sites/:sid/static/redeploy` で作り直せます。管理者以上)。公開直後の検証は 1 分ほど待つか、キャッシュを迂回する URL で確認してください
- **種別は作成後に変えられない**。パターンの数はテストが 2 つ以上、パーソナライズが 1 つ(違反は 422 `variant_count_invalid`)。変えたいときは複製する
- **重なったときの優先**: 同じ要素の部分を複数のエクスペリエンスが変えると、パーソナライズ(作成の古い順)→ テスト(開始・再開の新しい順)の後ろが勝つ(テストどうしは先に配信に入ったもの。再開したテストは、その間に開始したテストより優先が低い)。保証するのは同じ要素の同じ部分までで、祖先と子孫にまたがる重なりは保証しない。公開の応答の `warnings`(`path` = `experiments.<優先の低い方>`)と `GET …/publish-preview` の `overlaps` に、対象 URL の条件とセレクタの文字列がどちらも完全に一致する組だけが出る。`?starting=<id>` を付けると、その下書きを開始したとき・一時停止中のテストを再開したときの組が分かる
- **開始後のテストで変えられないもの**: パターンの追加・削除・重み、基準、判定に使う目標の選択(パターンの集合の `PUT …/variants` は下書きだけ。409 `experiment_active`)、配信率(`trafficPercentage`)を下げる・割当の固定(`persistAssignment`)を変える(409 `test_setting_locked`。絞るときは一時停止か終了)。配信率を上げる・変更・対象 URL・配信条件・目標の定義の変更はできますが、公開して配信を確かめた時点で「テスト中の変更」として結果に記録されます。大きく変えるなら複製して新しいテストにします。パーソナライズはどの状態でも編集できます
- **終了したテストは読み取り専用**: エクスペリエンスの更新・パターン・変更・評価計画の保存は 409 `experiment_archived_readonly` です(変えるときは複製する)。メモ(`description` だけの `PATCH` と `PATCH …/variants/:vid`)・採用の記録・削除はできます
- **一度開始したテストを削除すると**、結果の記録・採用・計画の変更の履歴もすぐに消え、参加者ごとの記録は削除の直後から順に消えます。ID はこのサイトでは使い直せません
- **パターンの weight は合計 100**(テストは 2 つ以上のパターン、パーソナライズは 1 つで weight 100)。`trafficPercentage` は 1〜100(0% 配信は一時停止で表現します)
- **正規表現は URL のパスとホストだけ**に使えます(`part` が `path` / `host`)。URL 全体(`part` が `url` または省略)の正規表現は 422 です。「ホストが一致」+「パスが正規表現に一致」で書き換えてください。クエリで絞るなら配信条件のクエリパラメータ(`query`)の `equals` / `contains` を使います
  - 使える書き方: ふつうの ASCII 文字、記号のエスケープ(`\.` `\/` `\-` `\?` `\*` `\+` `\(` `\)` `\[` `\]` `\{` `\}` `\|` `\^` `\$` `\\`)、`.`、`[...]` と `[^...]`、`\d` `\w` `\s`、`^` `$`、`( )` と `(?: )` と `|`、繰り返し `?` `*` `+` `{n}` `{n,m}`(m は 100 まで)。日本語のパスは `%E3%81%82` のようにエンコードした形で書きます
  - 使えないもの: 後方参照、先読み・後読み、名前付きグループ、フラグ、上限のない `{n,}`、最短一致(`*?` など)
  - 上限: 式は 200 字まで、1 つの正規表現は 200 命令(変換後の大きさ。`{n,m}` は展開して数える)まで、サイト全体で 500 命令まで(超えると公開が `ok: false`)。照合するパスが 256 字を超えるページでは、パスの正規表現を含む条件を判定せず、そのエクスペリエンスは対象外になります
  - 意味: **部分一致**です(全体に一致させるには `^` と `$` を付ける)。**大文字と小文字は区別します**。ホストは小文字にして照合するので、式のホストも小文字で書いてください
- **配信条件(`targeting`)で使える条件**は次のとおりです。`and` / `or` / `not` で組み合わせます。

| 条件 | 書き方の例 | 備考 |
|---|---|---|
| ホスト | `{"ctx":"host","op":"equals","value":"www.example.com"}` | `op` は `equals` / `endsWith` / `contains` / `regex`。`endsWith` はドット区切りの境界で一致する(`example.com` はサブドメインの `www.example.com` に一致し、`notexample.com` には一致しない) |
| パス | `{"ctx":"path","op":"startsWith","value":"/lp/"}` | `op` は `equals` / `contains` / `startsWith` / `regex` |
| ブラウザ | `{"ctx":"browser","op":"in","value":["chrome","safari"]}` | `chrome` / `safari` / `edge` / `firefox` / `samsung` / `other` |
| OS | `{"ctx":"os","op":"in","value":["ios","android"]}` | `ios` / `android` / `windows` / `macos` / `chromeos` / `linux` / `other` |
| 画面の幅 | `{"ctx":"viewport","minWidth":768,"maxWidth":1200}` | px。`minWidth` 以上 `maxWidth` 未満。片方だけでもよい。ページを開いた時点の幅で判定し、viewport の meta が無い・タグが meta より前にあるページでは判定できず配信されません |
| 曜日と時間帯 | `{"ctx":"time","days":["sat","sun"],"from":"09:00","to":"18:00"}` | サイトのタイムゾーンで判定。`from` / `to` は 1 時間刻み(`to` は `24:00` も可)で、両方か、どちらも付けない(終日)。`to` が `from` より前なら日をまたぐ(曜日は開始時刻の曜日で数える) |
| 初回の訪問からの経過 | `{"ctx":"sinceFirstVisit","op":"gte","days":7}` | `op` は `gte`(以上)/ `lt`(未満)。`hours` か `days` のどちらか 1 つ |
| クエリ | `{"ctx":"query","name":"utm_source","op":"contains","value":"news"}` | `op` は `equals` / `contains` / `exists` |
| 端末・リファラー | `{"ctx":"device","op":"in","value":["mobile"]}` / `{"ctx":"referrer","op":"contains","value":"google"}` | 従来どおり |
| 閲覧したページ | `{"hist":"visited","page":{"part":"path","op":"startsWith","value":"/pricing/"},"min":2,"withinDays":30}` | `min` と `withinDays` は省略できる。`page` の `part` は `url` / `path` / `host` |
| 目標の達成 | `{"hist":"converted","goal":"g_lead","withinDays":30}` | `withinDays` は省略できる |
| オーディエンス | `{"audience":"aud_pricing"}` | サイトのオーディエンスを参照する(エクスペリエンスの `targeting` だけ。オーディエンスの中では使えない) |

- **閲覧・目標の条件の書き方**: 閲覧は `{ "hist": "visited", "page": { "part", "op", "value" }, "min"?, "withinDays"? }`(`min` は 2 以上のときだけ意味があります。否定した閲覧の条件には `min` を付けられません)、目標は `{ "hist": "converted", "goal", "withinDays"? }` です。`withinDays` は 1〜3650 かつサイトの `retentionDays` 以下です
- **URL パターンの ID を参照する古い書式**(`"pattern": "p_xxx"` / `page_view_count`)は、保存が 422 `legacy_targeting`、公開は `ok: false` です。`page` を直接書く形に書き換えてください
- **エクスペリエンスの `targeting` の形の制限**: 条件 1 つ / 否定の形を持つ条件の `not` / `and`・`or` の下に条件か否定の形を持つ条件の `not` が並ぶ形だけです(入れ子とグループの `not` は 422 `invalid_experiment_targeting`)。否定の形を持つ条件は次のとおりです: URL の含む・完全一致、パスの含む・完全一致・正規表現、ホストの完全一致・正規表現、クエリの完全一致・存在、端末・ブラウザ・OS、リファラーの含む・空、閲覧(回数なし)、目標、オーディエンス。入れ子が要るときはオーディエンスで作ります
- **オーディエンスの `definition`** は、入れ子を一番外側の中に 4 段まで使えます。`{ "audience": … }`(オーディエンスの中のオーディエンス)は使えません(422 `invalid_audience_definition`)
- **保存時の正規化**: 子が 1 つのグループの畳み込み、`not(not(x))`、`min: 1` と `part: "url"` の省略をします。応答の値が送った値と違うことがあります
- **削除と参照**: 参照されているオーディエンス(409 `audience_in_use`)と、オーディエンスから参照されている目標(409 `goal_in_use`)は削除できません。存在しないオーディエンス・目標の参照は、保存が 422、公開は `ok: false` です(`unknown_audience` / `unknown_goal`)
- **保存期間(`retentionDays`)を短くする PATCH** は、期間がそれを超える条件(保存済みの定義と公開中の設定)があると 422 `within_days_exceeds_retention` です(`conflicts` に一覧を返します)。先に条件の期間を直して公開してください

- **selector はページ内で一意**に。当たらない selector は `evaluate` では検出できません — レシピ 2 の `matched` で確認してください
- **変更はパターンあたり 100 件まで**、1 つの変更の payload は 64KB まで、compiled config 全体で 512KB まで
- **ATTRIBUTE には allowlist があります**(`on*` / `style` / `srcdoc` などは拒否。`href` / `src` は http(s) と相対 URL のみ)。拒否は `attribute_not_allowed` / `attribute_url_not_allowed`
- **コードの変更(HTML / CSS / CUSTOM_JS)と CSP**: 対象サイトが CSP を出している場合の条件と、開始直後の必須確認手順は `docs/site-install.md` の「10. コードの変更と CSP」と `docs/operations.md` の「5. 開始直後のチェック」を参照してください。CSP でブロックされた CUSTOM_JS は片側だけ Exposure が出ない(SRM)状態になります。**公開前にレシピ 2 の `getPreviewReport()` で `error` を確認する**のが最短の予防です
- **編集者の権限の鍵で公開・開始を呼ぶと 403**(`{"error":"forbidden","required":"admin"}`)。人間に公開を依頼してください
- **ワークスペース・メンバー・招待・システム管理者の書き込みは鍵ではできません**(1.1 の「鍵ではできないこと」。403 `session_required`)。以下の項目は、人が管理画面から操作したときの挙動の参考です
- **ワークスペースの作成(`POST /workspaces`)はシステム管理者だけ**です(システム管理者 = この導入、つまり Cloudflare アカウント上の 1 デプロイ全体の管理者。初回セットアップの最初のオーナーで、すべてのワークスペースのオーナーを兼ねます)。自分の鍵がシステム管理者として扱われるかは `GET /me` の `instanceAdmin` で確かめます(権限を絞った鍵とワークスペースの鍵では常に `false`)。システム管理者の一覧 `GET /instance-admins` と候補の一覧 `GET /instance-admins/candidates` は、本人と同じ権限のすべてのワークスペースの鍵で読めます(権限を絞った鍵・ワークスペースの鍵は 403 `forbidden`、`required: "instance_admin"`)。追加できるのはどこかのワークスペースのメンバーだけです
- **システム管理者には、ワークスペースの側から手を出せません**: `PATCH` / `DELETE /workspaces/:wid/members/:memberId` は 409 `instance_admin_member`、システム管理者宛てのリセットリンクの発行とシステム管理者の鍵の失効は、システム管理者でない人には 403 です。`GET /workspaces/:wid/members` の各行の `instanceAdmin`、`GET /workspaces/:wid/api-keys` の各行の `owner.instanceAdmin` で見分けます。メンバー宛てのリセットリンクは、発行先のワークスペースで管理者以上の人が、発行先だけに所属する人か自分自身に発行できる。対象が他のワークスペースにも所属するときは、そのすべてでオーナーの人かシステム管理者だけが発行できる(それ以外は 403)。
- **既にそのワークスペースのメンバーへの招待は 409 `already_member`** です。招待リンクの発行(`POST /workspaces/:wid/invitations`。システム管理者はすべてのワークスペースのメンバーなので、そのメールアドレスも対象)と、招待の受諾のどちらでも返ります(招待を使わずにそのままログインすれば入れます)
- **ワークスペースの削除(`DELETE /workspaces/:wid`)もシステム管理者だけ**です。配下のサイトに実行中のエクスペリエンスがあれば 409 `workspace_has_running_experiments`(`siteId` / `experimentId` を返す。先に終了する)。**最後に残った 1 つのワークスペースは削除できず** 409 `last_workspace` を返します(すべて消すと、誰もワークスペースを作れずログインもできない状態になるため)。作り直したいときは、先に新しいワークスペースを作ってから古い方を削除してください
- **招待の一覧(`GET /workspaces/:wid/invitations`)に出るのは、まだ受けられていない招待だけ**です。受諾済み・取り消し済みの行は返りません。取り消しは `DELETE /workspaces/:wid/invitations/:id`(管理者。成功すると 204、すでに受諾済み・取り消し済み・別ワークスペースの ID は 404)
- **同じメールアドレスへの再発行**(`POST /workspaces/:wid/invitations`): 有効な招待が既にあり**ロールが同じ**なら、新しい招待は作らずその招待の期限を 7 日後まで延ばし、`extended: true` と**同じ `id` / `url`** を返します。**ロールが違う**ときは 409 `already_invited`(現在のロールを `role` と `message` で返す)で、招待には何も起きません — ロールを変えるときは先に取り消してから発行し直してください。有効な招待が無ければ新規発行で `extended: false` を返し、同じ宛先の期限切れの招待は取り消し済みとして片づけます
- **名前(エクスペリエンス / パターン / 目標の `name`)は管理画面の中だけで使い、訪問者には届きません**(100 字以内)。compiled config・設置タグのファイル・`draft-bootstrap` に入りません。dataLayer の `ab_experiment_name` / `ab_variant_name` / `ab_goal_name` は、外部計測(`analytics.overrides` の `experimentName` / `variantName` / `goalName`)で指定した値、指定が無ければそれぞれの ID です
- **外部計測の値**(名前の指定と `extra` の値)は 1〜100 字で、改行・タブなどの制御文字(U+0000〜U+001F・U+007F〜U+009F)と U+2028 / U+2029 は使えません。違反は 422 `invalid_analytics_value`(`path` が値の位置、`code` が `empty` / `too_long` / `invalid_char`)。保存済みと同じ値は検査しないので、古い値が残っていても、ほかの欄の保存は止まりません。外部計測の値は dataLayer に入り、サイトの訪問者もブラウザで見られます
- **Windows の Git Bash から日本語を含む JSON を送ると文字化けする**ことがあります(`curl -d '{"name":"…"}'` の引数が UTF-8 にならない)。UTF-8 のファイルに書いて `curl --data-binary @body.json -H 'content-type: application/json' …` で送ってください
- **本番のページを headless ブラウザで開くときは、計測系の通信を遮断する**(下書きの検証以外の、設置状況の確認なども同じ)。遮断しないと、確認のたびに GA4 などへ実データが送られます。Playwright なら次のように止められます:

```js
// GA4 / GTM / Google 広告などへの送信を止める(必要に応じてサイトが使う計測先を足す)
await context.route(/google-analytics\.com|googletagmanager\.com\/(g|gtag)\/|analytics\.google\.com|doubleclick\.net/, (r) => r.abort());
```
