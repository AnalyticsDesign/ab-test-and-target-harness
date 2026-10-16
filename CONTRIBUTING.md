# 投稿について

## Issue

不具合の報告と機能の提案は Issue で受け付けている。**使い方の質問は [Discussions](https://github.com/AnalyticsDesign/ab-test-and-target-harness/discussions) の Q&A へ。** 不具合の報告には、再現手順・期待した動作・実際の動作・環境(Cloudflare のプラン、ブラウザ、Node のバージョン)を書いてほしい。

**脆弱性は Issue に書かないこと。** 報告の窓口は [SECURITY.md](SECURITY.md) を参照。

## Pull Request

開発は非公開のリポジトリで行っているため、**Pull Request をこのリポジトリで直接マージすることはない**。

- Pull Request は「変更の提案」として歓迎する
- 採否にかかわらず、Pull Request は最後に閉じる(閉じることは不採用を意味しない)
- 採用した場合は、開発リポジトリに取り込んだうえで次のリリースに含め、作者は commit の `Co-authored-by` に残す。Pull Request には取り込んだ版をコメントする
- 大きな変更は、作業を始める前に Issue で方向を相談してほしい

## 手元での確認

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm docs:check   # 文書を変えた場合
```

E2E(`pnpm e2e` / `pnpm e2e:admin`)は wrangler と Playwright を使う。手順は [README](README.md) の「開発」節を参照。
