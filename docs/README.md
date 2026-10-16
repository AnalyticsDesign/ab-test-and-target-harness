# docs

AB Test and Target Harness の文書一式。導入・運用のための手順書の一覧。

## 手順書

読む順は「導入構成の選び方 → デプロイ → サイト導入 → 運用 → 分析」。エージェントに操作させる場合はそのあとにエージェント向けガイドを読む。

| ファイル | 内容 |
|---|---|
| [../README.md](../README.md) | 入口。できること / できないこと、構成図、前提、導入の流れ、開発用のコマンドとディレクトリ |
| [install-questions.md](install-questions.md) | 導入の質問。AI エージェントに導入を任せるとき、やりたいことと今の環境を聞く質問の表と、答えから構成が決まるまでの流れ |
| [install-patterns.md](install-patterns.md) | 導入構成の選び方。ドメインの状態(edge の置き方 3 構成)、Free と Workers Paid の上限と目安、control の守り、付加機能ごとに要るもの、入力ファイルへの対応 |
| [deploy.md](deploy.md) | デプロイガイド。edge / control / admin を運用者の Cloudflare アカウントに置く手順(KV / D1 / R2 / DO / secrets、Cache Rule、初回セットアップ、更新順序、無認証入口の防御、非常時の入り方、稼働の確認、バックアップ・復旧・撤去) |
| [site-install.md](site-install.md) | サイト導入ガイド。最短手順のチェックリストから始まる 3 部構成: 設置の手順(サイトの作成、タグ、GA4 と GTM の配線(GTM インポート用 JSON あり)、設置後の確認、詰まったとき)/ 条件によって要る設定(consent、Mode C と Mode B、履歴条件、コードの変更と CSP)/ リファレンス(サイト設定項目、dataLayer の契約、ブラウザの制約、外部送信規律) |
| [operations.md](operations.md) | 運用ガイド。エクスペリエンスのライフサイクル、下書きプレビュー、公開の反映、開始直後のチェック、ロールと管理操作、レート制限の実効、既知の制約と課題、トラブルシュート |
| [analytics.md](analytics.md) | 分析ガイド。何が測れるか、前提の設定(カスタム定義 / BigQuery)、レシピの取得、方式 A(GA4 探索レポート)、方式 B(BigQuery)、GA4 Data API、結果の読み方 |
| [agent-guide.md](agent-guide.md) | エージェント向けガイド(正はこのリポジトリのこのファイル)。鍵の範囲と権限、API キー、レシピ 5 本(エクスペリエンスを作って公開まで / 下書きの検証 / 結果を読む / 配信条件の what-if / オーディエンス)、踏みやすい制約。control が `GET /llms.txt` で配る |
| [../deploy-answers.example.yaml](../deploy-answers.example.yaml) | リポジトリ直下。導入時の入力ファイルの雛形 |
