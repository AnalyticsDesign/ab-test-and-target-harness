# CONTEXT.md — AB Test and Target Harness 用語集

このファイルは用語集である。手順は `docs/` の各ガイド(入口は `README.md`)を参照。

## 製品

| 用語 | 定義 |
|---|---|
| **AB Test and Target Harness** | 本製品。自分の Cloudflare アカウントにデプロイして使う OSS の Web A/B テスト / パーソナライズツール。Adobe 社および同社の旧製品 Test&Target とは無関係 |

## テナントと権限

| 用語 | 定義 |
|---|---|
| **Workspace** | ユーザーと Site を束ねるテナント単位。メンバーは 1 つの Role を持つ |
| **Role** | OWNER / ADMIN / EDITOR / VIEWER の 4 種。EDITOR は作成・編集のみで本番化はできない(本番化 = Publish / Start / Pause / Stop は ADMIN 以上) |
| **Site** | 実験を配信する対象サイト。Deployment Mode・consentMode などの設定を持つ |

## 実験

| 用語 | 定義 |
|---|---|
| **Experiment** | A/B テストの 1 実験。URL 条件・Targeting・Variant を持つ。状態は draft / running / paused / archived |
| **Desired Status** | 運用者が意図した Experiment の状態(D1 上の `status`) |
| **Published Status** | 本番に反映済みの Snapshot におけるその Experiment の状態。Desired Status とズレたら UI が差分を表示する |
| **Variant** | Experiment 内の 1 パターン。重み(配分)と Change の集合を持つ |
| **Change** | ページへの 1 つの書き換え(TEXT / IMAGE / HIDE / ATTRIBUTE / HTML / CSS / CUSTOM_JS)。セレクタと value(書き換え内容の本体)を持つ |
| **Code Change** | HTML / CSS / CUSTOM_JS の Change の総称。任意コードを訪問者のブラウザで実行できる。下書きは全編集 Role が作成でき、本番化は ADMIN の Publish を経由することで統制する(旧称「特権 Change / 特権 Experiment」は廃止)。実行は `<script>` 要素の挿入(`new Function` / `eval` 不使用)で、設置タグの nonce を引き継ぐ。CUSTOM_JS は `function(element, ctx)`、`this` も `element`、`ctx = { experimentId, variantId, changeId }` |
| **Goal** | コンバージョン定義(PAGEVIEW / CLICK / CUSTOM) |
| **Targeting** | 配信対象の条件。Context 条件(URL / パス / ホスト / query / device / ブラウザ / OS / 画面の幅 / referrer / 曜日と時間帯 / 初回の訪問からの経過)と履歴条件(閲覧したページ・目標の達成。期間も指定できる)がある |
| **Audience** | Site ごとの名前付きの配信条件(例: 料金ページを 2 回以上見て、資料請求が未達成の人)。エクスペリエンスの Targeting から参照され、編集は次の Publish で参照するすべてのエクスペリエンスに効く。閲覧したページの条件はページの一致(URL / パス / ホスト)を直接書く |

## 本番化と配信

| 用語 | 定義 |
|---|---|
| **Publish** | Site 単位の本番反映操作。その Site の running な Experiment すべてを 1 つの Snapshot にコンパイルして配信に載せる。Start / Pause / Stop も内部的に Publish を伴う |
| **Snapshot** | 1 回の Publish が生成した不変の compiled config。version 番号を持つ(「Runtime Config」という呼称は廃止) |
| **compiled config** | Snapshot の実体。running な Experiment の実行に必要な最小限の JSON。runtime.js と結合して 1 ファイルで配信される |
| **runtime.js** | 訪問者のブラウザで動くエンジン。書き換えの適用・割当・計測を行う |
| **未公開の変更** | 最後に成功した Publish 以降に編集された内容。本番には反映されていない。UI がバッジ / バナーで可視化する |
| **Setup Token** | 初回セットアップ(`POST /setup`)専用の環境変数(`AB_SETUP_TOKEN`)。OWNER と最初の Workspace の作成後は無効化する(`wrangler secret delete`) |
| **招待リンク** | Workspace への招待を表す URL(`/invite/<id>`)。メール送信は行わず、発行者が手渡しする。7 日で失効する |

## 訪問者と識別

