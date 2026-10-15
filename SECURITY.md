# セキュリティ

## 脆弱性の報告

脆弱性を見つけた場合は、**公開の Issue ではなく**、GitHub の **Private vulnerability reporting** で報告してほしい(リポジトリの Security タブ → "Report a vulnerability")。

報告には、影響を受けるコンポーネント(edge / control / admin / runtime)、再現手順、想定される影響を書いてほしい。

## 対象

- `apps/edge`(訪問者に配る bootstrap / decision / event)
- `apps/control`(API、認証、API キー、Publish)
- `apps/admin`(管理画面と BFF)
- `packages/runtime`(訪問者のブラウザで動く runtime)

## サポートする版

修正は最新のリリースに対して行い、最新のリリースからの更新として出す。0.x の間は、古い版向けの修正版は出さない。

## 修正の知らせ

脆弱性の修正は Release として出し、Release ノート(必要に応じて GitHub Security Advisory)に、影響する版と更新しない場合の緩和策を書く。自動更新の仕組みは無いので、リポジトリの Watch → Custom で **Releases** を有効にしておくと、修正版の公開が通知で届く。
