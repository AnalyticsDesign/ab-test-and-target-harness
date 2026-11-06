# 導入構成の選び方

**AI エージェントに導入を任せる場合は、この文書を読まなくてよい**。エージェントが[導入の質問](install-questions.md)で、やりたいことと今の環境を聞き、推奨の構成を示す。この文書は、その判断の根拠を知りたい人と、手で導入する人のためのもの。

[デプロイガイド](deploy.md)に入る前に、どの構成で導入するかを決めるための文書。ドメインの状態と Cloudflare の料金プランで取れる構成が変わるので、先に 1 節の 4 つの問いを決め、2〜5 節でそれぞれの選択肢と用意するものを確かめ、6 節で入力ファイルに書いてからデプロイガイドへ進む。

迷ったら **構成 A(設置サイトのゾーンに載せる)× Free プラン** で始める。デプロイガイドの既定の構成はこれで、後から有料プランや control の守りを足しても作り直しは要らない(3 節・4 節)。

## 1. 決める順番

| # | 問い | 答えで決まること |
|---|---|---|
| 1 | 設置サイトのドメインを Cloudflare のゾーンとして使えるか | edge の置き方(構成 A / B / C)。ここだけは後から変えると設置タグの URL が変わる |
| 2 | 月の PV とピーク日の PV はどれくらいか | Free プランで足りるか、Workers Paid($5/月〜)にするか |
| 3 | 管理画面を何人で使うか、外部の AI エージェントに API を叩かせるか | control の公開アドレス(`*.workers.dev` / 自分のドメイン)と、ログイン入口の守り方 |
| 4 | 画像の差し替え(IMAGE の変更)・Safari 対策(Mode B: サーバー発行 Cookie)を使うか | R2 のカスタムドメイン、`/__ab/*` の Route を足すか |

## 2. edge の置き方(問い 1)

訪問者のブラウザは、設置タグ(`/s/<siteId>.js`)を配信専用の Worker(`wtt-static`。静的アセットで、読み込みは Worker のリクエストに数えられない)から、判定と計測の送信(`/v1/*`)を edge に向ける。どちらも Cloudflare のゾーンに紐づけて同じホストで公開するのが既定。サイトのドメインを Cloudflare で管理していないときは、Cloudflare に追加した別のドメインに置く構成(B)を選べる。ドメインを用意せずに始めたい場合は、`*.workers.dev` で公開する簡易的な構成(C)を、制約を承知の上で選べる。