| 用語 | 定義 |
|---|---|
| **Visitor** | opaque な ID で識別される訪問者。PII は持たない |
| **Visitor Profile** | Durable Object 上に置く訪問者ごとの集計値(Goal 達成回数・パターン別閲覧回数・割当)。生イベントは保存しない。最終訪問から retentionDays で全削除 |
| **Deployment Mode** | 訪問者 ID の持続方法。A = JS Cookie、B = サーバー発行 Cookie(今は同一ゾーン Workers Route の Proxy Mode。Bridge 経由は Phase 2)、C = BYOID(既存 ID の流用) |
| **Bridge** | サイト自身のサーバーに置く `/__ab/*` の実装(アダプタ)。Phase 2 |
| **Proxy Mode** | edge Worker が Cookie の読取・発行を自ら行う動作モード |
| **サーバー発行 Cookie**(旧称 D-lite) | Mode B の表示名。サイトが Cloudflare 配下のとき、同一ゾーンの Workers Route で Proxy Mode を使う構成。現在の ITP 対応手段。識別子(`mode: "B"`・`dlite_hosts`・`/__ab/*`・コードとテストの名前)には旧称の `dlite` が残る |
| **BYOID** | Bring Your Own ID。サイトの既存 Cookie 等を訪問者 ID として流用する方式(Mode C)。値はハッシュ化してから送る |

## 計測

| 用語 | 定義 |
|---|---|
| **Decision** | 「この訪問者にどの Variant を出すか」の判定。ブラウザ内評価または edge への問い合わせ |
| **Exposure** | 実験が実際に訪問者へ提示されたことの記録。Change の適用成功後に 1 回だけ GA4(dataLayer)へ送る |
| **Conversion** | Goal の達成。GA4 へ `ab_conversion` として送る |
| **Analytics 命名設定** | dataLayer に push するオブジェクトの名札(イベント名・キー名・`extraKey`)をサイト単位、値(`experimentName` / `variantName` の上書きと `extra`)を Experiment / Variant 単位で設定する機能。無設定なら既定名 |
| **extra / extraKey** | Experiment / Variant が Exposure に足す任意の key-value(`extra`)と、それをネストするサイト単位の名前空間キー(`extraKey`、既定 `ab_extra`)。イベント push の直前に `{ [extraKey]: null }` を push して前の実験の値を消す |
| **exposurePayloads** | compile が Experiment × Variant ごとに合成・検証して compiled config に焼く解決済み Exposure の値。runtime はこれにサイト設定のキー名を当てて push するだけで合成しない |

## エージェント面

| 用語 | 定義 |
|---|---|
| **エージェント面** | 外部の AI エージェント(別プロジェクトの横断エージェント)が control を MCP / REST で直接操作するための面。本製品は LLM を呼ばず、GA4 / BQ の照会もヘッドレスブラウザも持たない。正は REST + OpenAPI、MCP は 1:1 の薄いラッパ、CLI は作らない |
| **API キー** | 非ブラウザから control を叩く長寿命の鍵(Better Auth `apiKey`、接頭辞 `wtt_`)。必ずユーザーに紐づき、権限はそのユーザーの Role。鍵固有のスコープは持たない |
| **エラー封筒** | control の全エラー応答の形 `{ error, message, hint?, path?, ...details }`。`error` は機械可読コード |
| **evaluate** | 割当の dry-run。URL / device / referrer / visitorId / 履歴を入力で与え、Experiment ごとに eligible と `reason`、variantId を返す |
| **draft-bootstrap** | 下書き Experiment を compile + bake した bootstrap JS。エージェントがヘッドレスブラウザに注入し `#__ab_preview` で Variant を固定して検証する |
| **analytics-recipe** | その Experiment の命名設定・期間・外部 ID を埋めた GA4 Data API リクエストと BigQuery SQL。数値は返さない(照会はエージェント側) |
| **agent-guide** | `docs/agent-guide.md`。人間向けの繋ぎ方とエージェント向けレシピ 4 本。control が `/llms.txt` として配る |
| **preview モード** | 対象ページを `#__ab_preview=<実験 ID>:<Variant ID>` で開いたときの runtime の動作。指定した実験だけを強制適用し、Cookie・consent・decision 通信・Goals・Exposure に触れない完全隔離。計測に混ざらない |
| **PreviewReport** | `window.AB.getPreviewReport()` が返す Change ごとの適用結果(`matched` / `applied` / `error`)。通常表示では `null` |

## UI 表記

- 管理画面・ドキュメントの日本語 UI では Experiment を「実験」と表記する(「エクスペリエンス」は使わない)
