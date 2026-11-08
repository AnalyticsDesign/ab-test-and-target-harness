# AB Test and Target Harness

[![CI](https://github.com/AnalyticsDesign/ab-test-and-target-harness/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AnalyticsDesign/ab-test-and-target-harness/actions/workflows/ci.yml)

自分の Cloudflare アカウントにデプロイして使う、OSS の Web A/B テスト / パーソナライズツール。役割は 3 つに分かれている。

- 管理: エクスペリエンスの作成と運用は、管理画面(Cloudflare Workers)で行う
- 配信: 設置タグを配る配信専用の Worker と、判定を返す edge Worker が担う
- 計測: テストの結果(露出・目標の達成)は `dataLayer` から GA4 に送り、GA4 / BigQuery で読む。サイト設定で「結果を記録する」を有効にすると、本製品も参加と目標の達成を記録し、管理画面で判定を読める

状態: v0.11(先行公開版)。v1.0 で追加する予定の機能は[まだできないこと](#まだできないこと)にある。v0.9 / v0.9.1 / v0.10 / v0.10.1 / v0.11 から v1.0 へは更新で上げられる。使ってみた感想や不具合は Issue / Discussions へ。変更履歴は [CHANGELOG.md](CHANGELOG.md)

> **Adobe 社および同社の旧製品 Test&Target とは無関係**である。名称の "Test and Target" は一般名詞としての用法で、Adobe との提携・後継・互換関係は一切ない。

目次: [できること](#できること) / [まだできないこと](#まだできないこと) / [構成図](#構成図) / [前提](#前提) / [導入](#導入) / [導入の流れ](#導入の流れ) / [開発](#開発)

## できること

- **A/B テスト**: 1 エクスペリエンスにつき 2 つ以上のパターン、重み配分、対象 URL(含める・除くのページを複数行で書き、各行に URL のパラメータの条件を足せる)、開始 / 一時停止 / 終了。ページの書き換えは TEXT / IMAGE / HIDE / ATTRIBUTE / HTML / CSS / CUSTOM_JS の 7 種
- **パーソナライズ**: 条件に合う訪問者全員に 1 つのパターンを見せるエクスペリエンス(振り分けない)。作成時に種別(テスト / パーソナライズ)を選ぶ。同じ要素を複数のエクスペリエンスが変えるときは、パーソナライズ → テスト(開始・再開の新しい順)の順に重ね、後ろが勝つ
- **エクスペリエンスの複製**: 同じ内容のまま、または選んだパターンだけを表示するパーソナライズとして複製できる
- **配信条件**: 次を組み合わせる。
  - 環境: 端末・ブラウザ・OS・画面の幅・リファラー(ページの URL・パス・ホスト・パラメータは対象 URL で指定する)
  - 時間: 曜日と時間帯、初回の訪問からの経過
  - 履歴: 閲覧したページ・目標の達成(期間も指定できる)。履歴は Durable Objects の Visitor Profile に持つ
  - オーディエンス: 名前を付けた条件。複数のエクスペリエンスで使える
- **目標**: PAGEVIEW / CLICK / CUSTOM の 3 種。一致したときに conversion イベントを出す
- **訪問者 ID のサブドメイン間の共有**: 同じ登録ドメインのホスト(例 `www` と申し込みフォームのサブドメイン)で同じ訪問者 ID を使い、別のホストでの目標の達成もテストの結果に入れられる。新しいサイトは既定でオン。サイト設定で切れる
- **GA4 への計測**: 露出(`ab_exposure`)と目標の達成(`ab_conversion`)を `dataLayer` に push し、GTM 経由で GA4 に送る。dataLayer の変数名はサイト設定で変えられる(既定 `dataLayer`)。集計と読み方は分析ガイドを参照
- **複数ユーザー運用**: ワークスペース単位のテナント、ロール 4 種(オーナー / 管理者 / 編集者 / 閲覧者)、招待リンク。本番化(公開 / 開始 / 一時停止 / 終了)は管理者以上
  - ログイン: 管理画面のログインは Google アカウント。招待されたメールアドレスだけが入れる(メール + パスワードは非常時にだけ開く)
  - システム管理者: 導入全体を管理する人。ワークスペースの作成・削除とシステム管理者の追加・外すは、システム管理者だけが行う
  - 書き込みの凍結: 更新やデータベースの復旧の間、ログイン以外の変更操作を止める。訪問者への配信は止まらない
- **使用状況の表示**: Cloudflare の日次上限(Free の場合)に対する当日の消費と、上限に達する見込みを、管理画面のホームと設定で見られる(API は `GET /usage`)。表示には、読み取り専用の Cloudflare API トークンを置く(導入のときに作る)
- **テストの結果のレポート**(「結果を記録する」を有効にしたサイト): 開始の前に評価計画(判定に使う目標・期間・人数・判定の基準)を決め、開始の時点で固定する。実行中は速報として人数・CVR・基準を上回る確率を見られ、評価時点に判定(採用候補・悪化の可能性が高い・実務上ほぼ同等・判断材料が不足・データ品質の問題で判定不可)を 1 回だけ出して記録する。割り振りの偏り・混在・適用の失敗・収集の失敗を判定の前に確かめる。終了のときに採用したパターンを記録し、そのパターンだけを表示するパーソナライズの下書きを作れる。読み方は[テスト結果の読み方](docs/experiment-results.md)と、管理画面の「?」の説明にある
- **外部 AI エージェント向けの API**: OpenAPI 3.1(`GET /openapi.json`)、API キー、エージェント向けガイドの配布(`GET /llms.txt`)。エクスペリエンスの作成から公開、評価計画・結果の読み取り・終了と採用の記録、結果照会レシピの取得までを REST で完結できる

## まだできないこと

v1.0 で追加する予定:

- **使用状況の履歴**: 今の版は当日の消費と上限に達する見込みだけを出し、過去の推移は残さない

その後の予定:

- **ビジュアルエディタ**(画面上で要素を選んで書き換える編集モード)は v1.1。現状は CSS セレクタを手で指定する
- **MCP サーバ**は v1.1。当面は REST + OpenAPI を直接使う
- **Mode B(サーバー発行 Cookie)の Bridge 経路**: 今の Mode B は、サイトと同じゾーンの Workers Route から Cookie を発行する(サイトが Cloudflare 配下のとき)。サイト自身のサーバーを経由して発行する経路(First-party Bridge)は Phase 2

製品の範囲外:

- **AI によるパターン生成**: 本製品は LLM を呼ばない(生成は外部エージェントの仕事)

## 構成図

訪問者のブラウザでは設置タグが runtime.js を読み込み、`dataLayer` 経由で GA4 に計測を送る。そのほかの Worker はすべて運用者自身の Cloudflare アカウントに置く。

```mermaid
flowchart LR
  subgraph browser[訪問者のブラウザ]
    tag[設置タグ /s/siteId.js] --> rt[runtime.js]
    rt --> dl[dataLayer → GTM → GA4]
  end
  subgraph cf[運用者の Cloudflare アカウント]
    static[wtt-static Worker<br/>設置タグの配信<br/>静的アセット] 
    deployer[wtt-deployer Worker<br/>配信ファイルの作り直し<br/>デプロイ用トークンを持つ] -->|デプロイ| static
    edge[edge Worker<br/>decision / event] --> kv[(KV: compiled config)]
    edge --> do[(Durable Objects: Visitor Profile)]
    edge -->|結果を記録するサイト| d1r[(D1: 計測用 wtt-results)]
    control[control Worker<br/>API / 認証 / 公開] --> d1[(D1)]
    control --> r2[(R2: 画像)]
    control -->|公開| kv
    control -->|配信ファイルの作り直しを依頼| deployer
    admin[admin Worker<br/>管理画面 Next.js]
  end
  admin -->|BFF| control
  agent[外部 AI エージェント] -->|API キー| control
  tag -.->|読み込み| static
  rt -->|needsProfile のとき・結果を記録するとき| edge
```

## 前提

- **Cloudflare アカウント**
  - ドメイン: 設置タグと edge を設置サイトと同じオリジンで配るには、そのサイトのドメインが Cloudflare のゾーンにあること。サイトのドメインが Cloudflare に無くても、別のドメインを Cloudflare に追加すれば、そのドメインのホストで設置タグと edge を配り、WAF とキャッシュを使える構成で導入できる(設置サイトとは別オリジンになり、Safari 対策の Mode B は使えない)。ドメインを用意せずに `*.workers.dev` で公開する簡易的な構成も選べる(WAF・キャッシュ・Safari 対策が使えないなどの制約あり)。どれがよいかは導入の対話で答えから示される
  - R2(画像の置き場): 任意。使わなければ支払い方法の登録も不要
  - 構成の選び方は[導入構成の選び方](docs/install-patterns.md)を参照
- **GA4 プロパティと GTM コンテナ**: テストの結果を GA4 / BigQuery で読むときに要る(`dataLayer` から GTM 経由で GA4 に送る)。管理画面の結果のタブ(「結果を記録する」を有効にしたサイト)だけで読むなら、無くても判定は出る。本製品が保存するものは[法務](#法務)に書いてある
- **Node 24 以上と pnpm 10 系**: `packageManager` で固定。wrangler は `pnpm install` で入る

費用の目安は次のとおり。プランの選び方は[導入構成の選び方 3 節](docs/install-patterns.md#3-料金プラン問い-2)にある。

| 月間 PV | 履歴条件・`persistAssignment` を使わない(Mode A / C) | Mode B | 履歴条件・`persistAssignment` を使う |
|---|---|---|---|
| 10 万 | $0 | $0 | $0 |
| 100 万 | $0 | $0 | 約 $5 |
| 1,000 万 | $0 | 約 $5 | 約 $7 |

- $0(Cloudflare の無料枠)で収まるのは、Mode A / C で履歴条件などを使わないなら PV によらない(設置タグは静的なファイルで、無料枠に数えられない)。Mode B は約 10 万 PV / 日(Workers のリクエスト)、履歴条件などを使うと約 4.7 万 PV / 日(Durable Objects の行の書き込み)まで。無料枠は 1 日ごとなので、多い日の PV で比べる(多い日が平均の 2 倍なら、月に直して約 150 万 / 約 70 万 PV)
- 約 $5(Workers Paid の最低額)で収まるのは、Mode B は月約 1,000 万 PV(Workers のリクエスト)、履歴条件などを使うと月約 95 万 PV(Durable Objects のリクエスト)まで
- テストの結果を管理画面で記録するサイトは、参加と目標の達成の送信(1 PV あたり約 0.4 回)が足されるので、Mode A / C でも月 1,000 万 PV では約 $5 になる。記録の量には 1 日の上限(既定 7 万行。1 日約 6 万 PV 分)があり、超えた日は記録だけが止まる(配信は続く)

## 導入

**試してみたい人は、Claude Code などの AI エージェントに下のプロンプトを貼るだけでよい。** Cloudflare に詳しくなくても進められる。

- やりたいこと(A/B テスト・Safari 対策など)と今の環境(Cloudflare のアカウント・ドメイン)を聞かれて答えると、推奨の構成と最も手軽な構成が、それぞれでできないことと一緒に示される(質問の一覧は[導入の質問](docs/install-questions.md))
- 構成の判断の根拠を知りたい人や手で導入する人は[導入構成の選び方](docs/install-patterns.md)へ

入り方は 3 つあり、上ほど手数が少ない。

1. [AI エージェントに任せる](#ai-エージェントに任せる推奨)(推奨)
2. [手で導入する](#手で導入する)
3. [開発する](#開発する)

### AI エージェントに任せる(推奨)

Claude Code / Codex などのコーディングエージェントに、下のプロンプトをそのまま貼る。エージェントが[デプロイガイド](docs/deploy.md)を読んで進める。

**事前に用意するもの**:

- 管理画面のログインに使う Google アカウント
- Cloudflare のアカウント(無ければ、導入の途中で作り方を案内される)
- ツールは不要(Git / Node / pnpm / jq は、足りなければエージェントが入れ方を示して入れる)

**進み方**(人が手を動かすのは、次の 5 か所だけ):

1. 足りないツールの導入の了承(最初に 1 回)
2. 質問への回答と構成の選択。やりたいことと今の環境を質問の表どおりに聞かれる(最大 9 問。分かっていればまとめて答えてよい)。答えると、推奨構成と最軽量構成が示されるので、どちらかを選ぶ。既存のアカウントに入れる答えでも、構成によっては新しいアカウントを作ることを勧められる。そのときは、構成の選択とは別にアカウントの変更への同意を聞かれる
3. Cloudflare アカウントの作成(要るときだけ)と `wrangler login` の許可
4. Cloudflare と Google の画面での設定(下の「ダッシュボードで人が用意するもの」。一度にまとめて頼まれる)
5. Google でのログインと画面での動作確認。最後に任意で、エージェントから操作するための API キーを発行する

**ダッシュボードで人が用意するもの**(エージェントが必要な値を埋めた依頼文で、最初に一度だけまとめて頼まれる。[デプロイガイド 0.5 節](docs/deploy.md#05-人に用意してもらうもの一度に集める)):

- Google の OAuth クライアント(画面ごとにエージェントが案内する)
- Cloudflare の API トークン 2 本(設置タグの配信ファイルのデプロイ用・使用状況の表示用。どちらも期限なし)。ドメインありの構成と、control か管理画面を自分のドメインに置くときは、もう 1 本(ゾーンの設定用、期限 = 翌日)

#### 新規に導入する

```text
AB Test and Target Harness を私の Cloudflare アカウントに導入してください。
1. この PC に足りないツール(Git / Node 24 以上の LTS / pnpm / jq。Windows では Git for Windows(Git Bash・OpenSSL を含む)も)を確かめ、入れるもの(名前と入手元)の一覧を 1 回だけ示して了承を取ってから入れる。pnpm は単体で入れず、Node に付く Corepack で使う(clone の後、リポジトリが固定した版が使われる。docs/deploy.md 0.4)
2. https://github.com/AnalyticsDesign/ab-test-and-target-harness を短いパスに clone し(Windows では例 C:\wtth。長いパスでは Filename too long で失敗する。docs/deploy.md 0.4)、最新のリリースタグ(git tag の v* を版の順に並べた先頭。GitHub Releases の API は使わない)を checkout する
3. docs/install-questions.md を読み、その質問の表と進め方の規則どおりに私に聞く。答えは deploy-answers.example.yaml を写した deploy-answers.yaml に書く(既に deploy-answers.yaml があれば、答えの書かれた質問は飛ばす)
4. node tools/deploy-answers/cli.mjs を実行し、出力を要約せずにそのまま私に見せて、推奨構成と最軽量構成のどちらにするかを聞く。選んだら --accept recommended か --accept lightest を付けて実行する。出力の先頭に『確認: アカウントが変わる』が出て、選んだ構成がそれに当たるときは、その節をそのまま見せ、構成の選択とは別にアカウントの変更への同意を聞く。同意したときだけ --confirm-account-change を付ける(終了コードごとの扱いは docs/deploy.md 0.2)
5. docs/deploy.md を最初から最後まで読み、0 節の分担どおりに進める。コマンドは自分で実行し、【人が行う】と【人に依頼】の箇所でだけ止まって私に指示する
6. 各手順の「確認」を実行し、期待と違えば文書の分岐に従う。分岐に無い失敗は私に報告して止まる
7. 作業ログを deploy-log.md に残す。各手順の開始時刻(date -u)と結果を書き、秘密は書かない
8. 終わったら、入れたタグ・選んだ構成・control と管理画面の URL・作った workers.dev のサブドメイン(あれば)・エージェント向けの設定(.env.agent)を作ったか・残る鍵(CF_DEPLOY_TOKEN・CF_USAGE_TOKEN・発行した API キー)の保存場所と期限を一覧にして報告する
```

#### 更新する

```text
AB Test and Target Harness を更新してください。作業ディレクトリは <clone した場所> です。
1. git fetch --tags で最新のリリースタグを取り、現在のタグ(git describe --tags --exact-match)と目標のタグを私に示す
2. 目標タグの docs/deploy.md の 6 節(git show <目標タグ>:docs/deploy.md)を読む。更新手順は常に目標タグのものに従う
3. CHANGELOG.md(目標タグのもの)でその間の変更(マイグレーション・サイト設定のフィールド追加・runtime の変更)を要約して私に示し、進めてよいか確認する
4. 6 節の順序どおりに更新し、各「確認」を実行する。【人が行う】と【人に依頼】の箇所では止まって私に指示する
5. deploy-log.md に更新の記録を追記し、結果を報告する
```

### 手で導入する

[デプロイガイドの「手で導入する最短の手順」](docs/deploy.md#手で導入する最短の手順)を上から順に進める(既定の構成を 18 手順で動かす)。構成を変えたい項目は、0.1 節の表から該当する節へ。

### 開発する

`git clone` して[開発](#開発)の節を見る。

## 導入の流れ

導入から運用までに読む文書を、順に並べる。

| 順 | 文書 | 内容 |
|---|---|---|
| 1 | [デプロイガイド](docs/deploy.md)(エージェントに任せる場合は[導入](#導入)) | edge / control / admin(と設置タグの配信用の 2 つの Worker)を自分の Cloudflare アカウントに置き、初回セットアップを済ませる |
| 2 | [サイト導入ガイド](docs/site-install.md) | 対象サイトにタグを入れ、consent と GA4 / GTM の受け側を配線する |
| 3 | [運用ガイド](docs/operations.md) | エクスペリエンスを作り、下書きを確認し、公開 / 開始して様子を見る |
| 4 | [分析ガイド](docs/analytics.md) | GA4 の探索レポートまたは BigQuery で結果を読む |
| 5 | [エージェント向けガイド](docs/agent-guide.md) | 外部 AI エージェントに操作させる場合。control が `GET /llms.txt` で同じ内容を配る |

用語は [CONTEXT.md](CONTEXT.md) にまとめてある。文書の一覧は [docs/README.md](docs/README.md)。

## 法務

本製品は、次を運用者自身の Cloudflare アカウントに保存する。

- 設定とユーザー(D1 の `wtt-control`)
- 画像(R2。使う場合)
- 訪問者ごとの履歴(Durable Objects の Visitor Profile。履歴の条件を使うときに作る)。訪問者の識別子、閲覧したページの回数と最終日時、目標の達成回数、割り当てたパターンを持つ。生のイベントは保存せず、最終訪問から `retentionDays` で消える
- テストの参加者ごとの記録(D1 の `wtt-results`。サイト設定の「結果を記録する」が有効なサイトだけ)。テストごとに、表示したパターン・端末の種類・変更の適用の状態・最初の参加の時刻と、目標を最初に達成した時刻を持つ。訪問者の識別子はそのまま保存せず、鍵付きのハッシュにする。テストの記録を終えた時点から、サイト設定の保持期間(既定 90 日)を過ぎた後、書き込みの予算に余裕のある日に消す。同意の撤回でも消す(`forgetOnRevoke` が on のとき)
- テストの評価計画・固定した結果(パターンごとの人数・CV の数・判定などの集計。訪問者ごとの記録は含まない)・採用の記録(D1 の `wtt-control`)。参加者ごとの記録を消した後も残る

「結果を記録する」が無効のサイトでは、テストの結果に関わるものは保存しない。訪問者の識別子と行動履歴は `dataLayer` 経由で GA4 に送る。外部送信規律など各種規律への対応は運用者が行う。公表用の情報一覧の材料は [サイト導入ガイド「14. 外部送信規律への対応」](docs/site-install.md#14-外部送信規律への対応)にまとめてある。

## 開発

```bash
pnpm install       # 依存の導入(Node 24 以上)
pnpm test          # 単体テスト(全パッケージ)
pnpm e2e           # E2E(sample-site + wrangler dev + Playwright)
pnpm e2e:admin     # 管理画面の E2E
pnpm e2e:admin -- leave-guard.spec.ts   # 1 ファイルだけ(pnpm e2e も同じ形。先に流れる前提のテストがあれば、それも一緒に流れる)
pnpm typecheck     # 型チェック(全パッケージ)
pnpm docs:check    # 文書のリンク・パス検査
```

Windows on ARM(ARM64)では、ローカル実行に使う workerd が動かない(`pnpm install` で警告が出る)。Cloudflare への導入(deploy)はできるが、workerd を使う `wrangler dev`・E2E・control / edge の単体テストは動かない。開発は macOS / Linux / x64 の Windows で行う。

### ディレクトリ

| パス | 内容 |
|---|---|
| `apps/edge` | データプレーンの Worker(decision / event) |
| `apps/deployer` | デプロイ専用の Worker(設置タグの配信ファイルを作り直して、配信専用の Worker `wtt-static` に入れる。トークンを持つのはこの Worker だけ) |
| `apps/control` | コントロールプレーンの Worker(API / 認証 / 公開) |
| `apps/admin` | 管理画面(Next.js。Cloudflare Workers に vinext で配置) |
| `packages/core` | スキーマ・compile・ターゲティング評価の共有ロジック |
| `packages/runtime` | ブラウザで動く runtime.js |
| `packages/sample-site` | E2E 用のサンプルサイトと Playwright テスト |
| `tools/fixture` | ローカル / E2E 用の config 生成 CLI |
| `tools/docs-check.mjs` | 文書のリンク・パス検査(`pnpm docs:check`) |
| `fixtures/` | その入力 JSON |
| `integrations/gtm` | GTM にインポートする設定(変数・トリガー・GA4 イベントタグ。[サイト導入ガイド 4.3](docs/site-install.md#43-ショートカット-json-をインポートする)) |
| `docs/` | 本ガイド一式 |

ソースコードのコメントやテスト名に出てくる「決定 N」「Plan N」や spec の節番号は、開発時の非公開の設計記録への参照で、このリポジトリでは参照先を提供しない。挙動の根拠は各ガイドの本文に書いてある。

## 投稿

不具合の報告と機能の提案は Issue、使い方の質問は Discussions で受け付ける。Pull Request は提案として受け、採用分は次のリリースに取り込む(このリポジトリで直接マージはしない)。詳しくは [CONTRIBUTING.md](CONTRIBUTING.md)、脆弱性の報告は [SECURITY.md](SECURITY.md)。

## ライセンス

MIT License。全文は [LICENSE](LICENSE) を参照。