| | A. 設置サイトのゾーンに載せる(既定・推奨) | B. 別のドメインに載せる | C. Cloudflare にゾーンを持たない |
|---|---|---|---|
| 当てはまる状況 | 設置サイトの DNS が Cloudflare にあり、設置ホストのレコードがプロキシ有効(オレンジの雲) | 設置サイトの DNS は Cloudflare に移せないが、別のドメインを Cloudflare のゾーンにできる | Cloudflare にゾーンを 1 つも置けない |
| 可否 | 可 | 可 | **可(制約あり)**。前提 = Free アカウントで、止まって困る Workers が同じアカウントに無いこと |
| 公開の仕方 | `<設置ホスト>/s/*`(`wtt-static`)と `/v1/*`(edge)の Workers Route | edge は Custom Domain `<edge のホスト>`(例 `ab.example.net`)、`wtt-static` は同じホストの Route `<edge のホスト>/s/*`。`edge_address: custom-domain` | `*.workers.dev`(`edge_address: workers-dev`。`wtt-edge` と `wtt-static` の 2 つ) |
| タグと設置サイトの関係 | 同一オリジン。CORS 設定は不要 | 別オリジン。サイト設定の「ドメイン」の節の「タグを置くドメイン」(API は `domains`)にページのホストが要る(受け付ける Origin はこの一覧から決まる)。サイトが CSP を出していれば `script-src` と `connect-src` に `<edge のホスト>` を足す(設置タグと edge が同じホストなので 1 つ) | 別オリジン。サイトが CSP を出していれば `wtt-static` と edge のホストを足す |
| Mode B(サーバー発行 Cookie。Safari 対策の一方式) | 使える | 使えない(ページのホストに `/__ab/*` を置けないため) | 使えない |
| Cache Rule / WAF Rate Limiting Rule | 設置サイトのゾーンに作る | edge を置いたゾーンに作る。Cache Rule の条件のホスト名は `<edge のホスト>`。WAF Rate Limiting Rule の条件はパスだけで、[デプロイガイド 2.7](deploy.md#27-waf-rate-limiting-rule推奨) と同じ式 | **作れない**。万が一、悪意のある人がプログラムで大量のアクセスを送ってきた場合(タグのアドレスはサイトの HTML に書かれるので、誰でも知ることができる)、アクセスを制限できず、無料枠の日次上限を使い切られて当日の配信が止まる(Free なら課金は起きない) |

### 各構成の注意

- **A の前提の確認**: `curl -sI https://<設置ホスト>/ | grep -i '^server:'` が `server: cloudflare` を返せばプロキシ経由になっている。返さない場合、Workers Route は発火しない(タグの URL がサイト本体の 404 になる)
- **DNS を Cloudflare に移すのはサイト全体に及ぶ作業**。ネームサーバーの変更、既存レコードの移行、SSL/TLS の暗号化モードの設定などが要り、この製品の手順の範囲外。サイトの管理者と相談して先に済ませる。ネームサーバーを移さずに一部のホストだけ Cloudflare に載せる方式(CNAME セットアップ)は Business プラン以上
- **B(別のドメインに置く構成)**: edge と設置タグを、ページと別のドメインのホスト(`<edge のホスト>`)から配る。手順はデプロイガイドの `custom-domain` のときの手順で、読む節は[デプロイガイドの冒頭の一覧](deploy.md#手で導入する最短の手順)にある。代償の一覧は[デプロイガイド 1 節の制約 (3)](deploy.md#1-前提と全体像)。別オリジンになるので、次の 5 つを引き受ける。
  - サイト設定の「ドメイン」の節の「タグを置くドメイン」(API は `domains`)に、ページのホストが要る(edge のホストではない)。サイトを作ると作成のときに入れたドメインが入る。ページのホストが複数なら足す
  - サイトが CSP を出していれば、`script-src` と `connect-src` に `<edge のホスト>` を足す。設置タグと edge が同じホストなので、足すホストは 1 つ([サイト導入ガイド 10 節](site-install.md#10-コードの変更と-csp))
  - Mode B は使えない。Mode B はページのホストに `/__ab/*` の Route を置く必要があり、edge を別のドメインに置くとそれができないため。この構成では Mode B による Safari 対策はできないので、Mode A か Mode C で運用する([サイト導入ガイド 8 節](site-install.md#8-mode-c-と-mode-b))
  - 設置タグを別のドメインのホストから読み込むので、ブラウザや拡張機能の追跡防止の機能に遮断されやすい
  - WAF の遮断(Cloudflare の 1015)は、別オリジンの構成では、タグが応答を読めない。WAF の応答には別のドメインのページから読むための許可のヘッダーが付かず、ブラウザが通信の失敗として扱うので、429 の通知(`ab_error` の `rate_limited`)が出ない。edge の上限(Rate Limiting binding)の 429 は許可のヘッダーを付けているので通知される([運用ガイド 7 節](operations.md#429-が訪問者に与える影響))

  edge を置くドメインはサイトのドメインとは別なので、別のドメインを Cloudflare に追加してもサイトには影響しない。ただし、そのドメインでメールなどのほかのサービスが動いているなら、ネームサーバーを切り替える前に、そのドメインの DNS レコードが Cloudflare に移っていることを確かめる(移っていないと、そのサービスが止まる)。ほかの Cloudflare アカウントで使っているドメインは選ばない。切り替えると、そのアカウントで動いているサービスに影響するため
- **C**: ドメインを用意せずに始められる簡易的な導入方法。技術的な制限(期限・PV 上限)は無く、そのまま本番にも使える。上の表の制約を引き受ける。次のどれかに当てはまるなら、ドメインを 1 つ用意して(年 $10 前後)Cloudflare の Free ゾーンに追加し、設置サイトのゾーンに置く構成(A)か別のドメインに置く構成(B)にするほうがよい: 悪意のある人の大量のアクセスでその日の出し分けと計測が止まると困る / 1 日のアクセスが無料枠(10 万リクエスト)に近い。Safari 対策(Mode B)を使いたいなら A にする(Mode B は B でも使えない)。A へ後から移る手順は[デプロイガイド 2.8](deploy.md#28-ドメインありへの移行workers-dev--route)にあり、Worker・KV・サイト設定はそのまま使え、変わるのは設置タグの URL だけ。B へ移る手順はまだ無い

## 3. 料金プラン(問い 2)

### Free と Workers Paid

| | Free | Workers Paid |
|---|---|---|
| 月額 | $0。**上限に達すると課金ではなく失敗する**ので、想定外の請求は起きない | **$5 は最低額**。込み量(月 1,000 万リクエストなど)を超えると自動で従量課金になり、**支出上限を設定する機能は無い** |
| 上限の単位 | **日次**(UTC 0 時にリセット)。Workers 10 万リクエスト/日、Durable Objects の行書込 10 万/日 など | 月次の込み量 |
| 目安 | 下の表の PV/日 まで | 100 万 PV/月 まで $5、1,000 万 PV/月 で約 $10〜13 |
| 切り替え | — | ダッシュボード → Compute(コンピュート)→ Workers plans(Workers のプラン)。設定ファイル・再デプロイは不要で、いつでも移れる |

Free で収まる PV の目安(どれが先に効くかはサイトの構成で変わる):

| サイトの構成 | 先に効く上限 | 目安 |
|---|---|---|
| 履歴条件・`persistAssignment` を使わない(`needsProfile: false`、Mode A) | Workers のリクエストを使わない(設置タグは静的アセットで、読み込みは Worker のリクエストに数えられない) | Workers の上限では止まらない |
| 履歴条件・`persistAssignment` を使う(`needsProfile: true`) | Durable Objects の行書込(decision 1 回で 2 行) | 約 5 万 PV/日 |
| Mode B を使う | Workers のリクエスト数(判定で約 1 回/PV) | 約 10 万 PV/日 |

設置タグの作り直しを行うデプロイ専用の Worker(`wtt-deployer`)も Workers のリクエストを使う(毎時の定期実行 24 回/日と、公開・設定の保存ごとに 1 回程度)。同じアカウントで他の Workers を動かしている場合、上限はそれらと共有する。管理画面(admin)の SSR も同じ上限を使う(静的ファイルは算入されない)。月の PV が少なくても、キャンペーンなどでピーク日が上の目安を超えるなら Workers Paid にする。

### 上限を超えたとき(Free)

その日の残りは、Cloudflare が edge の Worker を実行しなくなる。**ページは元の表示のまま動き、エクスペリエンスが出ないだけ**になる(Exposure も GA4 に届かない)。control も同じ上限を共有するので、管理画面の操作も失敗する。設置タグのファイルは静的アセットなので、この上限に数えられない。

上限を超えたときの動きには、Worker を素通りしてサイト本体に渡す(fail open)と、Cloudflare のエラー 1027 を返す(fail closed)の 2 つがある。本製品は fail closed を前提にする。fail open にすると、訪問者の ID を含む判定と計測の送信がサイト本体のサーバーに届き、その応答はサイトごとに違うため。この動きは設定ファイル(`wrangler.jsonc`)では持てない。`wrangler deploy` と配信専用の Worker の設定のスクリプトが作る Route は、fail closed になる(実機で確かめた)。ダッシュボードでこの Route の動きを fail open に変えない。Custom Domain と `*.workers.dev` には選ぶ項目が無く、上限を超えると 1027 を返す。別のドメインに置く構成(B)では edge は Custom Domain なので 1027 になり、`*.workers.dev` の構成(C)も同じ。どちらも判定と計測の送信が失敗し、ページは元の表示のまま動く。

### 監視

Free では Cloudflare の課金通知が使えないので、ダッシュボード → Compute(コンピュート)→ Workers & Pages → `wtt-edge` の Metrics(メトリクス)と、Compute(コンピュート)→ Durable Objects の Requests / Storage を週 1 回見る([デプロイガイド 2.7](deploy.md#27-waf-rate-limiting-rule推奨) の末尾)。Workers Paid では支出上限が無いので、同じ画面で月の累計を見る。

### プランに関係なく要るもの

- **支払い方法の登録を求められることがある**: R2(画像の置き場)をアカウントで有効化するとき。無料枠内なら請求は発生しない([デプロイガイド 3.2](deploy.md#32-r2-と公開ドメイン))。**登録したくない場合は R2 を使わない構成(`asset_public_base: none`)を選ぶ**。画像アップロードと IMAGE の変更が無効になるだけで、画像の差し替えは ATTRIBUTE の `src` で行える(5 節)
- **配信ファイルのデプロイ用の API トークンを 1 本作る(どの構成でも)**: Workers Scripts の Edit だけの権限、期限なし。デプロイ専用の Worker にだけ置く。導入時に人に頼む作業の一部として、ほかのトークンと同じ画面でまとめて作る([デプロイガイド 0.5](deploy.md#05-人に用意してもらうもの一度に集める))
- **ゾーンのプランは Free でよい**。Cache Rule と WAF Rate Limiting Rule(1 本、IP 単位、10 秒窓)は Free で作れる。ただし Free のレート制限ルールの条件に使えるのはパスだけで、ホスト名では絞れない。ルールを複数本に分けたい・期間を 1 分にしたいときは Pro 以上(Pro は 2 本)。Cookie やヘッダー単位で数えられるのは Enterprise だけ

## 4. control と管理画面(問い 3)

| 使い方 | control の公開アドレス | 入口の守り | 追加で要るもの |
|---|---|---|---|
| 個人、管理者 1 人 | `*.workers.dev`(既定) | 何もしない。ログインは Google アカウント(パスワードの経路は普段閉じている) | なし |
| 小規模チーム | 自分のドメイン(`control.<ドメイン>`) | ゾーンの WAF Rate Limiting Rule | ゾーン 1 つ(edge と同じゾーンでよい)。Free では edge 用のルールと 1 本を分け合う。Free は条件にホスト名を使えないので、同じゾーンのほかのサイトが control と同じパスを使っていないかを先に確かめる([デプロイガイド 7.2](deploy.md#72-2-waf-rate-limiting-rules)) |
| 外部エージェントに叩かせる、到達自体を絞りたい | 自分のドメイン | Cloudflare Access(50 ユーザーまで無料) | Zero Trust の設定。エージェントはサービストークンを付ける。管理画面(admin Worker)から control への通信は service binding で、Access を経由しないので、admin には要らない。管理画面自体に Access を掛ける手順はデプロイガイド 4.5 |

自分のドメインを使う 2 つの守りは実機で検証していない。詳しくは[デプロイガイド 7 節](deploy.md#7-無認証入口の防御)。後から切り替えても、ユーザー・API キー・公開履歴はそのまま使える。

管理画面へのログインはどの構成でも **Google アカウント**で、入れるのは招待されたメールアドレスだけ。メール + パスワードの経路は普段閉じているので、**総当たりの標的になるパスワード入力が無い**(Google でログインできなくなったときだけ開ける手順が[デプロイガイド 8 節](deploy.md#8-非常時の入り方)にある)。本人確認と多要素認証は Google 側に寄るので、**管理画面に入る Google アカウントでは 2 段階認証を有効にする**。用意するものは Google の OAuth クライアント 1 つ(クライアント ID と クライアント シークレット。[デプロイガイド 3.3](deploy.md#33-secrets))。

**管理画面(admin)** は control とは別の Worker として Cloudflare Workers に置く(既定は `https://wtt-admin.<アカウントのサブドメイン>.workers.dev`)。admin は control を service binding(同じ Cloudflare アカウントの Worker 同士の内部の接続)で呼ぶので、**admin と control は同じ Cloudflare アカウントに置く**。この接続は control のゾーンを経由しないので、control に掛けた WAF・Access の対象にならず、ログインの回数は control が利用者の IP ごとに数える。自分のドメインに載せると招待・リセットリンクの見た目が整い、Access / WAF をゾーンで掛けられる(`admin_address: custom`)。運用者の PC でのローカル実行は開発用で、導入の選択肢ではない。

## 5. 付加機能(問い 4)

| 機能 | 使うなら要るもの | 使わないとき |
|---|---|---|
| 画像の差し替え(IMAGE の変更) | R2 バケットのカスタムドメイン(例 `assets.<ドメイン>`。ゾーンが Cloudflare にあること)。管理画面の画像の一覧(サイトに上げた画像を選んで使う)も R2 があるときだけ使える。一覧の縮小画像は Cloudflare Images の変換で作り、Free の枠(月 5,000 種類)の中で動く。枠を超えた月と、Images を使わない設定では、一覧に元の画像を出す([デプロイガイド 3.2](deploy.md#32-r2-と公開ドメイン)) | `dev-assets`(control 経由の配信)で暫定運用できる。画像の配信も Workers のリクエスト数を消費するので、本番で画像を使う前にカスタムドメインへ切り替える(使い始めた後に切り替えると、それまでの画像の URL が読めなくなる)。**R2 を使わない**(`none`)なら IMAGE の変更は無効になり、サイト上の既存画像の差し替えは ATTRIBUTE の `src` で行う |
| Mode B(Safari でも同じ訪問者に同じ表示を長く保つ) | 構成 A。`<ページのホスト>/__ab/*` の Route。ページのホストが複数なら、ゾーンの中のホストごとに Route を置く(ワイルドカード 1 本にまとめてもよい。[デプロイガイド 2.3](deploy.md#23-route-を書く))。ゾーンの外のホストには Route を置けず、Cloudflare 外のドメインとして Mode A と同じ動きで動く(テストと目標は動き、Safari では ID が弱い) | Mode A(Safari では操作なし 7 日で Cookie が消える)、または Mode C(サイトの会員 ID などを使う)。[サイト導入ガイド 8 節](site-install.md#8-mode-c-と-mode-b) |

## 6. 決めた内容をデプロイガイドへ渡す

決めた内容は `deploy-answers.yaml` の下段([デプロイガイド 0.2](deploy.md#02-構成を決める質問と入力ファイル-deploy-answersyaml))に書く(`owner_email` と、設置サイトのゾーンに置く構成(A)なら `install_host`、別のドメインに置く構成(B)なら `edge_host` は上段の行に書く。雛形の上段に最初から行があり、下段にもう 1 行書くと同じキーが 2 回書かれた誤りになる)。

| 決めたこと | 書く項目 |
|---|---|
| 構成 A の設置ホストとゾーン | `install_host` / `zone_name` |
| 構成 B(別のドメイン)の edge のホストとゾーン | `edge_address: custom-domain` / `edge_host` / `zone_name`(`edge_host` が属するゾーン) |
| 構成 C(ゾーンなし) | `edge_address: workers-dev`(`install_host` / `zone_name` は不要) |
| 画像の公開先 | `asset_public_base`(カスタムドメインの URL、`dev-assets`、または `none` = R2 なし) |
| control を自分のドメインに載せる | `control_address: custom` / `control_host` |
| 管理画面を自分のドメインに載せる | `admin_address: custom` / `admin_host` |
| 入口の守り | `control_protection`(`none` / `waf` / `access`) |
| edge の WAF ルールと、edge の Rate Limiting binding の値 | `edge_waf_rate_limit` / `edge_waf_requests_per_10s` |
| Mode B(サーバー発行 Cookie。構成 A のときだけ) | `dlite_hosts` |
| タグを置くページのほかのホスト(構成 A) | 上段の `extra_hosts`。Mode B を使うなら、そのうちゾーンの中のホストを `dlite_hosts` にも書く |
| 料金プラン | `plan`(`free` / `paid`。`paid` なら導入の前にダッシュボードで切り替える) |
