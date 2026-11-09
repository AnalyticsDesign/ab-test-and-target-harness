# デプロイガイド

AB Test and Target Harness を運用者自身の Cloudflare アカウントへ配置する手順。

- **読者**: 人が読んで手で進めることも、AI エージェント(Claude Code / Codex など)に読ませて進めさせることもできる。エージェントに貼るだけのプロンプトは [README の「導入」](../README.md#導入)にある
- **前提知識**: Cloudflare と GA4 の基本操作。エージェントに任せる場合は、0 節の「人が行う」の表だけ分かればよい
- **この文書に無いもの**: 設置サイト側の作業(タグ・consent・GA4 の受け側)は[設置ガイド](site-install.md)。構成(ドメインの有無・料金プランなど)の判断の根拠は[導入構成の選び方](install-patterns.md)。構成そのものは 0.2 の質問と検査スクリプトで決まる

Workers Free では、本製品の重い管理操作が CPU 時間の上限(1 回 10 ms)を超えて動作しているため、今後、上限によって失敗する可能性があります。管理操作で CPU 時間の上限によるエラーが出た場合は、Workers Paid に切り替えてください。

Workers Paid で支出が上限に達したときに自動停止する機能はまだないため、管理画面の「[使用状況](operations.md#11-使用状況cloudflare-の上限)」で使用量を確認してください。

この文書の構成:

| 節 | 内容 | いつ読むか |
|---|---|---|
| 手で導入する最短の手順 | 既定の構成を手で進める 18 手順。コマンドは 0〜5 節と同じ | 手で導入する人の最初(エージェントは読まない) |
| 0 | 分担・構成の決定・取得・ツール・ログイン・人への依頼 | 導入の最初 |
| 1 | 前提と全体像(構成要素・使うリソース・制約) | 導入の前に一度 |
| 2〜4 | edge → control → admin のデプロイ | 導入 |
| 5 | 初回セットアップとスモーク(+ 5.1 エージェント向けの設定) | 導入の最後 |
| 6 | 更新(リリースタグ単位)と書き込みの凍結 | 版を上げるとき |
| 7〜8 | 無認証入口の防御 / 非常時の入り方 | 必要になったとき |
| 9〜10 | 稼働の確認 / バックアップ・復旧・撤去 | 運用 |

## 手で導入する最短の手順

この手順は、設置サイトのゾーンに edge を置く構成のもの。ほかの構成では、次に挙げる節の手順を本文で読み、最短の手順の該当する手順をそれに置き換える:

- 別のドメインに置く構成(`edge_address: custom-domain`): 0.4 のログインの後の確認の 4(ゾーンが有効になっているか)、0.5 の 2(`CF_TOKEN` が要る。DNS Read を含む)、2.3・2.4・2.9 (3)(4) の `custom-domain` のときの手順、3.4 の `AB_EDGE_ORIGIN`(`https://<edge のホスト>`)、5 節(`<設置タグのホスト>` = edge のホスト)と、1 節の制約 (3)
- `*.workers.dev` の構成(`edge_address: workers-dev`): 2.3・2.4・2.9 (3)(4)・3.4 の `workers-dev` のときの手順、5 節(`<設置タグのホスト>` = `wtt-static` の workers.dev のホスト)と、1 節の制約 (3)

人が手で既定の構成(0.1 の表)を導入するための、いちばん短い手順。コマンドはすべて 0〜5 節にあるものと同じで、`pnpm docs:check` が一致を検査する。ここには確認を 1 行ずつと、期待と違ったときに読む先だけを添えた。AI エージェントに任せる場合、エージェントはここを使わず 0 節から読む(README のプロンプトのとおり)。

Windows の Git Bash で確認コマンドの出力が期待と違う場合は、[引数のパスの書き換えの確認と対処](#git-bash-で確認コマンドの出力が期待と違うとき)も読んでください。

ここで動かす構成と、外れるときに読む先:

- 設置サイトのドメインが Cloudflare のゾーンにあり、DNS がプロキシ(オレンジの雲)になっている。edge と設置タグはそのゾーンの Workers Route で公開する(`<設置ホスト>/v1/*`・`/s/*`)。別のドメインに置く構成と `*.workers.dev` の構成で読む先は、上の 2 つの箇条
- control と管理画面は `*.workers.dev` のアドレスで公開する。自分のドメインに置くなら 3.6・4.2・7.1(このときは 0.5 の 2 のトークンも要る)
- 画像のアップロードに R2 を使う。使わない構成も手順 12 で選べる
- ゾーンの Cache Rule(2.6)と WAF Rate Limiting Rule(2.7)は推奨の保護設定で、動いた後に足せる。ここでは作らない。作るときは 0.5 の 2 のトークンが要る。Mode B(サーバー発行 Cookie)のサイトを置くなら 2.7 は必須。WAF を作らないので、edge の Rate Limiting binding の値は手順 8 で 200 にする(後から 2.7 で WAF を作ったら、2.3 の規則で書き直す)

ここで使う値。手を動かす前に控える。0.2 の入力ファイルはエージェントが質問の答えを記録するためのもので、手で進めるときは作らなくてよい。

| 書き方 | 値 | 決め方 |
|---|---|---|
| `<設置ホスト>` | タグを置くサイトのホスト名(例 `www.example.com`) | 設置サイト |
| `<ゾーン名>` | そのホストの Cloudflare のゾーン(例 `example.com`) | ダッシュボードのゾーンの一覧 |
| `<edge のホスト>` | 別のドメインに置く構成のときだけ。edge と設置タグを置く別のドメインのホスト(例 `ab.example.net`)。この構成では `<ゾーン名>` はこのホストのゾーン(例 `example.net`) | 0.2 の E2c |
| `<Account ID>` | Cloudflare のアカウント ID(32 桁) | 手順 4 の `wrangler whoami` |
| `<アカウントのサブドメイン>` | workers.dev のサブドメイン(例 `quiet-river-1a2b`) | 手順 5 の最初のコマンド |
| `<control URL>` | `https://wtt-control.<アカウントのサブドメイン>.workers.dev` | 上から決まる。Google に登録するリダイレクト URI の元 |
| `<AB_ADMIN_URL>` | `https://wtt-admin.<アカウントのサブドメイン>.workers.dev` | 上から決まる |
| `<owner_email>` | 管理画面にログインする Google アカウントのメールアドレス | 自分 |

ダッシュボードで作るものは 3 つ(Google の OAuth クライアント・Cloudflare の API トークン 2 本)。R2 を使うなら R2 の有効化が加わる。コマンドのブロックは 30 ほど。

**1. ツールを入れる**(0.4)

Git・Node 24 以上(LTS)・jq を入れ、リポジトリ直下で `corepack enable`(pnpm は単体で入れない)。Windows は Git for Windows の Git Bash で、ここにあるすべてのコマンドを実行する。

```bash
node -v      # v24 以上
pnpm -v      # リポジトリ直下で。package.json の packageManager の版(例 pnpm@10.34.5 なら 10.34.5)
jq --version # jq-1.7 以上
git --version
bash --version | head -1   # GNU bash
openssl version            # 乱数の生成に使う
```

期待と違えば 0.4 の「期待と違うとき」を読む(`corepack: command not found`、pnpm の版の違い、Windows で見つからない)。

**2. 本体を取得する**(0.3)

```bash
git clone https://github.com/AnalyticsDesign/ab-test-and-target-harness.git
cd ab-test-and-target-harness
git tag --list 'v*' --sort=-v:refname | head -5     # 使える tag。release_tag が latest なら先頭
git checkout v0.9                                    # 入れる tag に読み替える
git describe --tags --exact-match                    # 期待: 今 checkout した tag 名。それ以外なら checkout に失敗している
pnpm install
```

確認: `git describe` が checkout した tag 名を返す。入れた tag 名は控える。更新は 6 節で「現在の tag → 目標の tag」として行う。

**3. Cloudflare にログインする**(0.4)

```bash
pnpm -C apps/control exec wrangler login
```

ブラウザに出る Cloudflare の画面で、導入するアカウントで Allow を押す。確認: `pnpm -C apps/control exec wrangler whoami` にアカウント名と Account ID が出る。`<Account ID>` を控える。

アカウントが 2 つ以上出たら、導入先を固定する。以後、新しいシェルを開くたびに設定する:

```bash
export CLOUDFLARE_ACCOUNT_ID=<導入先の Account ID>   # エージェントは以後のシェルでも毎回これを設定する
```

ブラウザが開かない・この製品が既に入っていないかの確認は 0.4 の「ログイン」「ログインの後の確認」。

**4. workers.dev のサブドメインを確かめる**(0.5)

```bash
T=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
AID=${CLOUDFLARE_ACCOUNT_ID:-$(pnpm -C apps/control exec wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}   # 複数アカウントなら 0.4 で固定した CLOUDFLARE_ACCOUNT_ID が使われる
curl -sS "https://api.cloudflare.com/client/v4/accounts/$AID/workers/subdomain" -H "Authorization: Bearer $T" | jq '{subdomain: .result.subdomain, errors: [.errors[]?.code]}'   # 期待: subdomain = <アカウントのサブドメイン>(例 quiet-river-1a2b)
```

確認: `subdomain` に名前が出る。それが `<アカウントのサブドメイン>`。`errors` に `10007` が出る(まだ無い)→ ダッシュボードの Compute(コンピュート)→ Workers & Pages を一度開くと作られるので、開いてからやり直す。名前を自分で決めたいなら、0.5 の「サブドメインの名前の決め方」とその下のブロックを使う。

**5. ダッシュボードで作る**(0.5)

リポジトリ直下に `deploy-secrets.env` を作り、作った値を貼っていく。このファイルは git 管理外。作るときは、所有者だけが読める権限にする(macOS / Linux / Git Bash の例: `[ -e deploy-secrets.env ] || (umask 077 && touch deploy-secrets.env); chmod 600 deploy-secrets.env`)。形:

```bash
GOOGLE_CLIENT_ID=<クライアント ID>          # 秘密ではないが受け渡しをまとめるためここに書く。3.4 の vars に入る
GOOGLE_CLIENT_SECRET=<クライアント シークレット>
CF_TOKEN=<Cloudflare API トークン>          # route・custom-domain のとき、または control・管理画面を自分のドメインに置くとき
CF_DEPLOY_TOKEN=<配信ファイルのデプロイ用トークン>   # どの構成でも要る
CF_USAGE_TOKEN=<使用状況の表示用トークン>   # どの構成でも要る
```

- **Google の OAuth クライアント**: `https://console.cloud.google.com/auth/overview` で、プロジェクト(新しく作るなら `wtt-auth`)→ Get started(開始)の 4 段の入力(新しいプロジェクトのときだけ)→ Audience(対象)→ Clients(クライアント)の順に進む。種類は Web application(ウェブ アプリケーション)、リダイレクト URI は `<control URL>/auth/callback/google` を 1 つ。画面ごとの決めることと推奨は 0.5 の 1 の表。Client ID と Client secret を `GOOGLE_CLIENT_ID=` / `GOOGLE_CLIENT_SECRET=` に書く
- **配信ファイルのデプロイ用トークン**: My Profile(マイ プロフィール)→ API Tokens(API トークン)→ Create Token(トークンを作成する)→ Custom token(カスタム トークン)。名前は `wtt-deploy-<アカウントのサブドメイン>`。権限は Account(アカウント)→ Workers Scripts(Workers スクリプト)→ Edit(編集)のみ。Account Resources(アカウント リソース)は導入先のアカウントだけで、期限なし。値を `CF_DEPLOY_TOKEN=` に書く(0.5 の 3)
- **使用状況の表示用トークン**: 同じ画面で作る。名前は `wtt-usage-<アカウントのサブドメイン>`。権限は Account(アカウント)→ Account Analytics(アカウント分析)→ Read(読み取り)のみで、期限なし。値を `CF_USAGE_TOKEN=` に書く(0.5 の 4)
- `CF_TOKEN` の行は、2.6・2.7 を後で足すときに使う(0.5 の 2)。ここでは空のままでよい

確認。値は画面に出ない:

```bash
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
{ [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; } && echo google=ok || echo google=missing   # missing なら人に記入を頼み直す(この先で空の値を登録しない)
[ -n "$CF_TOKEN" ] && echo cf_token=present || echo cf_token=missing   # edge_address が route か custom-domain、または control_address か admin_address が custom なら present が期待(それ以外は missing でよい)
[ -z "$CF_TOKEN" ] || curl -sS https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CF_TOKEN" | jq -r .result.status   # 期待: active
[ -n "$CF_DEPLOY_TOKEN" ] && echo cf_deploy_token=present || echo cf_deploy_token=missing   # 期待: present(どの構成でも要る。missing なら人に頼み直す)
[ -z "$CF_DEPLOY_TOKEN" ] || curl -sS https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CF_DEPLOY_TOKEN" | jq -r .result.status   # 期待: active
[ -n "$CF_USAGE_TOKEN" ] && echo cf_usage_token=present || echo cf_usage_token=missing   # 期待: present(missing なら人に頼み直す)
```

期待: `google=ok`、`cf_deploy_token=present` と `active`、`cf_usage_token=present`。ここでは `cf_token=missing` で問題ない。

**6. runtime を生成する**(2.1)

```bash
pnpm runtime:build
```

確認: `git status --short packages/runtime/generated/` が空。差分が出ても進んでよい(2.1 の「期待と違うとき」)。

**7. KV と計測用のデータベースを作る**(2.2)

```bash
pnpm -C apps/control exec wrangler kv namespace create wtt-config </dev/null   # </dev/null = 「設定ファイルに追記するか」の問いを非対話にして、追記しない(id は下の手順で書く)
```

出力の `id` の 32 桁を、`apps/edge/wrangler.jsonc` と `apps/control/wrangler.jsonc` の両方の `kv_namespaces[0].id` に書く。`Would you like Wrangler to add it on your behalf?` と聞かれたら No。確認は 2.2 のブロックで行う。両ファイルに同じ id が 1 回ずつあり、雛形の 32 桁の 0 が残っていなければよい。

続けて、テストの結果を記録する計測用のデータベース(D1 の `wtt-results`)を作る:

```bash
pnpm -C apps/edge exec wrangler d1 create wtt-results </dev/null   # KV と同じく、設定ファイルへの追記は非対話なので行わない(database_id は下の手順で書く)
```

出力の `database_id` を、`apps/edge/wrangler.jsonc` の `d1_databases[0].database_id` と、`apps/control/wrangler.jsonc` の `RESULTS_DB` の行(`d1_databases[1].database_id`)の両方に書く(雛形の値は仮の ID `00000000-0000-0000-0000-000000000000`)。追記の問いには No と答える。書いたら、表を作り、訪問者 ID を変換する鍵を登録する:

```bash
pnpm -C apps/edge results:migrate:remote   # 表を作る。期待: 0001_results.sql が適用される(適用済みなら No migrations to apply)
```

```bash
openssl rand -base64 32 | pnpm -C apps/edge exec wrangler secret put RESULTS_VISITOR_KEY   # 鍵を作り、画面に出さずに edge の secret に入れる
```

確認は 2.2 の「計測用のデータベース」の確認のブロックで行う。鍵を変えると同じ訪問者が別の人として記録されるので、一度登録したら変えない。

**8. Route を書く**(2.3)

先に、`apps/edge/wrangler.jsonc` の `ratelimits` の行の `"limit": 1000` を `200` に書き換える。この手順では WAF を作らないので、2.3 の「WAF が無い構成」の値にする。後から 2.7 で WAF を作ったら、2.3 の規則で書き直して edge を deploy し直す。

続けて、`apps/edge/wrangler.jsonc` の `routes` を次にする。`<設置ホスト>`・`<ゾーン名>` は実際の値に置き換える:

```jsonc
"routes": [
  { "pattern": "<設置ホスト>/v1/*", "zone_name": "<ゾーン名>" }
],
"dev": { "host": "localhost" }
```

確認。そのパスにサイトの既存のコンテンツが無いことを見る:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://<設置ホスト>/s/probe.js"   # 期待: 404(サイト本体にそのパスが無い)
curl -sS -o /dev/null -w '%{http_code}\n' "https://<設置ホスト>/v1/sites/probe/decision"   # 期待: 404(同上)
```

200 が返る → 2.3 の「期待と違うとき」。Mode B のサイトを置くなら `/__ab/*` の Route も足す(2.3 の「パスごとの意味」)。

**9. edge をデプロイする**(2.4)

```bash
pnpm -C apps/edge exec wrangler deploy
```

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "https://<設置ホスト>/v1/sites/probe/decision"   # 期待: 404 text/plain(Worker の応答。サイト本体の 404 ページ(text/html)ではない)
```

`text/html` が返る → Route が適用されていない(2.4 の「期待と違うとき」)。

**10. 設置タグを配る 2 つの Worker を置く**(2.9)

`apps/deployer/wrangler.jsonc` の `vars.CF_ACCOUNT_ID` を `<Account ID>` にしてから:

```bash
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
pnpm -C apps/deployer exec wrangler deploy
if [ -n "$CF_DEPLOY_TOKEN" ]; then printf '%s' "$CF_DEPLOY_TOKEN" | pnpm -C apps/deployer exec wrangler secret put CF_DEPLOY_TOKEN; else echo "CF_DEPLOY_TOKEN is empty: load deploy-secrets.env (0.5)"; fi
pnpm -C apps/deployer exec wrangler secret list | jq -r '.[].name'   # 期待: CF_DEPLOY_TOKEN
```

```bash
export CLOUDFLARE_API_TOKEN=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
export CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-<0.4 で確かめた Account ID>}
pnpm -C apps/deployer setup-static -- --route "<設置ホスト>/s/*" --zone "<ゾーン名>" --workers-dev off
# 期待: script: created / route <設置ホスト>/s/*: created / workers.dev: off
```

```bash
HASH=$(grep -o 'PREVIEW_HASH = "[0-9a-f]*"' packages/runtime/generated/source.ts | grep -o '"[0-9a-f]*"' | tr -d '"')
curl -sS -o /dev/null -w '%{http_code}\n' "https://<設置タグのホスト>/s/preview/$HASH.js"   # 期待: 200
curl -sS -o /dev/null -w '%{http_code}\n' "https://<設置タグのホスト>/s/nosuch.js"           # 期待: 404(存在しないサイト)
```

`<設置タグのホスト>` = `<設置ホスト>`。`moved from` / `exists (kept)` / `zone not found` が出たら 2.9 の「期待と違うとき」。`wtt-static` には `wrangler deploy` を使わない。

**11. D1 を作る**(3.1)

```bash
pnpm -C apps/control exec wrangler d1 create wtt-control </dev/null   # 2.2 と同じく、設定ファイルへの追記は非対話なので行わない
```

出力の `database_id` を `apps/control/wrangler.jsonc` の `d1_databases[0].database_id` に書く。追記の問いには No と答える。

**12. 画像の置き場を決める**(3.2)

- **R2 を使わない**: `apps/control/wrangler.jsonc` の `r2_buckets` の行を削除し、手順 14 の `AB_ASSET_PUBLIC_BASE` を書かない。画像アップロードと IMAGE の変更が無効になるだけで、ほかは同じ(3.2 の「`none` のとき」)
- **R2 を使う**: ダッシュボードの Storage & databases(ストレージとデータベース)→ R2 Object Storage(R2 オブジェクトストレージ)で有効化する。支払い方法の登録を求められることがあるが、無料枠内なら請求は無い。次にバケットを作り、公開用のドメインをつなぐ。公開用のドメインは、Cloudflare に追加した自分のゾーンのホストにする(例 `wtt-assets.<ゾーン名>`)。ゾーンを持たない構成では、R2 用にドメインを 1 つ追加するか、下の `dev-assets` を使う。画像を本番で使うなら、`dev-assets` ではなくカスタムドメインを勧める(画像を使い始めた後に切り替えると、それまでの画像の URL が読めなくなる。3.2 の (3)):

```bash
pnpm -C apps/control exec wrangler r2 bucket create wtt-assets </dev/null   # 2.2 と同じく、設定ファイルへの追記は非対話なので行わない
```

```bash
ZID=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=<ゾーン名>" -H "Authorization: Bearer $(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)" | jq -r '.result[0].id')
pnpm -C apps/control exec wrangler r2 bucket domain add wtt-assets --domain <assets.example.com> --zone-id "$ZID" --min-tls 1.2 --force
pnpm -C apps/control exec wrangler r2 bucket domain list wtt-assets   # 期待: 上のドメインが一覧に出る(有効になるまで数分かかることがある)
curl -sS -o /dev/null -w '%{http_code}\n' "https://<assets.example.com>/"   # 期待: 404(バケットに届いている)
```

`code: 10042` → R2 が有効化されていない。`403` / `pending` → 反映待ち(3.2 の「期待と違うとき」)。ドメインをつながずに始めるなら、`AB_ASSET_PUBLIC_BASE` を `<control URL>/dev-assets` にしてもよい(3.2 の (3))。

**13. secrets を登録する**(3.3)

```bash
# 32 バイト以上のランダム文字列。Better Auth のセッション署名鍵
openssl rand -hex 32 | pnpm -C apps/control exec wrangler secret put BETTER_AUTH_SECRET

# 初回セットアップ専用の使い捨てトークン AB_SETUP_TOKEN は 5 節で生成・登録・使用・削除を 1 つのブロックで行う(ここでは置かない)

# 0.5 で受け取った Google のクライアント シークレット(クライアント ID のほうは 3.4 の vars)
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
if [ -n "$GOOGLE_CLIENT_SECRET" ]; then printf '%s' "$GOOGLE_CLIENT_SECRET" | pnpm -C apps/control exec wrangler secret put AB_GOOGLE_CLIENT_SECRET; else echo "GOOGLE_CLIENT_SECRET is empty: load deploy-secrets.env (0.5)"; fi

# 管理画面の使用状況の表示用(0.5 の (4) で受け取った Account Analytics: Read のみのトークン)
if [ -n "$CF_USAGE_TOKEN" ]; then printf '%s' "$CF_USAGE_TOKEN" | pnpm -C apps/control exec wrangler secret put CF_USAGE_TOKEN; else echo "CF_USAGE_TOKEN is empty: load deploy-secrets.env (0.5)"; fi
```

```bash
pnpm -C apps/control exec wrangler secret list | jq -r '.[].name' | sort   # 期待: AB_GOOGLE_CLIENT_SECRET と BETTER_AUTH_SECRET と CF_USAGE_TOKEN(AB_SETUP_TOKEN は 5 節で作る)
```

**14. control の vars を書く**(3.4)

`apps/control/wrangler.jsonc` の `vars`:

| キー | この構成での値 |
|---|---|
| `AB_ADMIN_URL` | `<AB_ADMIN_URL>` |
| `AB_CONTROL_URL` | `<control URL>` |
| `AB_ASSET_PUBLIC_BASE` | 手順 12 でつないだドメイン(`https://wtt-assets.<ゾーン名>`)か `<control URL>/dev-assets`。R2 を使わないなら書かない |
| `AB_ASSET_MAX_MB` | アップロード 1 件の上限(MB)。例 `"5"` |
| `AB_ASSET_SITE_MAX_MB` / `AB_ASSET_SITE_MAX_COUNT` | 書かなくてよい。書かなければ 1 サイトあたり合計 1024 MB・1,000 枚(3.4) |
| `AB_GOOGLE_CLIENT_ID` | `deploy-secrets.env` の `GOOGLE_CLIENT_ID` の値 |
| `AB_EDGE_ORIGIN` | `https://<設置ホスト>` |
| `CF_ACCOUNT_ID` | `<Account ID>` |
| `AB_USAGE_RESOURCES` | `d1` に手順 11 の `database_id`(`wtt-control`)と手順 7 の `database_id`(`wtt-results`)、`kv` に手順 7 の KV の id を JSON のオブジェクトで書く(形は 3.4 の表) |

**15. control をデプロイする**(3.5)

```bash
pnpm -C apps/control d1:migrate:remote
pnpm -C apps/control exec wrangler deploy
```

```bash
# control の URL は上の deploy の出力(https://wtt-control.<アカウントのサブドメイン>.workers.dev)から拾う
curl -sS "<control URL>/llms.txt" -o /dev/null -w '%{http_code}\n'   # 期待: 200(認証不要のガイド本文。control に /healthz は無い)
```

deploy の出力の URL が `<control URL>`(Google に登録したリダイレクト URI の元)と一致すること。直後の 404 / `error code: 1042` は反映待ちなので 30 秒待つ(3.5 の「期待と違うとき」)。

**16. 管理画面をデプロイする**(4 節)

`apps/admin/wrangler.jsonc` の `vars.AB_CONTROL_URL` を `<control URL>` にしてから:

```bash
pnpm -C apps/admin build      # vinext build。dist/ 配下に生成設定(wrangler.json)と dist/client を出す
pnpm -C apps/admin deploy:cf  # wrangler deploy --config <ビルドが出した生成設定>
```

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "<AB_ADMIN_URL>/setup"                 # 期待: 200(画面が出る)
curl -sS -w '\n%{http_code}\n' "<AB_ADMIN_URL>/api/control/me"                     # 期待: {"error":"unauthorized",...} と 401(admin → control が通っている)
```

404 / 502 / ログイン後の 401 は 4.4 の「期待と違うとき」。

**17. オーナーを登録してログインする**(5 節)

`<owner_email>` と `<workspace_name>` に値を入れ、`<usage_visibility>` には `members` を入れて、1 つのシェルで続けて実行する。`<workspace_name>` はワークスペースの名前で、管理画面のサイドバーに出る。後から変えられる:

```bash
SETUP_TOKEN=$(openssl rand -hex 16) \
&& printf '%s' "$SETUP_TOKEN" | pnpm -C apps/control exec wrangler secret put AB_SETUP_TOKEN \
&& sleep 10 \
&& curl -sS -X POST "<control URL>/setup" -H "X-Setup-Token: $SETUP_TOKEN" -H 'content-type: application/json' \
     -d '{"email":"<owner_email>","workspaceName":"<workspace_name>","usageVisibility":"<usage_visibility>"}' -w '\n%{http_code}\n'   # 期待: {"workspaceId":"…","userId":"…"} と 201
```

403 `setup_closed` → 30 秒待って同じブロックをもう一度(5 節の「期待と違うとき」)。201 が返ったら `<AB_ADMIN_URL>/login` を開き、「Google でログイン」から `<owner_email>` でログインする。管理画面が開いたら使い捨てトークンを消す:

```bash
pnpm -C apps/control exec wrangler secret delete AB_SETUP_TOKEN
curl -sS "<control URL>/login-options"   # 期待: {"google":true,"passwordLogin":false}
```

**18. サイトを作って動作を確かめる**(5 節)

管理画面でサイトを作り、エクスペリエンスを作って開始する。サイトの項目は[サイト導入ガイド 2 節](site-install.md#2-サイトを作る)にある。サイト ID は後から変えられない。設置タグのファイルが配られていることを確かめる:

```bash
curl -s https://<設置タグのホスト>/s/<siteId>.js | head -c 400
```

先頭付近に config のバージョンとエクスペリエンス ID が含まれていれば、control → デプロイ専用の Worker → 配信専用の Worker の経路が動作している。404 なら 5 節の「期待と違うとき」。確かめたらエクスペリエンスを終了(元に戻せません)し、`rm deploy-secrets.env` を実行する。

ここまでで導入は終わり。次に読むもの:

- サイトにタグを置く: [サイト導入ガイド](site-install.md)
- 動いた後に足す推奨の保護設定: 2.6 Cache Rule・2.7 WAF Rate Limiting Rule。先に 0.5 の 2 のトークンを作る。Mode B のサイトを置くなら 2.7 は必須
- AI エージェントに API を使わせる: 5.1
- 版を上げる・保護する・戻す: 6 節以降(この文書の構成の表)

## 0. 進め方(人と AI エージェントの分担)

各手順は「実行するコマンド → 確認(期待する出力)→ 期待と違うとき(その対応)」の順に書いてある。エージェントは上から順に実行し、人に頼むのは **【人が行う】** と **【人に依頼】** のラベルが付いた工程だけ。

- **【人が行う】** = 人だけができる操作(下の 1 つ目の表)。構成によって無いものもある。アカウントの作成と `plan: paid` の切り替えは構成しだいで、5.1 は断れば無い。8 節は持たなければ無い
- **【人に依頼】** = ダッシュボードや端末での操作を頼むもの(下の 2 つ目の表)。0.5 節で一度に集めて頼む。どの構成でも要るのは Google の OAuth クライアント・配信ファイルのデプロイ用トークン・使用状況の表示用トークンの 3 つ。ゾーンありの構成ではこれに Cloudflare API トークン 1 本が加わる。それ以外は構成によって要否が変わる

| 工程 | 誰が | 理由 |
|---|---|---|
| Cloudflare のアカウントを作る(0.4 の「アカウントを作る」)。`cloudflare_account: none / separate` のときだけ、`wrangler login` の前に行う | 【人が行う】 | 登録とメールの確認はブラウザで人だけができる。エージェントは手順を書き換えずに人に示す |
| `wrangler login` の許可(0.4) | 【人が行う】 | コマンドはエージェントが実行し、人はブラウザに出る Cloudflare の画面で許可を押す。Cloudflare のパスワードをエージェントに伝えない |
| 初回セットアップ後の Google ログイン(5 節) | 【人が行う】 | オーナーと最初のワークスペースの登録はエージェントが API で行う(入力ファイルの `owner_email` / `workspace_name`)。人は完了後に同じ Google アカウントでログインするだけ |
| スモーク(5 節。サイト / エクスペリエンスを作って開始 → 終了) | 【人が行う】 | 管理画面の操作。エージェントは確認コマンドだけ用意する |
| プランを Workers Paid にする(5 節の「`plan: paid` のとき」)。`plan: paid` のときだけ | 【人が行う】 | 管理画面の使用状況の設定。スモークのついでに行う |
| エージェント用の API キーの発行(5.1。任意) | 【人が行う】 | 鍵の発行は管理画面でだけ行える。エージェント向けの設定を断った場合は無い |
| 非常時の入り方(8 節)。更新手順 6.3 から参照する「念のため置く」も含む | 【人が行う】 | 非常用トークンと再設定リンクは、持っていればオーナーのアカウントに入れる秘密。エージェントの会話や端末の出力に残さない。扱いは API キーと同じ(下の「API キーの受け渡し」) |
| それ以外(リソースの作成・設定ファイルの編集・secret の登録・deploy・Cache Rule / WAF・確認コマンド) | エージェント(または人) | すべてコマンドで完結する |

| 人に頼む工程(【人に依頼】)| いつ |
|---|---|
| Google Cloud で OAuth クライアントを作り、ID とシークレットを伝える。リダイレクト URI もこのとき登録する | 初回のみ。0.5 で一度に |
| 別のドメインを導入に使うアカウントに追加する(そのドメインのネームサーバーを Cloudflare に切り替える) | `edge_address: custom-domain` で、まだ追加していないとき。0.4 のログインの後の確認で分かる |
| ゾーンの設定用の Cloudflare API トークン(Cache Rules / WAF / Zone Read / DNS Read、期限 = 翌日、ゾーン限定)を発行して伝える | ゾーンのある構成(`edge_address` が `route` か `custom-domain`)のときと、control か管理画面を自分のドメインに置くとき(`control_address` か `admin_address` が `custom`)。0.5 で一度に。失効は期限切れに任せる |
| 配信ファイルのデプロイ用トークンと使用状況の表示用トークンを発行して伝える。権限は前者が Workers Scripts の Edit のみ、後者が Account Analytics の Read のみ。どちらもアカウント単位で、期限なし | 初回のみ(どの構成でも)。0.5 で一度に |
| R2 の有効化 | 初回のみ。`code: 10042` が出たとき |
| ダッシュボードで Workers Paid に切り替える | `plan: paid` で、アカウントがまだ Free のとき。0.5 で一度に |
| ダッシュボードの Workers & Pages を一度開く | 0.5 でサブドメインを API で作れなかったときだけ |
| 更新時の設定の再保存 | 6.4 で (b) があるとき |
| ゾーンのレート制限ルールの式の書き換え・回数の変更(Free で 1 本のルールをほかの用途と分け合うとき) | 2.7 で既存のルールに OR で足すとき、7.2 で control のパスを足して 1 本にしたルールの回数を変えるとき |
| 撤去時の R2 の中身の削除、OAuth クライアント・API トークン・Access の削除。別のドメインに置く構成では、DNS レコードが消えたことの確認と証明書の削除 | 10.4 |

**ダッシュボードの画面名の書き方**(この文書と、エージェントが人に示す依頼文の両方):

- Cloudflare と Google Cloud の画面のメニュー・タブ・ボタンの名前は、英語の表示(日本語の表示)の順で併記する。例: Storage & databases(ストレージとデータベース)→ R2 Object Storage(R2 オブジェクトストレージ)。両方が同じ名前なら 1 つだけ書く
- Cloudflare の既定は英語で、My Profile(マイ プロフィール)→ Settings(設定)→ Language(言語)で日本語に変えられる
- エージェントは、人の画面の言語が分かればその言語の名前だけを示してよい。分からなければ併記のまま示す

### エージェントの作業規則

ここから 0.1 の前までは、エージェントに任せる場合の規則。人が手で進めるときは読み飛ばしてよい。

**作業ログ**: `deploy-log.md` に残す。置き場所はリポジトリ直下で、git には入らない。書くのは、各手順の開始時刻(`date -u +%FT%TZ` の出力)、実行したコマンド、期待と違った出力、人に聞いた項目と答え、迷った箇所。秘密(トークン・パスワード・`BETTER_AUTH_SECRET`)は書かない。困ったときの問い合わせ材料になる。

**エージェントが実行できるコマンドは、人に実行を頼まない**。人に頼むのは【人が行う】と【人に依頼】の箇所の、画面での操作だけにする。コマンドの実行を人に頼むのは、エージェントの環境で実行できなかったときに限る(0.4 の `wrangler login` の「期待と違うとき」など)。

**人に実行してもらうコマンドの示し方**。エージェントの実行環境と人の端末は同じとは限らない。Windows では、エージェントが入れたグローバルのツールが人の端末から見えないことがある。リポジトリのフォルダは共有される。人に示すコマンドは次の形にする:

- 実行する場所(リポジトリのフォルダ)を毎回添える。Windows は Git Bash を推奨する
- `cd … &&` でつながず、リポジトリ直下で実行する 1 行にする。Windows PowerShell 5.1 は `&&` を解釈しない
- `pnpm` を介さず、リポジトリ内の wrangler を直接呼ぶ。Windows では PowerShell 用の 1 行も併記する:

```bash
./apps/control/node_modules/.bin/wrangler login          # macOS / Linux / Git Bash
```

```powershell
& .\apps\control\node_modules\.bin\wrangler.CMD login     # Windows PowerShell
```

Windows のエージェントが複数行のブロックを実行するときは、`bash -c` で実行すると出力が取れないことがある。ファイルに書いて `bash <ファイル>` で実行する。

**管理画面での操作が要る工程の進め方**(更新後の公開・エクスペリエンスの状態の変更など):

- ブラウザを自動で操作しない。ブラウザの拡張機能やヘッドレスブラウザも使わない。ログインの状態や画面の読み込みに左右されて作業が中断しやすく、人の Google アカウントのセッションで操作することにもなるため。管理画面での操作が要る工程は、control の API で行うか、人に頼む
- API でも画面でもできる工程は、両方の手順を示して人に選んでもらう
  - (a) API: その操作に要る権限の鍵(公開・状態の変更は管理者)を 5.1 の `.env.agent` に置き、エージェントが実行して応答の JSON を確かめる。公開の前には `GET /sites/<siteId>/publish-preview` で確認画面と同じ内容を読み、人に見せてから実行する。この内容には、公開が止まる理由の `compileError` も含まれる
  - (b) 画面: どの画面のどのボタンを押し、何が表示されれば成功かを書く。失敗の表示が出たら、その文言を要約せずに伝えてもらう

**API キーの受け渡し**(`wtt_` で始まる API キー):

- 人に鍵をチャットへ貼らせない。エージェントの画面から実行するコマンド(例: Claude Code の `!` 付きの入力)も会話の記録に残るので使わせない
- エージェントが値の空いた `.env.agent` を先に作り(5.1 の 2)、人は自分のエディタか、エージェントとは別のターミナルで書き込む。依頼文にはこの注意を必ず書く
- ターミナルで書く場合は、鍵がコマンドの履歴に残らない形にする。macOS / Linux / Git Bash の例: `read -rs K && printf 'AB_API_KEY=%s\n' "$K" >> .env.agent && unset K` を実行して鍵を貼り Enter を押す。追記した後ろの行の値が使われる。Windows PowerShell ではエディタで書く
- エージェントは鍵の値を表示しない
- 導入と運用は、自分だけが使う端末で行う。手順のコマンドの多くは鍵を curl の引数に入れるので、他の人も使う端末(共用の Mac・サーバー)では、他のアカウントが実行中のコマンドの引数から鍵を読めるため
- 更新のためだけに発行した鍵は、有効期限を 1 日にして発行する。作業が終わったら人に失効してもらい(左メニューの下の「設定」→「API キー」)、エージェントは `.env.agent` を消す。失効したことは、消す前に `curl -sS -o /dev/null -w '%{http_code}\n' "$AB_CONTROL_URL/me" -H "Authorization: Bearer $AB_API_KEY"` が 401 を返すことで確かめる

### 0.1 既定の構成

AI エージェントに任せる場合、構成は 0.2 の質問と検査スクリプトで決まる。この表を読んで選ぶ必要は無い。手で導入する場合は、この既定の構成で動かし、変えたい項目だけ 0.2 の入力ファイルの下段で指定する。

| 項目 | 既定 | 変える理由の例 | 詳細 |
|---|---|---|---|
| edge の公開 | 設置サイトのゾーンの Workers Route(`<設置ホスト>/v1/*`) | 別のドメインに置きたい(サイトのドメインが Cloudflare に無い)/ ドメインを用意せずに *.workers.dev で公開したい(簡易的な導入) | 2.3 / 2.5 / 2.8 |
| 設置タグの配信 | 配信専用の Worker `wtt-static` を `<設置ホスト>/s/*` に置く。訪問者のタグの読み込みは Worker のリクエストに数えられない | 別のドメインに置く構成では `<edge のホスト>/s/*` に置く。ドメインなし構成(`*.workers.dev`)では `wtt-static` の workers.dev のアドレスで配る | 2.9 |
| control の公開アドレス | `https://wtt-control.<アカウントのサブドメイン>.workers.dev` | 自分のドメインに置いて WAF / Access を掛けたい | 3.6 / 7.1 |
| control の無認証入口の防御 | (1) 何もしない(ログインは Google アカウントで、パスワードの経路は普段閉じている) | 複数人で使う、外部エージェントに API を呼び出させる | 7 節。(2)(3) は実機未検証 |
| edge の WAF Rate Limiting Rule | 作る(200 回 / 10 秒) | 既に別のレート制限ルールで Free の 1 枠を使っている | 2.7 |
| 画像の公開ベース | 必ず指定する。R2 のカスタムドメイン、暫定の dev-assets、または none(R2 を使わない)。検査スクリプトは `auto` = `https://wtt-assets.<ゾーン名>` を書く | 支払い方法を登録せずに導入したい(none) | 3.2 |
| 管理画面の公開アドレス | `https://wtt-admin.<アカウントのサブドメイン>.workers.dev` | 自分のドメインに置いてリンクの見た目を整える / Access・WAF を掛ける | 4.2 |

### 0.2 構成を決める(質問と入力ファイル `deploy-answers.yaml`)

リポジトリ直下の `deploy-answers.example.yaml` を `deploy-answers.yaml` にコピーして使う。`deploy-answers.yaml` は git には入らない。

このファイルは「導入時の質問への答え」であって設定値ではない。導入後に書き換えても環境は変わらない。稼働中の設定は `apps/edge/wrangler.jsonc` / `apps/control/wrangler.jsonc` / `apps/admin/wrangler.jsonc` / `apps/deployer/wrangler.jsonc` と Cloudflare 上の secret にある。

ファイルは 2 段に分かれる。

- **上段 = 質問への答え**: やりたいこと(機能・1 日の PV・画像)と、今の環境(Cloudflare のアカウント・ドメイン・ホスト・ログインに使う Google アカウント)。質問の原文・選択肢・用語の補足は[導入の質問](install-questions.md)
- **下段 = 構成**: `edge_address` など、以下の手順が読むキー。検査スクリプトが答えから書き込む

**エージェントの進め方**(clone と 0.4 のツールの後に行う):

1. [導入の質問](install-questions.md)の「進め方の規則」と質問の表どおりに聞き、答えを上段に書く。上段に答えが書かれている質問は飛ばす
2. `node tools/deploy-answers/cli.mjs` を実行し、終了コードで分ける
   - 0 → 出力(推奨構成と最軽量構成)を要約せずに人に見せ、どちらにするかを聞く
   - 2 → 出力の「聞き直す問い」に出た ID の問いだけを聞き直して上段に書き、再実行する
   - 1 → 出力の行を直して再実行する
3. 選ばれたら `node tools/deploy-answers/cli.mjs --accept recommended`(または `--accept lightest`)を実行する。下段に構成が書き込まれる。構成を勧める判断はエージェントがせず、スクリプトの出力に従う
4. 出力の先頭に「確認: アカウントが変わる」があり、選ばれた構成がそれに当たるときは、アカウントの変更への同意を構成の了承とは別に取る。当たるのは、既存のアカウントではなく、この製品用に新しく作るアカウントに入れる構成
   - その部分を要約せずに人に見せて聞く。「推奨で」などの構成の了承は、この同意に数えない
   - 同意を得たときだけ `--accept` に `--confirm-account-change` を付けて実行する。付けずに実行すると終了コード 2 で止まり、同じ節を出す。付けて実行すると、上段の `cloudflare_account` が `separate` に書き換わり、元の答えは行末のコメントに残る
   - 同意しないなら E1 から聞き直す。進め方は 4 つ: ドメインを Cloudflare に追加して E2 = yes で答え直す / 新しいアカウントで進める同意を改めて取る / 導入をやめる / 構成を自分で決めるなら下段を手で書いて `--accept manual`
5. 構成を自分で決めている人は、下段の行の `#` を外して書く(`owner_email` と、`route` なら `install_host`、`custom-domain` なら `edge_host` は上段)。スクリプトは書かれた構成の矛盾を検査して要約を出す。了承は `--accept manual`

後の手順との関係:

- `zone_name: auto` と `asset_public_base: auto` は、0.4 の[ログインの後の確認](#ログインの後の確認)で確定する
- 未検証と注記された値(`control_protection` の `waf` / `access`)が書かれていたら、進める前に人に確認する
- ページのホスト(サイトの「タグを置くドメイン」)は、5 節でサイトを作るときと作った後に管理画面で入力する。入力ファイルの `install_host` と `extra_hosts`(上段の E2d の答え)を、そのまま入れる
- `dlite_hosts` があるときは、5 節でサイトを作るときに `導入の形` を `B: サーバー発行 Cookie` にする

確認:

```bash
node tools/deploy-answers/cli.mjs; echo "exit=$?"   # 期待: exit=0、「## 指定された構成」と「了承済み」が出る
```

各項目がどの手順で使われるか:

| 項目 | 使う手順 |
|---|---|
| `install_host` / `zone_name` | 2.3 Route、2.6 Cache Rule、2.7 WAF、5 節のスモーク。`custom-domain` では `zone_name` は `edge_host` が属するゾーン |
| `edge_host` | `custom-domain` のときだけ。0.4 のログインの後の確認(ゾーンの確定と有効になっているかの確認)、2.3 の Custom Domain(と、ホストが空いていることの確認)、2.6 Cache Rule、2.7 WAF、2.9 (3) の `wtt-static` の Route、3.4 `AB_EDGE_ORIGIN`、5 節のスモーク |
| `edge_address` | 2.3(`route` なら Route、`custom-domain` なら Custom Domain、`workers-dev` なら `workers_dev: true`)、2.4 の確認 URL、2.6 / 2.7(`route` と `custom-domain` では行い、`workers-dev` では飛ばす)、3.4 `AB_EDGE_ORIGIN`(`custom-domain` なら `https://<edge_host>`)、5 節のスモーク |
| `asset_public_base` / `asset_max_mb` | 3.2、3.4。`dev-assets` は 3.5 の初回 deploy で control の URL が分かった後に `<control URL>/dev-assets` に展開して `AB_ASSET_PUBLIC_BASE` に書く(literal のまま書かない)。none なら 3.2 の R2 の手順を飛ばし、3.4 の AB_ASSET_PUBLIC_BASE を書かない。`auto` は 0.4 のログインの後の確認で `https://wtt-assets.<zone_name>` に展開される |
| `release_tag` | 0.3 |
| `control_address` / `control_host` | 0.5 の 2(`custom` ならゾーンの設定用トークンを作り、`control_host` のゾーンを含める)、3.4 `AB_CONTROL_URL`、3.6、7.1 |
| `control_protection` | 7 節 |
| `edge_waf_rate_limit` / `edge_waf_requests_per_10s` | 2.3(Rate Limiting binding)、2.7 |
| `admin_address` / `admin_host` | 0.5 の 2(`custom` ならゾーンの設定用トークンを作り、`admin_host` のゾーンを含める)、3.4 `AB_ADMIN_URL`、4.2 |
| `extra_hosts` | 5 節のサイトの作成の後に、サイト設定の「タグを置くドメイン」に足す。`--accept recommended` で Safari 対策ありなら、ゾーンの中のホストは `dlite_hosts` にも入る |
| `dlite_hosts` | 2.3 の `/__ab/*` Route。後から足すときは 6.7 |
| `owner_email` / `workspace_name` | 5 節の初回セットアップ(`POST /setup`)。`owner_email` はログインに使う Google アカウントと同じメールアドレス。`workspace_name` は質問の表に無く、0.5 の人への依頼で一緒に聞いて書く |
| `usage_visibility` | 5 節の初回セットアップ(`POST /setup` の `usageVisibility`)。使用状況を見られる人(`members` / `instance_admins`)。省略 = `members` |
| `plan` | 0.5(`paid` で、アカウントがまだ Free なら切り替えを依頼)、5 節(管理画面の使用状況のプラン) |
| `results_db_name` | 2.2(計測用のデータベースの名前)、3.4 `AB_USAGE_RESOURCES`。既定 `wtt-results` のまま使う。ほかのリソースの名前と同じく固定で、手順とスクリプト(`results:migrate:remote`)はこの名前で書いてある。入力ファイルに書かれていなくても作る |
| 上段の答え(`features` など)・`accepted` | 検査スクリプトが読む。以下の手順が上段から読むのは `cloudflare_account`(0.4 のアカウントを作る・ログインの後の確認)と `install_host`・`extra_hosts`・`edge_host`・`owner_email` だけ |

### 0.3 本体の取得とバージョン

先に 0.4 のツールを入れる。リリースは GitHub の tag(`v0.9`、`v1.0` …)で出している。tag を指定して取得し、どの tag を入れたかを控える。更新は 6 節で「現在の tag → 目標の tag」として行う。

```bash
git clone https://github.com/AnalyticsDesign/ab-test-and-target-harness.git
cd ab-test-and-target-harness
git tag --list 'v*' --sort=-v:refname | head -5     # 使える tag。release_tag が latest なら先頭
git checkout v0.9                                    # 入れる tag に読み替える
git describe --tags --exact-match                    # 期待: 今 checkout した tag 名。それ以外なら checkout に失敗している
pnpm install
```

`latest` は、上の `git tag` の版の順の先頭で決める。GitHub Releases の API(`/releases/latest`)は使わない。リリースは tag で定義しており、API が 404 を返しても「tag が無い」という意味ではない。認証・ネットワークの制限でも 404 になる。

`Corepack` の案内が出たら `corepack enable` を先に実行する。`corepack: command not found` なら 0.4 の「期待と違うとき」を読む。

Windows で `pnpm install` が `Failed to validate workerd binary` や `Local development will not work` を出しても、終了コードが 0 なら導入を続けてよい。workerd はローカル実行用のランタイムで、導入の手順は使わない。導入の手順(ビルド・deploy・データベースの更新)はどれも Cloudflare 側で動く。ローカル開発もするなら、workerd の起動に要る Microsoft の Visual C++ 再頒布可能パッケージ(x64)を入れる。

### 0.4 必要なツール(macOS / Linux / Windows)

| ツール | 用途 | macOS | Linux | Windows |
|---|---|---|---|---|
| Git | 取得と更新 | 同梱(Xcode CLT)または `brew install git` | ディストリのパッケージ | Git for Windows(Git Bash を含む)。この文書の bash ブロックはすべて Git Bash で実行する。PowerShell / cmd では動かない。人に示すコマンドだけは 0 節のとおり PowerShell 用も併記する |
| Node 24 以上(LTS を推奨) | pnpm / wrangler の実行 | `brew install node` | nodesource など | `winget install OpenJS.NodeJS.LTS` |
| pnpm。`package.json` の `packageManager` で固定した版を使う。単体では入れず、Node に付く Corepack で使う | 依存の導入 | `corepack enable` | 同左 | Git Bash で `corepack enable` |
| wrangler 4 | Cloudflare の操作 | `pnpm install` で入る(ルートの PATH には乗らない) | 同左 | 同左 |
| curl / openssl | API 呼び出し / 乱数 | 同梱 | 同梱 | Git Bash に同梱 |
| jq | API 応答の読み取り(2.6 / 2.7 / 9 節) | `brew install jq` | パッケージ | `winget install jqlang.jq`。入れた後に Git Bash を開き直す |

エージェントがツールを入れるときは、入れる前に、入れるもの(名前と入手元)の一覧を 1 回だけ示して了承を取る。この了承は導入の最初の確認として 1 回で取る。構成の質問は、clone の後に 0.2 で行う。入っているものは入れ直さない。

確認:

```bash
node -v      # v24 以上
pnpm -v      # リポジトリ直下で。package.json の packageManager の版(例 pnpm@10.34.5 なら 10.34.5)
jq --version # jq-1.7 以上
git --version
bash --version | head -1   # GNU bash
openssl version            # 乱数の生成に使う
```

期待と違うとき:

- `git clone` が `Filename too long` で失敗する(Windows)→ Windows のパスの長さの上限に当たっている。途中まで作られたフォルダを消し、短いパス(例 `C:\wtth`)に clone し直す
- `corepack enable` が `EPERM` で失敗する(Windows で管理者権限が無い)→ Node の入ったフォルダ(`C:\Program Files\nodejs`)に書き込めないため。pnpm を起動するファイルをユーザーのフォルダに作り、そのフォルダを PATH に足す:

  ```bash
  mkdir -p "$HOME/wtt-bin"
  corepack enable --install-directory "$HOME/wtt-bin"
  export PATH="$HOME/wtt-bin:$PATH"   # エージェントは以後のシェルでも毎回これを設定する
  grep -qs 'wtt-bin' ~/.bashrc || echo 'export PATH="$HOME/wtt-bin:$PATH"' >> ~/.bashrc   # 人が開く Git Bash でも使えるようにする
  pnpm -v   # リポジトリ直下で。packageManager の版
  ```

- `corepack: command not found`(Node 25 以降は corepack が同梱されない)→ `npm install -g corepack` の後に `corepack enable`。LTS の Node を入れ直してもよい
- `pnpm -v` が `packageManager` と違う版(単体で入れた pnpm 11 など)→ `corepack pnpm -v` が固定の版を返すなら、PATH の先に単体の pnpm がある。単体の pnpm を外して `corepack enable` を実行し、`pnpm -v` を確かめ直す。npm で入れたなら `npm uninstall -g pnpm` で外す。違う版のまま `pnpm install` を進めない。ロックファイルの解釈が変わる
- `jq` / `pnpm` が入れた直後に見つからない(Windows)→ Git Bash を開き直す
- `openssl: command not found`、または `bash` が無い(Windows)→ Git for Windows を入れ、その Git Bash で実行する。原因は、Git for Windows ではない Git を使っていること。エージェントの実行環境に同梱された最小構成の Git などが当たる。この文書の bash ブロックは `openssl`・`sleep`・`date` を使う

以下、`wrangler …` は `pnpm -C apps/control exec wrangler …`(control 系)/ `pnpm -C apps/edge exec wrangler …`(edge 系)の意味。`login` / `whoami` / `kv namespace create` はどちらから実行してもよい。

#### Git Bash で確認コマンドの出力が期待と違うとき

Git Bash は、Windows のプログラムに渡す `/s/...` のような引数を、Windows のファイルのパスに書き換えることがあります。この文書の curl の URL は `https://` から始まる形のまま使ってください。HTTP コードや本文が期待と違う場合は、その結果だけで導入が成功したと判断せず、`type -a curl` と `curl --version` で使っている curl を確認してください。URL のパスなどが書き換わっていた場合は、そのコマンドだけに `MSYS_NO_PATHCONV=1` を付けて確認し直してください。ファイルの入出力先も引数に含まれるときは、そのパスも確認してください。

```bash
# Git Bash でパスの書き換えが確認されたときだけ使う例
MSYS_NO_PATHCONV=1 curl -sSI "https://<設置タグのホスト>/s/<siteId>.js"
```

Windows の curl で HTTP コードだけを確かめるときは、次のようにします。`-o /dev/null` の引数も書き換えが止まるため、Windows の curl の出力先には `NUL` を使います。シェルが処理する `>/dev/null` はそのままにし、`>NUL` には変えないでください。

```bash
# Windows の curl で HTTP コードだけを確かめる例
MSYS_NO_PATHCONV=1 curl -sS -o NUL -w '%{http_code}\n' "https://<設置タグのホスト>/s/<siteId>.js"
```

書き換えを止めるのは、影響が確認されたコマンドだけにしてください。`export MSYS_NO_PATHCONV=1` で以後の全コマンドの書き換えを止めると、ローカルファイルのパスを Windows のプログラムに渡す処理まで変わります。コマンドを引用符で囲むだけ、または `.sh` ファイルに保存するだけでは、この書き換えを避けられません。

#### アカウントを作る(`cloudflare_account: none / separate` のとき)

**【人が行う】** `wrangler login` の前に、Cloudflare のアカウントを作ってもらう。エージェントは次の手順を書き換えずに人に示す:

1. ブラウザで `https://dash.cloudflare.com/sign-up` を開き、メールアドレスとパスワードで登録する。`separate`(今のアカウントとは別に作る)のときは、今のアカウントとは別のメールアドレスで登録する。今のアカウントでダッシュボードにログインしたままなら、先にログアウトする
2. 届いた確認のメールのリンクを開く
3. 登録の後に出る案内(ドメインの追加・プランの選択など)は進めなくてよい。ダッシュボードの Workers & Pages は開かない。workers.dev のサブドメインは、エージェントが 0.5 で作る
4. 終わったら「作った」と返す。次の `wrangler login` では、このアカウントでログインして許可する

#### ログイン

**【人が行う】** 最初に一度 `wrangler login`(ブラウザ OAuth)を済ませる。コマンドはエージェントが実行し、人はブラウザに出る Cloudflare の画面で「Allow」を押すだけにする。

- エージェントは実行の前に「これからブラウザに Cloudflare の許可の画面が出るので、導入するアカウントでログインして Allow を押してほしい」と伝える
- `wrangler login` はバックグラウンドで実行し、出力に出る URL をすぐ人に示す。ブラウザが自動で開いても、人が見ている画面とは限らないため。wrangler は許可を待つ時間に上限を持ち、許可が届かないまま過ぎると `Timed out waiting for authorization code` で終わる

```bash
pnpm -C apps/control exec wrangler login
```

期待と違うとき:

- ブラウザが自動で開かない → 出力に出る URL を人に示して開いてもらう。許可の後の戻り先はこの PC の `localhost` なので、同じ PC のブラウザで開く
- `Timed out waiting for authorization code` で終わった → 許可が間に合わなかった。資格情報は保存されていないので、同じコマンドをやり直す。URL は実行のたびに変わるので、新しい出力の URL を示す
- エージェントの環境で実行できない(待ち受けが届かない・コマンドが打ち切られる)→ 0 節の「人に実行してもらうコマンドの示し方」の形で人に示す。リポジトリ直下で実行する Git Bash 用と PowerShell 用の 2 行にする

終わったら `pnpm -C apps/control exec wrangler whoami` でアカウント名と Account ID が出ることを確認する。エージェントはこの確認から再開する。

`whoami` にアカウントが 2 つ以上出たら、導入先を人に 1 問で選んでもらい、以後のすべての手順の前提として固定する。wrangler は非対話のとき導入先を選べない:

```bash
export CLOUDFLARE_ACCOUNT_ID=<導入先の Account ID>   # エージェントは以後のシェルでも毎回これを設定する
```

#### ログインの後の確認

ログインの後に次を確かめる。各ブロックは先頭で同じ変数を設定するので、単独で実行できる。`HOST` には `deploy-answers.yaml` の、`route` なら `install_host`、`custom-domain` なら `edge_host` を入れる。

1. **この製品がまだ入っていないか**(どの構成でも)。1 つのアカウントに入れられるのは 1 つまで

```bash
T=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
AID=${CLOUDFLARE_ACCOUNT_ID:-$(pnpm -C apps/control exec wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}
curl -sS "https://api.cloudflare.com/client/v4/accounts/$AID/workers/scripts" -H "Authorization: Bearer $T" \
  | jq -r 'if .success == true and (.result | type) == "array" then ([.result[].id | select(startswith("wtt-"))] | if length == 0 then "wtt: none" else "wtt: " + join(", ") end) + " / workers: " + (.result | length | tostring) else "wtt: unknown (" + ([.errors[]?.code | tostring] | join(",")) + ")" end'   # 期待: wtt: none(新しく作ったアカウントでは wtt: none / workers: 0)
```

期待と違うとき:

- `wtt: …` に名前が出る → 作業を中断して人に報告する。既に導入されている。更新なら 6 節、新しく入れるなら別のアカウントで行う
- `wtt: unknown (…)`、または jq がエラーになる(応答が JSON でない)→ 確かめられなかったので先へ進まない。`wrangler login` と `CLOUDFLARE_ACCOUNT_ID` を確かめてやり直し、直らなければ人に報告する
- `cloudflare_account` が `none` または `separate` なのに、`workers:` が 0 でない → 作業を中断し、`pnpm -C apps/control exec wrangler whoami` に出るアカウント名とメールアドレスを人に見せる。これが新しく作ったアカウントかを聞く
  - `separate` には、アカウントの変更に同意して書き換わった場合を含む。`wtt-` 以外の Worker でも 0 でなければ当たる
  - 疑う原因: ブラウザに前のセッションが残っていて、元のアカウントで許可してしまった
  - 違えば 0.4 の「ログイン」からやり直す。必要なら先にダッシュボードからログアウトする

2. **ゾーンを確定する**(`zone_name` か `asset_public_base` に `auto` が残っているとき。引用符付きの `"auto"` も同じ): `HOST`(`install_host`。`custom-domain` では `edge_host`)の末尾から候補のゾーン名を作り、導入先のアカウントの有効なゾーンだけを名前で引く。こうすると件数の多いアカウントでも取りこぼさない。`zone_name` が既に書かれていれば、スクリプトはそれと同じゾーンのときだけ確定する。違えば終了コード 2 になるので、`zone_name` の行を直すか、E2(`custom-domain` では E2c)を聞き直す

```bash
HOST=''
T=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
AID=${CLOUDFLARE_ACCOUNT_ID:-$(pnpm -C apps/control exec wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}
ZONE=''; ERR=''; C="$HOST"
while [ -z "$ZONE" ] && [ -z "$ERR" ] && printf '%s' "$C" | grep -q '\.'; do
  R=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=$C&account.id=$AID&status=active" -H "Authorization: Bearer $T")
  if printf '%s' "$R" | jq -e '.success == true' >/dev/null 2>&1; then
    ZONE=$(printf '%s' "$R" | jq -r --arg a "$AID" '[.result[]? | select(.account.id == $a) | .name][0] // empty')
  else
    ERR=1
  fi
  C=${C#*.}
done
if [ -z "$HOST" ]; then echo "HOST is empty: set install_host (route) or edge_host (custom-domain) from deploy-answers.yaml"; elif [ -n "$ERR" ]; then echo "zone: unknown (API error)"; else echo "zone: ${ZONE:-not found}"; fi
[ -z "$ZONE" ] || node tools/deploy-answers/cli.mjs --resolve-zone "$ZONE"   # 期待: 「## 書き込んだ行」に zone_name(画像をアップロードする構成なら asset_public_base も)
```

期待と違うとき:

- `HOST is empty` → `HOST` に `install_host`(`custom-domain` では `edge_host`)を入れてやり直す。空のままでは `zone: not found` と区別できないため、ここで作業を中断する
- `zone: not found` → そのドメインはこのアカウントで有効になっていない。別のアカウントにあるか、まだ Cloudflare に追加していないか、追加してもネームサーバーの切り替えが済んでいない。作業を中断して人に報告する。`route` では 0.2 の E2 を聞き直す。`custom-domain` では、次の順に進める。ドメインを使わずに始めるなら、0.2 の E2c を `none` に答え直し、下段の構成の行と `accepted` を消して、0.2 の 2 からやり直す
  - 2 は有効なゾーンだけを引くので、ドメインを追加してネームサーバーの切り替えの反映を待っているゾーンも、ここでは `not found` になる。そこで、導入に使うアカウントに追加したドメインを人に聞く。`edge_host` が属するゾーンの名前で、例えば `ab.example.net` なら `example.net`。まだ追加していないと答えたら、下の 4 の (i) を示す
  - 聞いたゾーンの名前を下の 4 のブロックの `ZONE` に入れて実行する。4 はゾーンの状態で絞らずに引くので、反映待ちとゾーンが無いことを見分けられる
  - `zone status: pending` と `zone status: not found` → 4 の「期待と違うとき」のとおりに進める
  - `zone status: active` → 2 の後に有効になった。2 からやり直してゾーンを確定する。やり直しても 2 が `zone: not found` なら、`edge_host` がそのゾーンに属していない。0.2 の E2c を聞き直す
- `zone: unknown (API error)` → 確かめられなかったので先へ進まない(1. の「期待と違うとき」と同じ)

3. **Cloudflare を経由しているか**(`edge_address: route` のとき)

```bash
HOST=''
[ -n "$HOST" ] || echo "HOST is empty: set install_host from deploy-answers.yaml"
[ -z "$HOST" ] || curl -sI "https://$HOST/" | grep -i '^server:'   # 期待: server: cloudflare
```

`HOST is empty` → `HOST` に `install_host` を入れてやり直す。`cloudflare` 以外 → DNS のレコードのプロキシ(オレンジの雲)が有効になっていない。Workers Route が動かないので、作業を中断して人に報告する。【人に依頼】 ダッシュボードの対象ゾーンの DNS → Records(レコード)で、そのホストのレコードの Proxy status(プロキシ ステータス)を DNS only(DNS のみ)からプロキシ(オレンジの雲)に切り替えてもらう。

4. **別のドメインのゾーンがこのアカウントにあり、有効になっているか**(`edge_address: custom-domain` のとき)。edge の Custom Domain は、導入するアカウントの有効なゾーンにしか作れない。`zone_name` を 2 で確定した後(または初めから書いてあるとき)に行う。`ZONE` に `zone_name` を入れる。2 が `zone: not found` になって 2 から来たときは、人に聞いたゾーンの名前を入れる

```bash
ZONE=''
T=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
AID=${CLOUDFLARE_ACCOUNT_ID:-$(pnpm -C apps/control exec wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}
if [ -z "$ZONE" ]; then echo "ZONE is empty: set zone_name from deploy-answers.yaml"; else
  curl -sS "https://api.cloudflare.com/client/v4/zones?name=$ZONE&account.id=$AID" -H "Authorization: Bearer $T" \
    | jq -r --arg a "$AID" 'if .success == true then ([.result[]? | select(.account.id == $a) | .status][0] // "not found") | "zone status: " + . else "zone status: unknown (API error)" end'   # 期待: zone status: active
fi
```

期待と違うとき:

- `ZONE is empty` → `ZONE` に `zone_name`(2 から来たときは人に聞いたゾーンの名前)を入れてやり直す
- `zone status: unknown (API error)` → 確かめられなかったので先へ進まない(1. の「期待と違うとき」と同じ)
- `zone status: pending` → ドメインは追加してあるが、ネームサーバーの切り替えがまだ反映されていない。作業を中断して人に報告し、切り替えが済んだか(ドメインの登録事業者の画面で、Cloudflare が示したネームサーバーにしたか)を確かめてもらう。反映には時間がかかることがあるので、済んでいれば待ってからやり直す。`zone_name` か `asset_public_base` に `auto` が残っていれば 2 から、どちらにも残っていなければこのブロックからやり直す
- `zone status: not found`(または `active` と `pending` 以外)→ 作業を中断し、**【人に依頼】** 次の 2 通りを示して選んでもらう
  - (i) そのドメインをまだ Cloudflare に追加していない: 導入に使うアカウントのダッシュボードでドメインを追加し(Add a domain。日本語の表示は未確認)、表示されたネームサーバーを、ドメインの登録事業者の画面で設定する。設定が済んだら、`zone_name` か `asset_public_base` に `auto` が残っていれば 2 から、どちらにも残っていなければこのブロックからやり直す
  - (ii) そのドメインをほかの Cloudflare アカウントで使っている: 移さない。ネームサーバーを切り替えると、そのドメインで動いているほかのサービスに影響するため。別のドメインを選ぶか、`*.workers.dev` の構成にする。どちらも 0.2 の E2c を答え直し(`*.workers.dev` にするなら `none`)、下段の構成の行と `accepted` を消して、0.2 の 2 から検査スクリプトをやり直す

### 0.5 人に用意してもらうもの(一度に集める)

人に頼むダッシュボード操作はここで一度に済ませ、以後は人に確認を求めずに進む。ここで行うこと:

1. control の URL を確定する(リダイレクト URI に要る)。workers.dev のサブドメインが無ければエージェントが作る
2. エージェントが `deploy-secrets.env` を空の値で作り、エディタで開く
3. 下の (1)〜(5) のうち構成で要るものだけを 1 つの依頼文にまとめ、人に示す。依頼文には必要な値(リダイレクト URI・権限・期限)を埋めておく。最初のワークスペースの名前も同じ依頼文で聞く
4. 人が受け取った値を `deploy-secrets.env` に書く。エージェントは中身を表示せずに確認する

**`deploy-secrets.env` の作り方**(依頼文を示す前に、エージェントが作る):

- リポジトリ直下に、要る行だけ・値は空で作る(形は下の「`deploy-secrets.env` の形」)。git 管理外
- 作るときは、所有者だけが読める権限にする。同じ端末に別のアカウントがあると、既定の権限では他のアカウントからも読めるため。macOS / Linux / Git Bash の例: `[ -e deploy-secrets.env ] || (umask 077 && printf 'GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\nCF_DEPLOY_TOKEN=\nCF_USAGE_TOKEN=\n' > deploy-secrets.env); chmod 600 deploy-secrets.env`(要る行は構成に合わせる。既にあれば上書きしない(貼った値を消さない)。`chmod` は前からあるファイルの権限も直す)。Windows の PowerShell では、ホームのフォルダの既定の権限に任せる
- 人にはファイルを作らせない。Windows のエクスプローラやメモ帳から新しく作ると、拡張子だけのファイル名に `.txt` が付きやすいため。人は開いて `=` の右に貼るだけにする
- ファイルはエージェントがエディタで開き、人にシェルを開かせない。まず `pwd` で絶対パスを確かめる。Windows の Git Bash では `pwd -W` が `C:/…` の形を返す。次に Windows = `notepad "<絶対パス>"`、macOS = `open -e "<絶対パス>"`、Linux = `xdg-open "<絶対パス>"` を自分で実行する
- エディタは閉じるのを待たない形で開き、開いた後に依頼文を出す。閉じるまで戻らない形で開くと、依頼文を出す前にエージェントが次の処理に進めなくなる。人は何を書くか分からないまま、エディタを前に待つことになる
- 依頼文には絶対パスと「エディタで開いたので `=` の右に貼って保存する」を書く。エディタが人の画面に開かなかったときだけ、絶対パスを示して人に開いてもらう。エージェントの実行環境と人の端末が違うときなどに起きる
- エージェントはこのファイルの中身を表示せず、環境変数に読み込む(下の「確認」)。会話・`deploy-log.md` に値が出ない

**先に control の URL を確定する**(リダイレクト URI に要る。deploy 前でも分かる):

- `control_address: custom` → `https://<control_host>`
- `control_address: workers-dev` → `https://wtt-control.<アカウントのサブドメイン>.workers.dev`。サブドメインは `wrangler login` の資格情報で API から取る:

```bash
T=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
AID=${CLOUDFLARE_ACCOUNT_ID:-$(pnpm -C apps/control exec wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}   # 複数アカウントなら 0.4 で固定した CLOUDFLARE_ACCOUNT_ID が使われる
curl -sS "https://api.cloudflare.com/client/v4/accounts/$AID/workers/subdomain" -H "Authorization: Bearer $T" | jq '{subdomain: .result.subdomain, errors: [.errors[]?.code]}'   # 期待: subdomain = <アカウントのサブドメイン>(例 quiet-river-1a2b)
```

期待と違うとき:

- `subdomain` に名前が出る → それを使う
- `errors` に `10007` だけが出る → 下のブロックでエージェントが作る。サブドメインがまだ無いアカウントで、新しく作ったアカウントなどが当たる
- それ以外のエラー(認証エラーなど)→ 作らない。0.4 の `wrangler login` と `CLOUDFLARE_ACCOUNT_ID` を確かめてから取得をやり直す。エラーのまま作ると、既にあるサブドメインの名前を変えてしまうおそれがある

**サブドメインの名前の決め方**(エージェントが決める。人には聞かない):

- サブドメインは、このアカウントのすべての Worker の公開アドレスの一部になる(`<Worker 名>.<サブドメイン>.workers.dev`)。管理画面の URL・招待リンクに出て、ゾーンを持たない構成では設置タグにも出る。後からダッシュボードで変えられるが、変えると workers.dev の URL がすべて変わる
- 名前にはアカウント名を使わない。個人のアカウントは既定でメールアドレスを含む名前になっている
- `zone_name` があればそれから作る(`example.com` → `example-com`)。無ければ `wtt-` と 6 文字の乱数にする
- 名前が取られていたら末尾に 4 文字の乱数を付けて 1 回だけ作り直す
- 決まった名前を `deploy-log.md` と最後の報告に書く

下のブロックは単独で実行できる。サブドメインが既にあるときは何もせず、再実行しても名前を変えない。1 行目の `ZONE_NAME` に入力ファイルの `zone_name` を入れる。ゾーンを持たない構成では空のままにする:

```bash
ZONE_NAME=''
T=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
AID=${CLOUDFLARE_ACCOUNT_ID:-$(pnpm -C apps/control exec wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}
API="https://api.cloudflare.com/client/v4/accounts/$AID/workers"
if curl -sS "$API/subdomain" -H "Authorization: Bearer $T" | jq -e '[.errors[]?.code] == [10007]' >/dev/null; then
  NAME=$(printf '%s' "$ZONE_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//' | cut -c1-56 | sed -E 's/-+$//')
  [ -n "$NAME" ] || NAME="wtt-$(openssl rand -hex 3)"
  # 空きの確認(wrangler と同じ判定): 10031 = 取られている / 10032 = 空いている / それ以外のエラー = 確認できない
  avail() { curl -sS "$API/subdomains/$1" -H "Authorization: Bearer $T" | jq -r '[.errors[]?.code] | if index(10031) then "taken" elif (length == 0 or index(10032)) then "free" else "unknown" end'; }
  [ "$(avail "$NAME")" = taken ] && NAME="$NAME-$(openssl rand -hex 2)"
  if [ "$(avail "$NAME")" = free ]; then
    curl -sS -X PUT "$API/subdomain" -H "Authorization: Bearer $T" -H 'content-type: application/json' --data "{\"subdomain\":\"$NAME\"}" \
      | jq '{success, subdomain: .result.subdomain, errors: [.errors[]? | {code, message}]}'   # 期待: success = true、subdomain = 作った名前
  else
    echo "subdomain: could not create ($NAME)"
  fi
else
  echo "subdomain: not created (already exists, or another error; re-run the lookup above)"
fi
```

`could not create` か、PUT の `success` が `false`(権限エラーなど)なら、**【人に依頼】** ダッシュボードの Compute(コンピュート)→ Workers & Pages を一度開いてもらう。開くとサブドメインが自動で作られる。開いてもらった後に上の取得をやり直す。

**Cloudflare の API トークンの名前**(エージェントが名前を埋めて依頼文に書く):

| 用途 | 名前 | 下の項目 |
|---|---|---|
| ゾーンの設定用 | `wtt-setup-<識別子>` | 2 |
| 配信ファイルのデプロイ用 | `wtt-deploy-<識別子>` | 3 |
| 使用状況の表示用 | `wtt-usage-<識別子>` | 4 |

識別子 = 上で確かめたアカウントの workers.dev のサブドメイン。サブドメインを取っていない構成では、`zone_name` の `.` を `-` にしたもの。

識別子を付ける理由: API トークンは Cloudflare のアカウントではなくユーザー(My Profile)に属する。そのため、別のアカウントに入れた導入のトークンも同じ一覧に並ぶ(1 つのアカウントに入れられる導入は 1 つまで。1 節)。Cloudflare は同じ名前のトークンを拒まないため、識別子が無いと、撤去のときにどの導入のトークンか名前から分からない。

**名前は必ず表のとおりに付ける。** 依頼文の Token name(トークン名)には識別子を埋めた名前をそのまま書き、`wtt-deploy` のような識別子の無い名前や、`CF_DEPLOY_TOKEN` のような控えの変数名を名前にしない。作成の後、人に一覧の名前が依頼文と同じかを確かめてもらう。違っていたら、そのトークンを作り直してから値を控える(撤去のときに別の導入のトークンと取り違えないため。10.4 の 5)。

**【人に依頼】**(構成で要るものだけ)

1. **Google の OAuth クライアント**(どの構成でも要る)。エージェントは次の表を 1 画面ずつ案内し、登録するリダイレクト URI `<control URL>/auth/callback/google` を伝える。Google はこの作成を API で行う手段を提供していないため、この工程だけは人が行う。開くリンク = `https://console.cloud.google.com/auth/overview`

**案内の前に人に聞くこと**: 同じ Google アカウントで、この製品のプロジェクト(`wtt-auth` など)を前に作ったか。前の導入を撤去して入れ直すときや、2 つ目を導入するときが当たる。

- 作ったなら、プロジェクトは新しく作らない。画面の上部のプロジェクトの選択でそのプロジェクトを選び、表の Clients(クライアント)の行から進む。Get started(開始)・Branding(ブランディング)・Audience(対象)の設定は、プロジェクトに残っている
- 撤去の後の入れ直しでは、Clients(クライアント)の一覧に前の導入のクライアント(`wtt-control-<識別子>`)が残っていないかを確かめる。残っていれば、使われないクライアントなので先に削除してもらう(10.4 の撤去の手順で消すもの)
- 作っていなければ、表の上から進む

| 画面 | 決めること | 推奨 |
|---|---|---|
| プロジェクト(画面の上部のプロジェクトの選択) | 新しく作るか、既存のものを使うか | 初めてなら、この製品専用に新しく作る(名前 = `wtt-auth`)。ほかの用途の設定と混ざらない。既存のものを使う場合、次のアプリ名がログインの画面に出る。同じ組織で 2 つ目以降を導入するときは、同じプロジェクトを使い、Clients(クライアント)だけ増やす。同意の画面の設定はプロジェクトに 1 つで、ログインできる人は各導入の招待で決まるため。組織が違う導入(別の会社のために入れるなど)ではプロジェクトを分け、名前を `wtt-auth-<組織名>` にする。アプリ名と Internal / External はプロジェクトに 1 つで、Internal にできるのはプロジェクトと同じ組織のアカウントだけのため |
| Get started(開始)。新しく作ったプロジェクトのときだけ | アプリの情報・対象・連絡先 | 新しいプロジェクトでは、開くリンクの画面に Google Auth Platform not configured yet(Google Auth Platform はまだ構成されていません)と出る。先に Get started(開始)を押し、Project configuration(プロジェクト構成)の 4 段を上から入れる。App Information(アプリ情報)で App name(アプリ名)と User support email(ユーザー サポートメール)、Audience(対象)で Internal(内部)か External(外部)を選ぶ(決め方は次の 2 行)。Contact Information(連絡先情報)の Email addresses(メールアドレス)は、Google がプロジェクトの変更を知らせる宛先で、`owner_email` でよい。Finish(終了)で I agree to the Google API Services: User Data Policy.(Google API サービス: ユーザーデータに関するポリシー に同意します。)にチェックを入れて Continue(続行)を押し、最後に Create(作成)で作る。設定済みのプロジェクトではこの画面は出ず、左メニューの Branding(ブランディング)と Audience(対象)で同じ項目を確かめる |
| Branding(ブランディング) | App name(アプリ名)・User support email(ユーザー サポートメール) | アプリ名 = Google のログインの画面に出る名前(例 `AB Test and Target Harness`)。組織名を付けてもよい。サポートのメールは選ぶ形で、選べるのはログイン中の Google アカウントと、そのアカウントが管理する Google グループだけ。`owner_email` でログインして作業し、それを選ぶ |
| Audience(対象) | User type(ユーザーの種類): Internal(内部)/ External(外部)。設定済みのプロジェクトでは、Audience(対象)の画面に Make internal(内部に公開)のボタンが出る | 管理画面を使う人が全員、同じ Google Workspace の組織のアカウントなら Internal(テストユーザーの登録が要らない)。個人の Gmail を含む・組織の外の人を招待するなら External(外部)。External で Publishing status(公開ステータス)が Testing(テスト中)のあいだは、Test users(テストユーザー)に登録した Google アカウントしかログインできない。`owner_email` と、招待する人を登録する。登録は、Get started(開始)の入力を済ませた後に左メニューの Audience(対象)を開き、Test users(テストユーザー)の Add users で行う(Add users は日本語の表示でも英語のまま) |
| Clients(クライアント) | 種類・名前・リダイレクト URI | Create client(クライアントを作成)を押し、Application type(アプリケーションの種類)= Web application(ウェブ アプリケーション)、Name(名前)= `wtt-control-<識別子>` にする。Authorized redirect URIs(承認済みのリダイレクト URI)の Add URI(URI を追加)で上の URI を 1 つ登録し、Create(作成)で作る。Name は Google の画面の中だけで使う名前で、識別子は上の「Cloudflare の API トークンの名前」と同じ。同じプロジェクトに複数の導入のクライアントが並んでも見分けられる。Use this client for an AI-powered agent(日本語の表示でも英語のまま)にはチェックを入れない。AI エージェントが利用者の代わりに Google の API を使うクライアントに付ける印で、このクライアントは人のログインに使う |
| 作成の結果 | 控える値 | Client ID(クライアント ID)と Client secret(クライアント シークレット)を `deploy-secrets.env` に書く。シークレットは、作成の直後に出る画面を閉じると、表示もダウンロードもできなくなる。控える前に閉じたときは、表の下の「シークレットを控える前に閉じたとき」 |

**シークレットを控える前に閉じたとき**(どちらでもよい。操作に迷ったら (b)):

- (a) シークレットを足して、古いものを消す: Clients(クライアント)の一覧でクライアントの名前を押して詳細を開く。Client secrets(クライアント シークレット)の Add secret(日本語の表示でも英語のまま)で新しいシークレットを作り、その行のコピーのアイコンで値をコピーして `deploy-secrets.env` に書く。画面を離れるとコピーできなくなる。次に、古いシークレットの行で Disable(無効にする)を押してから、ごみ箱のアイコンで削除する。無効にする前は削除できない。1 つのクライアントに置けるシークレットは 2 つまで
- (b) クライアントを作り直す: Clients(クライアント)の一覧でそのクライアントにチェックを入れ、Delete(削除)を押す。表の Clients(クライアント)の行から作り直す(リダイレクト URI も登録し直す)。消したクライアントは、30 日以内なら Restore deleted OAuth clients(削除した OAuth クライアントを復元)で戻せる

2. **ゾーンの設定用の Cloudflare API トークン**(ゾーンのある構成(`edge_address` が `route` か `custom-domain`)のときと、control か管理画面を自分のドメインに置くとき(`control_address` か `admin_address` が `custom`)だけ。どれにも当たらなければ不要)
   - 画面: My Profile(マイ プロフィール)→ API Tokens(API トークン)→ Create Token(トークンを作成する)→ Custom token(カスタム トークン)の Get started(始める)
   - Token name(トークン名)= `wtt-setup-<識別子>`
   - Permissions(権限)= Zone(ゾーン)→ Cache Rules → Edit(編集)、Zone(ゾーン)→ Zone WAF(ゾーン WAF)→ Edit(編集)、Zone(ゾーン)→ Zone(ゾーン)→ Read(読み取り)、Zone(ゾーン)→ DNS → Read(読み取り)。DNS の読み取りは、ホストが空いていることを確かめるのに使う(`custom-domain` の 2.3、管理画面の 4.2、control の 7.1)
   - Zone Resources(ゾーン リソース)= 対象ゾーンに限定。設置サイトのゾーンに置く構成(`route`)では設置サイトのゾーン、別のドメインに置く構成(`custom-domain`)では `edge_host` のゾーン(`zone_name`)。`control_host`・`admin_host` を置くゾーンがこれと違えば、そのゾーンも足す(Include(含める)の行を増やす)。`workers-dev` の構成で control か管理画面を自分のドメインに置くときは、`control_host`・`admin_host` のゾーンだけにする。`control_host`・`admin_host` のゾーンの名前は、依頼文を出す前にエージェントが確かめる: ホストの末尾から候補の名前(`admin.example.co.jp` なら `example.co.jp`・`co.jp`)を作り、`wrangler login` の資格情報で `GET /zones?name=<候補>` を引いて、導入先のアカウントの有効なゾーンが返った名前にする
   - 期限 = 翌日。TTL の Select time range(時間範囲を選択)の終了日で指定する。失効の手間をなくすため。導入が翌日までに終わらなければ発行し直す
   - Continue to summary(概要に進む)で内容を確かめて作成し、値を `CF_TOKEN=` に書く
3. **配信ファイルのデプロイ用トークン**(どの構成でも要る)
   - 画面: 2 と同じ。ゾーンのある構成(`route`・`custom-domain`)では 2 と同じ画面で続けて作る
   - Token name(トークン名)= `wtt-deploy-<識別子>`
   - Permissions(権限)= Account(アカウント)→ Workers Scripts(Workers スクリプト)→ Edit(編集)のみ
   - Account Resources(アカウント リソース)= 導入先のアカウントだけ
   - 期限なし。デプロイ専用の Worker の secret として常設する。このトークンはアカウント内のすべての Worker を書き換えられるので、ほかの場所に置かない
   - 値を `CF_DEPLOY_TOKEN=` に書く
4. **使用状況の表示用のトークン**(どの構成でも要る)
   - 画面: 同じ
   - Token name(トークン名)= `wtt-usage-<識別子>`
   - Permissions(権限)= Account(アカウント)→ Account Analytics(アカウント分析)→ Read(読み取り)のみ
   - Account Resources(アカウント リソース)= 導入先のアカウントだけ
   - 期限なし。権限は使用状況の読み取りだけで、漏れても設定やデータは書き換えられない。期限を付けると、切れた日から管理画面の使用状況に「使用状況を取得できませんでした」と出る。その場合はトークンの作り直しと 3.3 の secret の入れ直しが要る。ほかの機能には影響しない。失効は撤去のとき(10.4)に行う
   - 値を `CF_USAGE_TOKEN=` に書く。Cloudflare のアカウント ID も一緒に控える(3.4 の `CF_ACCOUNT_ID` に入れる)
5. **Workers Paid への切り替え**(`plan: paid` で、アカウントがまだ Free のときだけ)。ダッシュボードの Compute(コンピュート)→ Workers plans(Workers のプラン)で Workers Paid を選ぶ。料金は月 $5 からで、支払い方法の登録が要る

**同じ依頼文で、最初のワークスペースの名前を聞く**(`deploy-answers.yaml` の `workspace_name` が `#` で始まる未記入のとき)。別の機会に聞き直すと、人に確認を求める回数が増える。必ずこの依頼文に含める。

- ワークスペース = 管理画面でサイトとメンバーをまとめる単位。名前は管理画面のサイドバーに出る。後から変えられる。例: 会社名・チーム名・サイト名
- 答えを `workspace_name` の行の `#` を外して書く(5 節の `POST /setup` で使う)
- 決めないと答えたときだけ、既定の名前にする。設置サイトのゾーンに置く構成(`edge_address: route`)ではゾーン名(`zone_name`。例 `example.com`)、別のドメインに置く構成(`custom-domain`)とドメインなしの構成(`workers-dev`)では `Default Workspace`。別のドメインのゾーン名は、サイトの名前にならないため

`deploy-secrets.env` の形(要る行だけ):

```bash
GOOGLE_CLIENT_ID=<クライアント ID>          # 秘密ではないが受け渡しをまとめるためここに書く。3.4 の vars に入る
GOOGLE_CLIENT_SECRET=<クライアント シークレット>
CF_TOKEN=<Cloudflare API トークン>          # route・custom-domain のとき、または control・管理画面を自分のドメインに置くとき
CF_DEPLOY_TOKEN=<配信ファイルのデプロイ用トークン>   # どの構成でも要る
CF_USAGE_TOKEN=<使用状況の表示用トークン>   # どの構成でも要る
```

確認。値は表示しない。Windows のエディタで書くと行末に CR が付くので、取り除いて読む:

```bash
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
{ [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; } && echo google=ok || echo google=missing   # missing なら人に記入を頼み直す(この先で空の値を登録しない)
[ -n "$CF_TOKEN" ] && echo cf_token=present || echo cf_token=missing   # edge_address が route か custom-domain、または control_address か admin_address が custom なら present が期待(それ以外は missing でよい)
[ -z "$CF_TOKEN" ] || curl -sS https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CF_TOKEN" | jq -r .result.status   # 期待: active
[ -n "$CF_DEPLOY_TOKEN" ] && echo cf_deploy_token=present || echo cf_deploy_token=missing   # 期待: present(どの構成でも要る。missing なら人に頼み直す)
[ -z "$CF_DEPLOY_TOKEN" ] || curl -sS https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CF_DEPLOY_TOKEN" | jq -r .result.status   # 期待: active
[ -n "$CF_USAGE_TOKEN" ] && echo cf_usage_token=present || echo cf_usage_token=missing   # 期待: present(missing なら人に頼み直す)
```

導入が終わったら(5 節の後)`rm deploy-secrets.env` を実行する。`CF_TOKEN` は期限切れで無効になるので失効の操作は要らない。導入の後に control か管理画面を自分のドメインに移すときは、4.2・7.1 の空きの確認のために作業用のトークンを作り直す。0.5 の手順で `deploy-secrets.env` を `CF_TOKEN=` の行だけで作り直し、そのホストのゾーンに限った Zone(ゾーン)→ Zone(ゾーン)→ Read(読み取り)と Zone(ゾーン)→ DNS → Read(読み取り)のトークン(期限 = 翌日)を人に作ってもらって書く。確認が済んだらファイルを消す。`CF_DEPLOY_TOKEN` と `CF_USAGE_TOKEN` は期限が無く、それぞれデプロイ専用の Worker と control の secret として使い続ける。失効は撤去のときに行う(10.4)。

## 1. 前提と全体像

構成要素は 5 つある(全体像は [README の構成図](../README.md#構成図))。

| 要素 | 役割 | 置き場所 |
|---|---|---|
| edge(`apps/edge`) | データプレーン。decision・event を訪問者に返す。KV は読むだけ | Cloudflare Workers(設置サイトのゾーンに Route で配置する。別のドメインに置く構成では、そのドメインのホストに Custom Domain で配置する。2 節) |
| 配信専用の Worker(`wtt-static`) | 設置タグのファイル(`/s/<siteId>.js`)を静的アセットとして配る。訪問者の読み込みは Worker を起動しない | Cloudflare Workers(設置サイトのゾーンに Route で配置する。別のドメインに置く構成では、edge と同じホストに Route で配置する。2.9) |
| デプロイ専用の Worker(`apps/deployer`、`wtt-deployer`) | 公開・設定の保存のたびに、control の依頼で設置タグのファイルを作り直して `wtt-static` に入れる。デプロイ用トークンを持つのはこの Worker だけ | Cloudflare Workers(インターネットには出さない。2.9) |
| control(`apps/control`) | コントロールプレーン。管理 API・認証・公開。D1 / R2 / KV に書く | Cloudflare Workers(3 節) |
| admin(`apps/admin`) | 管理画面(Next.js)。control の API を BFF 経由で呼び出す | Cloudflare Workers(control とは別の Worker。4 節) |

admin のリクエストの数え方:

- SSR(`/login` / `/setup` / `/w/...` の描画と `/api/*`)は、Workers の日次リクエスト上限を edge / control と共有する。上限は Free で 10 万 / 日、アカウント単位
- 静的ファイル(JS / CSS)は Workers Static Assets から配られ、上限に算入されない
- admin は認証前でも Worker を起動する。`admin_address: workers-dev` では WAF を掛けられないので、リクエストを送り続けられると edge / control も止まる。edge の `*.workers.dev` と同じ制約。到達を絞るなら 4.2 + 4.5

使う Cloudflare のリソース:

| リソース | 用途 | 使う側 |
|---|---|---|
| ゾーン 1 つ(カスタムドメイン) | edge を訪問者と同一オリジンで公開する。Cache Rule と WAF もこのゾーンに置く。別のドメインに置く構成(`edge_address: custom-domain`)では、設置サイトではなく別のドメインのゾーンに edge と `wtt-static` を置き、Cache Rule と WAF もそのゾーンに置く(訪問者からは別オリジンになる)。ドメインなし構成(`edge_address: workers-dev`)では不要 | edge |
| Workers KV(`wtt-config`) | 配信中の config とサイト設定を配信用に複製したもの(元データは D1)。control が書き、edge が読む | 両方(同じ namespace) |
| D1(`wtt-control`) | ユーザー・ワークスペース・サイト・エクスペリエンス・公開履歴・テストの評価計画と固定した結果・採用の記録 | control |
| D1(`wtt-results`。計測用のデータベース) | テストの結果の記録(参加者と目標の達成。訪問者 ID はそのまま置かず、鍵付きのハッシュにする)。結果を記録するサイトの分だけ増え、保持期間を過ぎた記録は control が消す | edge が書き、control が読んで集計する |
| R2(`wtt-assets`) | IMAGE の変更のアップロード先。R2 なし構成(`asset_public_base: none`)では不要 | control |
| Durable Objects(`VisitorProfile`) | 履歴条件・`persistAssignment`・目標の訪問者状態 | edge |
| Durable Objects(`ResultsBudget`・`ResultsHealth`) | 結果の記録の 1 日の予算(導入全体で 1 つ)と、収集できなかった送信の数(サイトごと) | edge。control も使う(記録の停止・削除の枠・集計の読み取りの予約と、失敗の数の読み取り) |
| Durable Objects(`NewProfileBudget`) | 新しい訪問者の記録(`VisitorProfile`)の数の上限。1 日と 1 時間に新しく記録した数をサイトごとに数える(Free では導入全体の合計も)。[運用ガイド 7 節](operations.md#新しい訪問者の記録の上限サイト設定) | edge |
| Durable Objects(`DeployQueue`) | 設置タグのファイルの作り直しを 1 本ずつ流し、失敗したら再試行する | デプロイ専用の Worker |
| Rate Limiting binding | 無認証入口の補助的な絞り(実効は限定的。[運用ガイド 7 節](operations.md#7-レート制限の実効)) | 両方 |

制約が 3 つある。

**(1) 1 つの Cloudflare アカウントに置けるのは 1 インスタンスだけ。** Worker・D1・KV・R2 の名前(`wtt-` で始まる)と Rate Limiting binding の `namespace_id` は固定になっている。同じアカウントに 2 つ目を導入すると 1 つ目を上書きし、Rate Limiting はカウンタを共有する。

- 検証用と本番など複数を動かすときは Cloudflare アカウントを分ける。Free のアカウントを足しても費用はかからない
- アカウントを分けると、無料枠の日次上限(アカウント単位)と、配信ファイルのデプロイ用トークン(アカウント全体に適用される)も分かれる

**(2) 設置サイトのゾーンに置く構成(`route`)では、設置ホストの DNS レコードは Cloudflare のゾーンにあり、プロキシが有効(オレンジの雲)であること。** Workers Route はプロキシ経由のホストでしか発火しない。確認: `curl -sI https://<設置ホスト>/ | grep -i '^server:'` が `server: cloudflare`。違う場合は Route が動作しないので、先に運用者に伝える([導入構成の選び方 2 節](install-patterns.md#2-edge-の置き方問い-1))。

別のドメインに置く構成(`custom-domain`)では、設置サイトにこの条件は要らない。代わりに、別のドメインのゾーンが導入するアカウントにあり、有効であること(0.4 のログインの後の確認の 4)。edge のホストの DNS レコードは、2.4 の deploy で edge の Custom Domain が作る。既存のレコードを上書きしないよう、2.3 でそのホストが空いていることを確かめる。

**(3) edge の公開アドレスは、設置サイトのゾーンの Workers Route(既定)か、別のドメインの Custom Domain か、`*.workers.dev`(ドメインなし構成)。** 別のドメインの Custom Domain は、サイトのドメインが Cloudflare に無いときに、Cloudflare に置ける別のドメインのホスト(例 `ab.example.net`)で edge と設置タグを公開する構成。`*.workers.dev` はドメインを用意せずに始められる簡易的な導入方法で、次の制約を承知の上で選ぶ。詳しい比較は[導入構成の選び方 2 節](install-patterns.md#2-edge-の置き方問い-1)にある。

| | ゾーンの Route(既定) | 別のドメイン(Custom Domain) | `*.workers.dev` |
|---|---|---|---|
| ゾーンの WAF Rate Limiting Rule(2.7) | 作れる | 作れる(別のドメインのゾーンに作る) | 作れない。Worker の起動前に捨てる仕組みが無いので、無料枠の日次上限(10 万リクエスト)を 1 台の機械から数分で使い切られうる。使い切ると当日は edge も control も止まる。上限はアカウント単位 |
| ゾーンの Cache Rule(2.6) | 作る。設置タグのファイルのブラウザキャッシュの設定が上書きされないようにする、念のための設定 | 作る(別のドメインのゾーンに、条件のホストを `<edge のホスト>` にして作る) | 作れない(ゾーンが無い)。設置タグのファイルのヘッダー(60 秒)は配信専用の Worker が付けるので、変更されずに適用される |
| Mode B(サーバー発行 Cookie) | 使える | 使えない(ページのホストに `/__ab/*` を置けないため。Mode A か Mode C で運用する) | 使えない |
| タグと設置サイト | 同一オリジン | 別オリジン。サイト設定の「ドメイン」の節の「タグを置くドメイン」に、ページのホストが要る(サイトを作ると作成のときに入れたドメインが 1 行目に入る。ページのホストが複数なら足す。edge が受け付けるページの Origin はこの一覧から決まる)。サイトが CSP を出していれば `script-src` と `connect-src` に `<edge のホスト>` を足す(設置タグと edge が同じホストなので 1 つ) | 別オリジン。サイトが CSP を出していれば `script-src` に `wtt-static` のホスト、`connect-src` に edge のホストを足す |

別のドメインに置く構成では、ほかに次の 2 つを承知しておく:

- 設置タグをページと別のホストから読み込むので、ブラウザや拡張機能の追跡防止の機能に遮断されやすい
- WAF の遮断(Cloudflare の 1015)は、別オリジンの構成では通知されない。WAF の応答には別のドメインのページから読むための許可のヘッダーが付かず、タグが通信の失敗として扱うので、`ab_error` を push しない。edge の binding の 429 は許可のヘッダーを付けているので通知される([運用ガイド 7 節](operations.md#429-が訪問者に与える影響))

`*.workers.dev` の前提条件(2 つとも満たさないなら Route にする):

- Cloudflare アカウントが Free であること。Paid だと、悪意のある人がプログラムで大量のアクセスを送ってきた場合に、そのアクセスの分もすべて請求に含まれる。タグのアドレスはサイトの HTML に書かれるので誰でも知ることができ、アクセスを制限する仕組み(WAF)を置けない。支出上限を設定する機能も無い
- 止まると困る Workers が同じアカウントに無いこと

満たしていても、Mode B を使いたい・悪意のある人の大量のアクセスで止まると困る・1 日のアクセスが無料枠に近いなら Route のほうがよい。後から設置サイトのゾーンの Route へ移る手順は 2.8(別のドメインに置く構成へ移る手順はまだ無い)。control 側にはこの制約が無く、`*.workers.dev` のままでも動く(3 節)。

## 2. edge のデプロイ

### 2.1 runtime を生成し直す

```bash
pnpm runtime:build
```

`packages/runtime/generated/source.ts` を最新化する。これは生成物で、デプロイは git の内容を手を加えずに送る。**忘れると設置タグのファイル(`/s/<siteId>.js`)が古い runtime を配り続ける**(設置タグのファイルは、デプロイ専用の Worker が自分に同梱した runtime で作る。2.9)。`pnpm edge:dev` / `pnpm e2e` は自動でこの手順を含むが、`wrangler deploy` は含まない。

確認: `git status --short packages/runtime/generated/` が空(tag の内容と一致)なら OK。

期待と違うとき: 差分が出る → Node のバージョン差で生成結果が変わっている。差分を残したまま進めてよい(deploy には生成後の内容が使われる)。

### 2.2 KV と計測用のデータベースを作り、設定に書く

**KV(`wtt-config`)**:

```bash
pnpm -C apps/control exec wrangler kv namespace create wtt-config </dev/null   # </dev/null = 「設定ファイルに追記するか」の問いを非対話にして、追記しない(id は下の手順で書く)
```

出力の `"id": "…"` の 32 桁を控え、**`apps/edge/wrangler.jsonc` と `apps/control/wrangler.jsonc` の両方**の `kv_namespaces[0].id` に書く。control が公開で書き、edge が読む同じ namespace なので、片方だけだと edge が config を見つけられない。

**リソースを作るコマンドの共通の注意**(2.2・3.1・3.2): `Would you like Wrangler to add it on your behalf?` と聞かれたら **No**。設定ファイルは手で書く(Yes にすると別名の binding が追加される)。確認で binding(`kv_namespaces` / `d1_databases` / `r2_buckets`)が 1 件だけであることを見る。

確認:

```bash
KVID=<作成した id>
grep -c "\"id\": \"$KVID\"" apps/edge/wrangler.jsonc apps/control/wrangler.jsonc   # 期待: 出力 2 行とも :1
grep -c 00000000000000000000000000000000 apps/edge/wrangler.jsonc apps/control/wrangler.jsonc || true   # 期待: 各 0(雛形の KV の id が残っていない。deployer の雛形の CF_ACCOUNT_ID も 32 桁の 0 だが、2.9 で書くのでここでは見ない)
grep -c '"binding": "CONFIG_KV"' apps/edge/wrangler.jsonc apps/control/wrangler.jsonc   # 期待: 各 1(kv_namespaces が 1 件だけ)
pnpm -C apps/control exec wrangler kv namespace list | jq -r '.[] | select(.title | endswith("wtt-config")) | .id'   # 期待: 上で書いた id
```

期待と違うとき: `wrangler kv namespace create` が `already exists` を含むエラーを返す → 前回の作業で作った namespace が残っている。`kv namespace list` で id を引いて同じように書く。

**計測用のデータベース(D1 の `wtt-results`)**: テストの結果(参加者と目標の達成)を記録する D1。設定用の `wtt-control`(3.1)とは分けてある(書き込みの量と保持期間が違い、`wtt-control` の控えと Time Travel を参加者ごとの記録(個票)で大きくしないため)。edge が書き、control が結果の集計のために読み、保持期限を過ぎた記録を消す。edge と control の設定がこのデータベースを参照するので、どの構成でも作る。順は、作成 → `database_id` を書く → 表を作る(マイグレーション)→ 鍵の登録 → 2.4 の edge のデプロイ。

```bash
pnpm -C apps/edge exec wrangler d1 create wtt-results </dev/null   # KV と同じく、設定ファイルへの追記は非対話なので行わない(database_id は下の手順で書く)
```

出力の `database_id` を、**`apps/edge/wrangler.jsonc` の `d1_databases[0].database_id` と、`apps/control/wrangler.jsonc` の `RESULTS_DB` の行(`d1_databases[1].database_id`)の両方**に書く。リポジトリの値は仮の ID(`00000000-0000-0000-0000-000000000000`)で、KV の id と同じく導入ごとに自分の ID に書き換える。仮の ID のまま edge と control をデプロイしない。

- control の `RESULTS_DB` の行の `migrations_dir`(`../edge/results-migrations`)は、手元の開発とテストのためのもの。本番の `wtt-results` の表を作る・更新するのは、下の `pnpm -C apps/edge results:migrate:remote` だけ。control の `d1:migrate:remote` は `wtt-control` だけに当たる

表を作る。`database_id` を書いた後に行う(wrangler は設定ファイルの ID でデータベースを探す):

```bash
pnpm -C apps/edge results:migrate:remote   # 表を作る。期待: 0001_results.sql が適用される(適用済みなら No migrations to apply)
```

**訪問者 ID を変換する鍵(edge の secret `RESULTS_VISITOR_KEY`)**: edge は計測用のデータベースに訪問者 ID をそのまま書かず、この鍵で計算したハッシュ(HMAC-SHA-256 の先頭 16 バイト)を書く。

- 鍵は 32 バイトの乱数を base64 にした文字列。下のコマンドが作り、画面に出さずにそのまま登録する。エージェントも鍵の値を表示せず、会話・`deploy-log.md` に書かない。人が手で作るときも、チャットに貼らない
- edge は、base64 として読めない・復号して 32 バイトに満たない・空の鍵を使わない。鍵が無いときと同じく結果を書かず、その送信を「収集できなかった送信」として数える。エクスペリエンスの配信は止まらない
- **鍵を変えると、同じ訪問者が別の人として記録される**(ハッシュが変わるため)。一度登録したら変えない。鍵を入れ替える手順は無い
- edge がまだデプロイされていなければ、wrangler は空の Worker `wtt-edge` を作ってから secret を入れる(3.3 で control のデプロイの前に secret を入れるのと同じ扱い)。2.4 のデプロイで中身が入る

```bash
openssl rand -base64 32 | pnpm -C apps/edge exec wrangler secret put RESULTS_VISITOR_KEY   # 鍵を作り、画面に出さずに edge の secret に入れる
```

確認:

```bash
RDB=<作成した database_id>
grep -c '"binding": "RESULTS_DB"' apps/edge/wrangler.jsonc apps/control/wrangler.jsonc   # 期待: 各 1(RESULTS_DB の binding が 1 つ)
grep -c "\"database_id\": \"$RDB\"" apps/edge/wrangler.jsonc apps/control/wrangler.jsonc   # 期待: 各 1(両方に同じ ID)
grep -c 00000000-0000-0000-0000-000000000000 apps/edge/wrangler.jsonc || true   # 期待: 0(仮の ID が残っていない。control の wtt-control の仮の ID は 3.1 で書く)
pnpm -C apps/edge exec wrangler d1 list --json | jq -r '.[] | select(.name == "wtt-results") | .uuid'   # 期待: apps/edge/wrangler.jsonc に書いた database_id
pnpm -C apps/edge exec wrangler secret list | jq -r '.[].name'   # 期待: RESULTS_VISITOR_KEY
```

期待と違うとき:

- `wrangler d1 create` が `already exists` を含むエラーを返す → 前回の作業で作ったデータベースが残っている。`d1 list --json` の uuid を書く
- `results:migrate:remote` がデータベースが見つからない旨のエラーで止まる → `database_id` を書いていないか、違う ID を書いている。上の確認の `d1 list` の行と見比べる
- 2 行目か 3 行目で control が 0 → control の `RESULTS_DB` の行に書き忘れている。edge と同じ ID を書く(違う ID のままだと、control が結果を読めない)
- `secret list` に `RESULTS_VISITOR_KEY` が無い → 鍵の登録をやり直す。登録の前に結果の送信を受けても、edge は書かずに数えるだけで、配信は止まらない

**結果の記録の 1 日の予算(`apps/edge/wrangler.jsonc` の `vars`)**: 既定のままでよい。Cloudflare の Free の日次上限(D1 の書き込み 10 万行・読み取り 500 万行)はアカウント全体で `wtt-control` と分け合うので、結果の記録に使う量に上限を設けてある。守る順は「配信 > 管理操作(公開・終了など)> 結果の記録」で、予算を使い切った日は、次の UTC 0 時まで結果を記録しない(エクスペリエンスの配信は続く)。

| キー | 既定 | 内容 |
|---|---|---|
| `RESULTS_WRITE_BUDGET` | `"70000"` | 結果の書き込みの 1 日(UTC)の上限の行数(インデックスの書き込みを含む)。D1 の書き込みの上限 10 万行のうち、残りを control と管理画面に残す |
| `RESULTS_READ_BUDGET` | `"3000000"` | 結果の集計の読み取りの 1 日(UTC)の上限の行数(D1 の読み取りの上限は 500 万行) |
| `RESULTS_LEASE_ROWS` | `"200"` | edge が予算から 1 回に受け取る行数。大きいほど予算の確認の回数が減るが、使われずに捨てる行が増える |

- 値は正の整数を文字列で書く。`"0"`・数でない値・省略は既定値として扱う(0 にしても記録は止まらない。記録を止めるのはサイト設定の「結果を記録する」)
- `wrangler.jsonc` の `vars` は、デプロイのたびにダッシュボードで変えた値を上書きする。変えるときはこのファイルを直してデプロイする
- 予算は導入全体で 1 つで、サイトごとには分けない。1 つのサイトへの送信が集中すると、ほかのサイトの記録もその日の残りは止まる

### 2.3 Route を書く

**先に、edge の Rate Limiting binding の値を書く**(どの構成でも)。`apps/edge/wrangler.jsonc` の `ratelimits[0].simple.limit` が、1 つの IP から 10 秒あたりに受ける回数の上限になる。値は構成で決まる:

- **WAF がある構成**(ゾーンのある構成(`edge_address` が `route` か `custom-domain`)で WAF を作るとき。`edge_waf_rate_limit` が `false` でない。既定): 1000 と、2.7 の WAF の 1 期間あたりの回数(`edge_waf_requests_per_10s`)の大きいほう。雛形の値は 1000 なので、WAF の回数が 1000 以下ならそのままでよい。2.7 で WAF の期間を 60 秒にしたときは、60 秒あたりの回数をそのまま 1000 と比べる
- **WAF が無い構成**(`edge_address: workers-dev`、または `edge_waf_rate_limit: false`): `edge_waf_requests_per_10s`(既定 200)

理由: binding は WAF の後ろにあり、IP ごとに数える。WAF より厳しい値にすると、WAF が通した訪問を後ろで止めてしまう。WAF がある構成では主に WAF で保護するので、binding は大きめの値にする。

binding は WAF の設定を引き継がない。WAF で数える単位を IP with NAT support(Cloudflare の画面の名前。日本語の表示は未確認)にしても、自社オフィスなどの送信元を式で除外しても、binding は 1 つの IP からの合計で数える。たとえば WAF から除外したオフィスから 10 秒に 1000 回を超えて届くと、binding が止める。1 つの IP からの合計が binding の上限を超えうるなら、binding をその合計まで上げる。

確認:

```bash
grep -n '"limit"' apps/edge/wrangler.jsonc   # 期待: 書いた値の行が 1 つ
```

続けて Route を書く。`edge_address` で分かれる。

**`workers-dev` のとき**: `routes` を書かず、`apps/edge/wrangler.jsonc` に次を書く(`routes` があれば削除する。`dev.host` は不要):

```jsonc
"workers_dev": true
```

このとき 2.6 と 2.7 は飛ばし、2.4 の確認は `https://wtt-edge.<アカウントのサブドメイン>.workers.dev/v1/sites/probe/decision` に読み替える(サブドメインは初回 `wrangler deploy` の出力に出る)。

**`custom-domain` のとき**: 別のドメインのホスト(`<edge のホスト>` = `edge_host`)を edge の Custom Domain にする。設置タグを配る `wtt-static` も、2.9 で同じホストの `/s/*` に置く。

先に、そのホストが空いていることを API で確かめる。非対話で実行した `wrangler deploy` は、Custom Domain を作るときに、同じ名前の既存の DNS レコードと、ほかの Worker への割り当てを確認なしに上書きするため。確かめるのは 2 つ: (1) ゾーンにそのホストと同じ名前の DNS レコードが無い(種類を問わない)(2) そのホストがほかの Worker の Custom Domain に使われていない。`*.<ゾーン>` のようなワイルドカードのレコードは上書きされないので見ない。

```bash
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
HOST=<edge のホスト>            # edge_host(例 ab.example.net)
ZONE=<ゾーン名>                 # zone_name(例 example.net)
T=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
AID=${CLOUDFLARE_ACCOUNT_ID:-$(pnpm -C apps/control exec wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}
ZID=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=$ZONE" -H "Authorization: Bearer $CF_TOKEN" | jq -r '.result[0].id')

# 1. 同じ名前の DNS レコードが無い(CF_TOKEN の DNS Read を使う)
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?name=$HOST" -H "Authorization: Bearer $CF_TOKEN" | jq '{ok: .success, n: (.result | length)}'   # 期待: {"ok": true, "n": 0}
# 2. ほかの Worker の Custom Domain に使われていない(wrangler login の資格情報を使う)
curl -sS "https://api.cloudflare.com/client/v4/accounts/$AID/workers/domains?hostname=$HOST" -H "Authorization: Bearer $T" | jq '{ok: .success, n: (.result | length)}'   # 期待: {"ok": true, "n": 0}
```

期待と違うとき:

- `ok` が `true` でない・権限のエラーが出る・jq がエラーになる(応答が JSON でない)→ 空いているとはみなさず、作業を中断して人に聞く。1 の権限のエラーは、`CF_TOKEN` に Zone → DNS → Read が無いときに出る(0.5 の 2)
- `n` が 1 以上 → そのホストは使われている。別のホストにする(0.2 の E2c を答え直す)か、使っていないことを人に確かめてから人に消してもらう。消した後に、このブロックをやり直す

確かめたら、`apps/edge/wrangler.jsonc` の `routes` を次にする(`workers_dev` の行は書かない):

```jsonc
"routes": [
  { "pattern": "<edge のホスト>", "custom_domain": true }
],
"dev": { "host": "localhost" }
```

- `/__ab/*` は書かない。Mode B(サーバー発行 Cookie)はページのホストの Route が前提で、この構成では使えない
- 下の `route` のときの確認(そのパスに既存のコンテンツが無いことの `curl`)は要らない。新しいホストで、空いていることは上の API で確かめたため

**`route`(既定)のとき**: `apps/edge/wrangler.jsonc` の `routes` に、設置サイトのホストで受けるパスを並べる(ダッシュボードでは張らない。設定ファイルが正)。

```jsonc
"routes": [
  { "pattern": "<設置ホスト>/v1/*", "zone_name": "<ゾーン名>" }
],
"dev": { "host": "localhost" }
```

`<設置ホスト>` = `install_host`、`<ゾーン名>` = `zone_name`。`dlite_hosts` に書いたホストごとに `{ "pattern": "<host>/__ab/*", "zone_name": "<ゾーン名>" }` を足す。

`dlite_hosts` のホストが多いときは、ホストごとの行の代わりに、ワイルドカードの `{ "pattern": "*.<ゾーン名>/__ab/*", "zone_name": "<ゾーン名>" }` 1 行に手でまとめてもよい。この形はゾーン名そのもの(`www` などを付けないホスト。例 `example.com`)を含まない(Cloudflare の資料のとおり)。ゾーン名そのもののページにもタグを置くなら、`{ "pattern": "<ゾーン名>/__ab/*", "zone_name": "<ゾーン名>" }` を別に足す。まとめても、サイト設定の「タグを置くドメイン」にはホストを 1 つずつ書く(ワイルドカードは書けない)。後から Mode B のホストを足す手順は [6.7](#67-mode-b-のホストを後から足す)。

パスごとの意味:

- `/v1/*`(必須): decision / event。履歴条件または `persistAssignment` を使うサイト(`needsProfile`)、または結果を記録するサイトで使う。目標は `needsProfile` のサイトでだけ `/event` にも送られる(目標だけでは `needsProfile` にならず、`ab_conversion` は `dataLayer` にのみ出る)。結果を記録するサイトでは、テストの参加と目標の達成を `needsProfile` に関係なく `/event` に送る。設置タグのファイルに edge の宛先(control の `AB_EDGE_ORIGIN`)が書き込まれるので、runtime はそこへ送る
- `/s/*`: **edge には書かない**。設置タグのファイルは配信専用の Worker `wtt-static` が配る。`/s/*` を `wtt-static` に向けるのは 2.9
- `/__ab/*`: Mode B(サーバー発行 Cookie。旧称 D-lite)のサイトを置く場合に追加する。パターンは `<ページのホスト>/__ab/*`(Mode B ではタグがページのホストへ相対 URL で送るため。[サイト導入ガイド 8 節](site-install.md#8-mode-c-と-mode-b))。Mode B の `/__ab/decision` は Cookie の無い要求のたびに新しい visitorId を発行するため、2.7 の WAF ルールを**必ず**作る(`edge_waf_rate_limit: false` を選ばない。Mode B はゾーンの Route が前提なので、ルールは常に作れる)

**`routes` を書いたら `"dev": { "host": "localhost" }` も併記する。** 理由: `routes` があると `wrangler dev` のローカル origin host が route のホスト名になり(`--local-upstream` の既定が「dev.host or route」)、host からサイトを引く Mode B の経路がローカルで 404 になって `pnpm e2e` が落ちる。

確認(`/s/*` を `wtt-static` に向ける前(2.9)と、`/v1/*` の Route を張る前に、そのパス配下に既存コンテンツが無いこと):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://<設置ホスト>/s/probe.js"   # 期待: 404(サイト本体にそのパスが無い)
curl -sS -o /dev/null -w '%{http_code}\n' "https://<設置ホスト>/v1/sites/probe/decision"   # 期待: 404(同上)
```

期待と違うとき: 200 が返る → サイトが既に `/s/` か `/v1/` を使っている。Route を張ると上書きされるので、先に運用者に確認する。

### 2.4 デプロイ

```bash
pnpm -C apps/edge exec wrangler deploy
```

補足:

- 初回は Durable Objects の migration(`wrangler.jsonc` の `migrations[].tag`。`v1` = `VisitorProfile`、`v2` = 結果の記録の `ResultsBudget`・`ResultsHealth`、`v3` = 新しい訪問者の記録の上限の `NewProfileBudget`。どれも `new_sqlite_classes`)を wrangler が自動で適用する。以後、クラス名を変えない限り tag は増やさない
- 2.2 の計測用のデータベースの `database_id` が仮の ID のままならデプロイしない(2.2 の確認)
- Rate Limiting binding は wrangler 4.36 以上が必要。`namespace_id` はアカウント内で一意な整数文字列

確認: `route` では、出力の末尾に `Deployed wtt-edge triggers` と Route が 1 本(`/v1/*`。Mode B があればその分も)並べば OK。`workers-dev` では triggers に `https://wtt-edge.<アカウントのサブドメイン>.workers.dev` が 1 行出る。この URL が edge の公開 origin で、3.4 の `AB_EDGE_ORIGIN` に使う(設置タグの `src` のホストは 2.9 の `wtt-static` のアドレス)。

`route` では、確認の `curl` を設置ホストに送る(`workers-dev` では 2.3 のとおり workers.dev の URL に読み替える。`custom-domain` はこの下):

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "https://<設置ホスト>/v1/sites/probe/decision"   # 期待: 404 text/plain(Worker の応答。サイト本体の 404 ページ(text/html)ではない)
```

期待と違うとき(`route`): `text/html` が返る → Route が適用されていない。`zone_name` / ホスト名 / `wrangler deploy` の出力の triggers を見比べる。

`custom-domain` では、triggers に `<edge のホスト> (custom domain)` が出ること。確認の `curl` は edge のホストに送る:

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "https://<edge のホスト>/v1/sites/probe/decision"   # 期待: 404 text/plain(Worker の応答)
```

期待と違うとき(`custom-domain`): Custom Domain の証明書の発行に数分かかることがある。`curl` が TLS(SSL)のエラーで失敗したら、1 分おいてやり直す。名前を引けない(`Could not resolve host`)ときも、DNS レコードの反映を待ってやり直す。続くときは、triggers に Custom Domain が出ているかと、0.4 のログインの後の確認の 4(ゾーンが有効になっているか)を見直す。

### 2.5 公開アドレスの選び方

設置サイトのゾーンの Workers Route(`<設置ホスト>/s/*` を `wtt-static` に、`<設置ホスト>/v1/*` を edge に)を推奨する。設置タグと decision / event が設置サイトと同一オリジンになるため CORS の設定も DNS レコード・証明書の追加も要らない。

サイトのドメインが Cloudflare に無いときは、Cloudflare に置ける別のドメインのホスト(`<edge のホスト>`。例 `ab.example.net`)に置く(`edge_address: custom-domain`)。1 つのホストに、edge を Custom Domain で、`wtt-static` を `<edge のホスト>/s/*` の Route で置く。設置タグと decision / event はページと別オリジンになるので、サイト設定の「タグを置くドメイン」にページのホストが要る(サイトを作ると作成のときに入れたドメインが入る)。代償は 1 節の制約 (3)。どちらも無いときは `*.workers.dev`(`edge_address: workers-dev`)。

### 2.6 ゾーン側の Cache Rule(念のため。推奨)

`edge_address: workers-dev` ではここを飛ばす。ゾーンが無いので作れない。

**なぜ要るか**: 設置タグのファイルは `Cache-Control: public, max-age=60` を付けて配られ、公開が 60 秒以内にブラウザへ届く設計になっている。内訳は、ファイルの更新に数秒、ブラウザのキャッシュに 60 秒。

ところがゾーンの Browser Cache TTL 設定は、エッジキャッシュに当たった応答の `Cache-Control` を設定値で上書きする場合がある。この設定が 4 時間を既定とするプランもある。上書きされると、戻り訪問者のブラウザが公開後も最大 4 時間ぶん古い config を使い続ける。

実機で確かめたところ、配信専用の Worker の応答は上書きされなかった。ただしゾーンの設定やプランで変わりうるので、念のための保険として `/s/*` だけを Cache Rule で切り離し、配信ファイルのヘッダーを尊重させておく。ゾーン全体の Browser Cache TTL を変える案は、サイト本体の静的アセットのキャッシュ挙動まで変わるので採らない。

**設定値**(API・ダッシュボード共通)

- 条件: Hostname が `<設置タグのホスト>` かつ URI Path が `/s/` で始まる。`<設置タグのホスト>` は、`route` なら設置ホスト(`install_host`)、`custom-domain` なら edge のホスト(`edge_host`)
- Browser TTL: Respect origin TTL(`respect_origin`)
- Edge TTL: 触らない
- `/v1/*`(decision / event)は Worker が `no-store` を返すので対象にしなくてよい

#### 既定: API で作る(エージェントはこちら)

使うのは 0.5 で受け取った `CF_TOKEN`(Cache Rules Edit + Zone WAF Edit + Zone Read + DNS Read、ゾーン限定、期限 = 翌日)。

2.6 / 2.7 の bash ブロックは同じシェルで続けて実行する。別々に実行する場合は、各ブロックの前に `set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a` と `HOST=… ZONE=… H=… ZID=…` の定義を入れ直す。

期待と違うとき(2.6 / 2.7 共通): API が `403` または `errors` に `not entitled` / `permission` を含む応答を返す → トークンに Account → Account Rulesets → Edit を追加して再発行する。Cloudflare の文書には、Cache Rules の管理に Account Rulesets Edit を挙げる版がある。必要な権限の最小集合は環境で確認する。

```bash
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
curl -sS https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CF_TOKEN" | jq -r .result.status   # 期待: active
```

```bash
HOST=<設置タグのホスト>         # route なら設置ホスト(install_host。例 www.example.com)、custom-domain なら edge のホスト(edge_host。例 ab.example.net)
ZONE=<ゾーン名>                 # zone_name(例 example.com。custom-domain なら edge_host が属するゾーン)
H="Authorization: Bearer $CF_TOKEN"

# 1. Zone ID
ZID=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=$ZONE" -H "$H" | jq -r '.result[0].id')

# 2. このフェーズに既存の ruleset があるか(無ければ "could not find entrypoint ruleset" が返る)
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/phases/http_request_cache_settings/entrypoint" -H "$H" \
  | jq '{success, errors, id: .result.id, rules: [.result.rules[]? | {id, expression}]}'
```

手順 2 の出力で分岐する:

- `"success": false` かつ errors に `could not find entrypoint ruleset` → 3a。このゾーンには Cache Rule が 1 本も無い
- `"success": true` → 3b。既存ルールがあるので、`id` を `RID` に入れる。再実行時に、`rules` に `starts_with(http.request.uri.path, "/s/")` を含む式が既にあれば作らずに終わる

```bash
RULE=$(cat <<JSON
{"description":"WTT bootstrap: respect Worker Cache-Control (max-age=60) on /s/*",
 "expression":"(http.host eq \"$HOST\" and starts_with(http.request.uri.path, \"/s/\"))",
 "action":"set_cache_settings",
 "action_parameters":{"browser_ttl":{"mode":"respect_origin"}},
 "enabled":true}
JSON
)

# 3a. 既存 ruleset が無い場合: entrypoint を作る(PUT は rules を丸ごと置き換えるので、既存ルールがあるゾーンでは使わない)
curl -sS -X PUT "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "$H" -H 'content-type: application/json' -d "{\"rules\":[$RULE]}" | jq '{success, errors}'

# 3b. 既存 ruleset がある場合: そのルール一覧に 1 本追加する(RID = 手順 2 の id)
RID=<手順 2 の id>
# curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/$RID/rules" \
#   -H "$H" -H 'content-type: application/json' -d "$RULE" | jq '{success, errors}'
```

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/phases/http_request_cache_settings/entrypoint" -H "$H" \
  | jq -r '.result.rules[] | select(.expression | contains("/s/")) | "\(.enabled) \(.action_parameters.browser_ttl.mode)"'   # 期待: true respect_origin
```

#### 代替: ダッシュボードで作る

1. Cloudflare ダッシュボード → 対象ゾーン → Caching → Cache Rules → Create rule(ルールを作成)→ Cache Rules。Caching と Cache Rules は日本語の表示でも英語のまま
2. Rule name(ルール名): `WTT bootstrap: respect Worker Cache-Control on /s/*`
3. If incoming requests match…(受信リクエストが一致する場合…): Custom filter expression(カスタム フィルタ式)を選び、Edit expression(式を編集)で `(http.host eq "<設置タグのホスト>" and starts_with(http.request.uri.path, "/s/"))` を書く(`<設置タグのホスト>` は上の「設定値」の条件と同じ)。式で書くと表示の言語に左右されない
4. Then...(実行内容...): Browser TTL(ブラウザ TTL)の Add setting(設定を追加)→ Respect origin TTL(オリジン TTL を尊重する)。他の項目は変えない
5. Deploy(デプロイ)

#### 確認(API・ダッシュボード共通)

この確認は、サイトを作って初回公開した後(5 節のスモーク)でないと 404 になる。ルールはここで作り、ヘッダー確認は 5 節のスモークの直後に行う。

```bash
curl -sSI "https://<設置タグのホスト>/s/<siteId>.js" | grep -iE 'cache-control|cf-cache-status'
```

`cache-control: public, max-age=60` なら OK。`cf-cache-status: HIT` の応答でも 60 のまま。

期待と違うとき: `max-age=14400` などが出る → ルールが適用されていない。式のホスト名、Deploy 忘れ、別ゾーンを疑う。設定前に配られた設置タグのファイルはブラウザ側の TTL が切れるまで残るが、一度きりの遅れで済む。

### 2.7 WAF Rate Limiting Rule(推奨)

`edge_address: workers-dev` ではここを飛ばす。ゾーンが無いので作れない。

WAF を作るとき・値を変えるときは、edge の Rate Limiting binding の値が 2.3 の規則の値(1000 と WAF の 1 期間あたりの回数の大きいほう)以上かを確かめる。下回っていれば `apps/edge/wrangler.jsonc` の `limit` を 2.3 の規則の値に上げ、edge を deploy し直す。2.3 の注意に従って規則の値より上げてあるときは、そのままにする。

**なぜ要るか**: `/v1/sites/*` と `/__ab/*` は無認証(Origin 検証のみ)で、パターン一致 URL とランダムな visitorId を送られると Visitor Profile が量産される。Workers の Rate Limiting binding は本番で実効しない実測がある([運用ガイド 7 節](operations.md#7-レート制限の実効))。そのため、実効的な防御はゾーン側のルールに置く。

結果を記録するサイトの送信(テストの参加と目標の達成)も同じ `/v1/sites/*/event`(Mode B は `/__ab/event`)に届くので、このルールで受ける。結果の送信のために別のルールは作らない。

#### 既定: API で作る(エージェントはこちら)

`edge_waf_rate_limit: true`(既定)のとき。トークンは 2.6 と同じ `CF_TOKEN`(Zone → WAF → Edit を含む)。

```bash
LIMIT=200    # edge_waf_requests_per_10s
# 既存のレート制限ルールの有無(Free は 1 ルールまで)
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/phases/http_ratelimit/entrypoint" -H "$H" \
  | jq '{success, errors, id: .result.id, rules: [.result.rules[]? | {id, expression, requests_per_period: .ratelimit.requests_per_period}]}'
```

期待と違うとき:

- `could not find entrypoint ruleset` または `rules: []` → 下の PUT で作る
- 既にルールが 1 本あり、式に `/v1/sites/` が無い → Free プランでは枠が無い。運用者に「既存ルールに OR で `/v1/sites/` と `/__ab/` を足す」か「作らない(`edge_waf_rate_limit: false`)」かを聞く
  - 作らないを選んだら、`deploy-answers.yaml` の `edge_waf_rate_limit` を `false` にする(後の更新で WAF の有無を決めるのがこのキーなので、6.2)。あわせて `apps/edge/wrangler.jsonc` の `limit` を 2.3 の WAF が無い構成の値(`edge_waf_requests_per_10s`)に書き直し、edge を deploy し直す。2.3 では WAF がある構成の値(1000)を書いているため
  - OR で足すなら、しきい値はその既存ルールの回数になる。binding はその回数と 2.3 の規則で比べる。足すのは、**【人に依頼】** ダッシュボードでそのルールを開いて式を書き換えてもらう(下の PUT はレート制限ルールを丸ごと置き換えるので、既存のルールが消える)
- 式に `/v1/sites/` が既にあり、`/__ab/` も含まれる → 作らずに終わる(再実行時)
- 式に `/v1/sites/` はあるが `/__ab/` が無い → Mode B のサイトを置かない(入力ファイルの `dlite_hosts` が空)なら、作らずに終わる。Mode B のサイトを置くなら、`/__ab/*` がこのルールの外に残るので、**【人に依頼】** ダッシュボードでそのルールを開き、式に OR で `(starts_with(http.request.uri.path, "/__ab/"))` を足してもらう(下の PUT はレート制限ルールを丸ごと置き換えるので使わない)。足した後に上の GET で式を読み直し、`/__ab/` が入ったことを確かめる。式はパスだけで書くので、ゾーンの中のホストを後から足しても、そのホストの `/__ab/*` もこのルールに入る。後から Mode B のホストを足すとき([6.7](#67-mode-b-のホストを後から足す))は、式に `/__ab/` が入っていることだけを確かめ直す(それまで Mode B のホストが無かった導入では、ここで初めて足すことになる)
- 上の 2 つのどちらでも、式に `/setup` も含まれる(7.2 で control のパスを足して 1 本にした Free のルール)なら、回数を変えるときも下の PUT を使わない。PUT で置き換えると control のパスが消える。**【人に依頼】** ダッシュボードでそのルールを開いて回数を変えてもらう

```bash
RL=$(cat <<JSON
{"rules":[{"description":"WTT: rate limit unauthenticated edge endpoints",
 "expression":"(starts_with(http.request.uri.path, \"/v1/sites/\")) or (starts_with(http.request.uri.path, \"/__ab/\"))",
 "action":"block",
 "ratelimit":{"characteristics":["ip.src","cf.colo.id"],"period":10,"requests_per_period":$LIMIT,"mitigation_timeout":10},
 "enabled":true}]}
JSON
)
curl -sS -X PUT "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/phases/http_ratelimit/entrypoint" \
  -H "$H" -H 'content-type: application/json' -d "$RL" | jq '{success, errors}'   # 期待: {"success": true, "errors": []}
```

期待と違うとき: `errors` に `cf.colo.id` に関する文言が出る → Free プランで `characteristics` が足りない。上の 2 つが両方要る。`period` / `mitigation_timeout` は Free では 10 固定。

確認はサイト作成前でも実行できる。`/v1/sites/*` は 404 を返すが、404 もカウントされる。本番しきい値での確認は下の並列送信で行う。間隔が長すぎると 10 秒の期間をまたいで永遠に遮断されないので、連続で送る:

```bash
# 50 並列で 30 秒以内に LIMIT を超える。429 が 1 つでも出れば有効
END=$((SECONDS+30)); HIT=0
while [ $SECONDS -lt $END ]; do
  seq 1 50 | xargs -P 50 -I{} curl -sS -o /dev/null -w '%{http_code}\n' "https://$HOST/v1/sites/probe/decision" | grep -q '^429$' && { HIT=1; break; }
done
echo "hit=$HIT"   # 期待: hit=1
```

期待と違うとき:

- hit=1 → 有効。10 秒待って `curl -sS -o /dev/null -w '%{http_code}\n' "https://$HOST/v1/sites/probe/decision"` が 404 に戻ることを確認。既定の構成では binding(1000、2.3)が WAF(200)より大きく、WAF が先に止めるので、この確認で出る 429 は WAF の遮断
- hit=0 かつ API の読み戻し(上の entrypoint GET)にルールが無い → 作成に失敗している
- hit=0 かつルールはある → 判定不能(反映待ち・検出遅延・送信量不足)。1 分後に再実行し、それでも hit=0 なら人に報告する

edge の設定での `CF_TOKEN` の用は 2.7 までで終わる(control か管理画面を自分のドメインに置くなら、7.1・4.2 の空きの確認でも使う)。期限切れで無効になるので、失効の操作は要らない。`deploy-secrets.env` は 3.3 / 3.4 でも使うので、消すのは 5 節の後。

#### 代替: ダッシュボードで作る

1. ダッシュボード → 対象ゾーン → Security(セキュリティ)→ Security rules(セキュリティ ルール)→ Create rule(ルールを作成)→ Rate limiting rules(レート制限ルール)。Free プランでも 1 ルール使える。既に別のレート制限ルールを使っていると枠が無いので、先に確認する
2. 条件: `URI Path starts with /v1/sites/` または `URI Path starts with /__ab/`。Edit expression(式を編集)で書くなら `(starts_with(http.request.uri.path, "/v1/sites/")) or (starts_with(http.request.uri.path, "/__ab/"))` で、2.7 の API と同じ式
3. 同一 IP から一定回数を超えたら Block。値は下の「しきい値の指針」を見る

#### 確認と指針(API・ダッシュボード共通)

**しきい値の指針(NAT 合算に注意)**: Free プランのカウント単位は IP だけ。企業オフィスのように多数の人が 1 つの送信元 IP(NAT)を共有する環境では、全員分が合算される。IP 単位の制限で止められるのは 1 か所からの大量送信だけで、分散した送信元は止められない。そのため、しきい値は攻撃をどこまで絞るかではなく、1 つの IP の後ろにいる正常な訪問者を何人まで通すかで決める。

規模ごとの目安(`edge_waf_requests_per_10s`):

| 規模 | 回 / 10 秒 | 1 つの IP の後ろで同時に閲覧していても通る人数の目安 | あわせて行うこと |
|---|---|---|---|
| 既定(小〜中規模) | 200 | 約 300 人 | なし |
| 企業からの訪問が多い BtoB、中〜大規模 | 500 | 約 750 人 | 自社オフィスなど既知の送信元を式で除外する(ゾーンが Business 以上のとき。下の箇条)。binding はこの除外を引き継がないので、除外した送信元からの合計が binding の上限を超えうるなら binding も上げる(2.3) |
| 大規模 | 1000 | 約 1500 人 | ゾーンが Business 以上なら、数える単位を IP with NAT support にする。Pro 以上なら、期間を 60 秒にして回数を 6 倍(6000)にする。短い一斉アクセスは通し、続く大量送信は止められる。binding は NAT 支援を引き継がず IP ごとの合計で数えるので、1 つの IP からの合計が binding の上限を超えうるなら binding も上げる。期間を 60 秒にしたときの binding の値は 2.3 の規則で 6000 になる |
| 1000 でも当たる | 上げない | — | そのサイトを `/v1/*` を呼ばない構成にできないかを先に検討する。履歴の条件・割当の固定(`persistAssignment`)・結果の記録のどれも使わなければ、タグは `/v1/*` に何も送らない |

IP with NAT support は Cloudflare の画面の名前で、日本語の表示は未確認。

人数の目安の前提: `needsProfile` のサイトでは 1 PV で decision 1 回と event 約 1 回を送り、閲覧中の人は 30 秒に 1 PV 程度とした(1 人あたり 10 秒に約 0.7 回)。これは結果を記録しないサイトの値。結果を記録するサイトでは、テストの参加(参加したテストごとに 1 回)と目標の達成の送信が足される。送信済みの印をブラウザに保存できれば同じ訪問者 × テスト(目標)には 1 回だけで、続けて閲覧している間は増えないが、保存できない環境(`localStorage` が使えないなど)ではページごとに送り直す。1 テスト・1 目標のページを初めて開くと 1 PV で 4 回程度になり、テストや目標が多いページではさらに増える。多くの人が同時に初めて開く場面(朝礼で同じページを案内するなど)では目安より少ない人数で当たるので、表の人数をそのまま当てはめない。

上限に触れてもブロックされるのは `/v1/*` だけで、ページ本体・GTM・bootstrap は無傷。ただし decision が 429 を受けた runtime は再試行せず元の表示に戻るため、エクスペリエンスは適用されず Exposure も出ない。目標の `ab_conversion` は `dataLayer` に push され GA4 に届くが、`needsProfile` のサイトの `/event` 転送(Profile の `converted` 履歴の更新)は失われる。その組織の露出だけが欠ける。429 を受けたページでは、タグが `dataLayer` に `ab_error`(`ab_error_type: "rate_limited"`)を 1 回 push するので、GA4 に送れば遮断の起きた回数を数えられる。ただし edge をページと別のドメインに置く構成(`custom-domain`)では、WAF の遮断の応答をタグが読めず、通信の失敗として扱うので数えられない。edge の binding の 429 は数えられる([運用ガイド 7 節](operations.md#429-が訪問者に与える影響))。

- 値は Free でも `requests_per_period` で変えられる。変えたら、binding の値が 2.3 の規則の値以上かを確かめる(下回っていれば 2.3 の規則の値に上げる)
- 自社オフィスなど既知の送信元は、式に `and not ip.src in { <IP> }` を足して除外できる。公開の直後に社内から何度も開いて確かめるなど、自分たちの確認作業が遮断されないようにするために使う。レート制限ルールの式で送信元の IP を使えるのは、ゾーンが Business 以上のとき(Free の式で使えるのは URI Path など)。除外は WAF だけに適用され、edge の binding はその送信元も 1 つの IP からの合計で数える。除外した送信元からの合計が binding の上限(既定 1000 回 / 10 秒)を超えうるなら、binding をその合計まで上げる(2.3)
- `needsProfile: false`(履歴の条件も割当の固定も使わない)のサイトは decision を送らない。`/event` も、結果を記録しないサイトなら送らないので、この上限に触れない。結果を記録するサイトは、テストの参加(訪問者 × テストで初回)と目標の達成(訪問者 × 目標で初回)を `/event` に送る(ページビューごとではない)
- プランごとの違い: Free は 1 本・期間 10 秒・IP 単位だけ。Pro は 2 本・期間 1 分まで。Business は 5 本・期間 10 分まで・IP with NAT support も使える。Cookie・ヘッダー単位で数えられるのは Enterprise だけ

429 は本文で判別する。`error code: 1015` は Cloudflare の遮断で、上の確認が検出するのはこの遮断。edge の binding が返す平文の 429 `rate limited` とは、本文で区別する。

**遮断を見る**: しきい値が合っているかは、遮断が起きたかを見て判断する。上限に触れても訪問者には何も表示されないので、見に行かないと気づけない。ダッシュボード → 対象ゾーン → Security(セキュリティ)→ Analytics → Events のタブで、Cloudflare が遮断した要求を見られる(Security Events。Analytics・Events・Sampled logs の日本語の表示は未確認)。ゾーンを選んだ状態で `https://dash.cloudflare.com/?to=/:account/:zone/security/analytics` を開いても同じ画面に着く。

- Free で見られるのは Sampled logs(遮断の記録の抜き出し)だけ。行を開くと、送信元の IP・時刻・当たったルールが分かる。IP ごとの回数の集計とグラフは Pro 以上で出る
- 記録は過去 31 日分
- 同じ IP の遮断が繰り返し出ていたら、その IP の後ろにいる訪問者の数を見積もり、上の目安で値を見直す

**しきい値の限界(Free プラン)**:

- このルールは IP 単位なので、1 台の機械からの送信を 10 秒あたり `LIMIT` 回に抑えるだけで、1 日の送信量は抑えない
- `needsProfile` のサイトでは、新しい visitorId 1 つにつき Durable Object の書き込みが 2 行ずつ増える。Free プランの日次の上限(10 万行)は約 5 万件で尽きる。既定の 200 回 / 10 秒(20 回 / 秒)では、1 つの IP からでも約 42 分で達する
- 尽きた日は decision / event が止まり、訪問者には元の表示が出る。ページ本体・設置タグは無傷
- Free プランではこれが上限で、分散した送信元を止める手段は無い。アクセスの多いサイトや標的にされる可能性のあるサイトは、Workers Paid(日次の上限が無く従量)にするか、`needsProfile` を使わない構成にする。この構成は decision を送らないので Durable Object に触れない

あわせて使用量の監視も行う。Cloudflare の課金通知は上位プラン限定で、Workers / Durable Objects 専用の指標も無い。そのため Free では、ダッシュボード → Compute(コンピュート)→ Workers & Pages → `wtt-edge` → Metrics(メトリクス)と、Compute(コンピュート)→ Durable Objects の Requests / Storage を週 1 回目視する。

### 2.8 ドメインありへの移行(`workers-dev` → `route`)

`*.workers.dev` で始めた導入を、設置サイトのゾーンの Route に移す手順。Worker・KV・Durable Objects・サイト設定(タグを置くドメインの一覧を含む)は引き続き使える。変わるのは edge と設置タグの公開 origin(設置タグを配る `wtt-static` の置き場所を含む)だけ。

`*.workers.dev` で始めた導入を、サイトとは別のドメイン(別のドメインに置く構成)に移す手順は、まだ用意していない。

1. 設置ホストが Cloudflare のゾーンにありプロキシ有効であることを確認する(1 節)
2. `apps/edge/wrangler.jsonc` に 2.3 の `routes` と `"dev": { "host": "localhost" }` を足す。`workers_dev` は**まだ消さない**(旧 URL のタグを読むページが残っている間は両方で受ける)。`pnpm -C apps/edge exec wrangler deploy`
3. 2.6 の Cache Rule と 2.7 の WAF Rate Limiting Rule を作る
4. 配信専用の Worker `wtt-static` に設置サイトのゾーンの Route を足す。`workers.dev` は**まだ切らない**(旧 URL のタグを読むページが残っている間は両方で受ける): `pnpm -C apps/deployer setup-static -- --route "<設置ホスト>/s/*" --zone "<ゾーン名>"`(2.9 の (3) の環境変数が要る。期待: `script: exists (kept)` / `route <設置ホスト>/s/*: created`)
5. control の `AB_EDGE_ORIGIN` を `https://<設置ホスト>` に変え、`AB_STATIC_ORIGIN` を消して再デプロイする(3.4、3.5)
6. `AB_EDGE_ORIGIN` を変えたら、公開中の全サイトの配信ファイルを作り直す。配信ファイルに API の宛先が書き込まれているため。管理画面の左メニューの下の「設定」→「配信ファイル」(「システム」の見出しの下。システム管理者だけに出る)で「公開中の全サイトの配信ファイルを作り直す」を押す。エージェントは、サイトごとの `POST /sites/<siteId>/static/redeploy` を公開中のサイトの数だけ呼ぶ(全サイトの作り直しは API キーでは呼べない)
7. 設置サイトの全ページのタグ `src` を `https://<設置ホスト>/s/<siteId>.js` に差し替える([サイト導入ガイド 3 節](site-install.md#3-タグを置く))。サイトの CSP に edge と `wtt-static` の旧ホストを足していたなら外す
8. 旧 URL へのアクセスが無くなったことを確認してから(9 節 (b) の指標、または Workers のログで `workers.dev` ホストへの要求が 0 になってから数日)、edge の `workers_dev` を `false` にして再デプロイし、`wtt-static` の workers.dev も切る。完了の確認は `wrangler deploy` の出力: `Deployed wtt-edge triggers` に Route だけが並び、`https://wtt-edge.<アカウントのサブドメイン>.workers.dev` の行が**無い**こと

```bash
pnpm -C apps/edge exec wrangler deploy   # 期待: triggers に workers.dev の URL が出ない
pnpm -C apps/deployer setup-static -- --workers-dev off   # 期待: script: exists (kept) / workers.dev: off
```

(旧 URL への curl の期待値は書かない。無効化後の HTTP 応答は Cloudflare が保証していない。)

### 2.9 設置タグの配信(配信専用の Worker とデプロイ専用の Worker)

仕組み:

- 設置タグのファイル(`/s/<siteId>.js`)は、配信専用の Worker `wtt-static` の静的アセットとして配る。訪問者の読み込みは Worker を起動しないので、Workers のリクエストの上限に数えられない
- ファイルは公開・サイト設定の保存のたびに、デプロイ専用の Worker `wtt-deployer` が作り直して `wtt-static` に入れる(control が依頼する。失敗したら間隔をあけて再試行する)
- デプロイ用のトークンを持つのは `wtt-deployer` だけで、インターネットからは届かない
- **`wtt-static` には `wrangler deploy` を使わない**(手元のファイルで全サイトの配信ファイルが置き換わって消える)

(1) `apps/deployer/wrangler.jsonc` の `vars.CF_ACCOUNT_ID` を導入先の Account ID(0.4 で確かめたもの)にする。確認: `grep -c 00000000000000000000000000000000 apps/deployer/wrangler.jsonc || true` が `0`(雛形の値が残っていない)。

(2) デプロイ用トークンを secret に入れて `wtt-deployer` をデプロイする(2.1 の `pnpm runtime:build` の後。値は画面に出さず、パイプで直接入力する):

```bash
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
pnpm -C apps/deployer exec wrangler deploy
if [ -n "$CF_DEPLOY_TOKEN" ]; then printf '%s' "$CF_DEPLOY_TOKEN" | pnpm -C apps/deployer exec wrangler secret put CF_DEPLOY_TOKEN; else echo "CF_DEPLOY_TOKEN is empty: load deploy-secrets.env (0.5)"; fi
pnpm -C apps/deployer exec wrangler secret list | jq -r '.[].name'   # 期待: CF_DEPLOY_TOKEN
```

(3) 配信専用の Worker を作り、公開する(`route` の構成)。手元で 1 回だけ行う。`wrangler login` の資格情報を使う:

```bash
export CLOUDFLARE_API_TOKEN=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
export CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-<0.4 で確かめた Account ID>}
pnpm -C apps/deployer setup-static -- --route "<設置ホスト>/s/*" --zone "<ゾーン名>" --workers-dev off
# 期待: script: created / route <設置ホスト>/s/*: created / workers.dev: off
```

`workers-dev` の構成(ゾーンを持たない): `pnpm -C apps/deployer setup-static -- --workers-dev on`(期待: `script: created` / `workers.dev: on`)。公開アドレスは `https://wtt-static.<アカウントのサブドメイン>.workers.dev` で、3.4 の `AB_STATIC_ORIGIN` に書く。設置タグの `src` もこのホストになる。

`custom-domain` の構成(別のドメインに置く): **2.4 の edge の deploy の後に行う**。Route を張るホストの DNS レコードは、edge の Custom Domain が作るため。環境変数は上のブロックと同じで、コマンドは `pnpm -C apps/deployer setup-static -- --route "<edge のホスト>/s/*" --zone "<ゾーン名>" --workers-dev off`(期待: `script: created` / `route <edge のホスト>/s/*: created` / `workers.dev: off`)。設置タグと edge が同じホストなので、3.4 の `AB_STATIC_ORIGIN` は書かない。設置タグの `src` は `https://<edge のホスト>/s/<siteId>.js` になる。

期待と違うとき:

- `route … : moved from <名前>` が出たら、そのパターンのルートが別の Worker に向いていた。前の構成(設置タグを edge が配っていた導入)から移すときは期待どおり。そうでなければ人に確認する
- `script: exists (kept)` なら既に作ってある(中身のファイルは消さない)。続けてよい
- `zone not found` は `<ゾーン名>` と 0.5 の確認(`CF_TOKEN` のゾーンの範囲)を見直す

(4) 確認(ファイルは最初の公開のあとに入る。ここでは、プレビュー用のファイルと 404 だけを見る):

```bash
HASH=$(grep -o 'PREVIEW_HASH = "[0-9a-f]*"' packages/runtime/generated/source.ts | grep -o '"[0-9a-f]*"' | tr -d '"')
curl -sS -o /dev/null -w '%{http_code}\n' "https://<設置タグのホスト>/s/preview/$HASH.js"   # 期待: 200
curl -sS -o /dev/null -w '%{http_code}\n' "https://<設置タグのホスト>/s/nosuch.js"           # 期待: 404(存在しないサイト)
```

`<設置タグのホスト>` は、`route` の構成では `<設置ホスト>`、`custom-domain` の構成では `<edge のホスト>`、`workers-dev` の構成では `wtt-static.<アカウントのサブドメイン>.workers.dev`。

補足:

- **`wtt-deployer`(またはその Durable Object)を消して作り直したとき**: どのサイトの配信ファイルがあるかの記録が失われる。このまま別のサイトを公開すると、記録にあるサイトだけで配信ファイルが置き換わり、ほかのサイトのファイルが消える。作り直したら、公開の前に、管理画面の左メニューの下の「設定」→「配信ファイル」(「システム」の見出しの下)で「公開中の全サイトの配信ファイルを作り直す」を押す(システム管理者が管理画面から行う。全サイトの作り直しは API キーでは呼べない。エージェントは、サイトごとの `POST /sites/<siteId>/static/redeploy` を公開中のサイトの数だけ呼ぶ)。押し忘れても、control の 15 分ごとの定期処理が、記録に無い公開中のサイトを見つけて作り直しを頼む(それまでに別のサイトを公開すると、ほかのサイトの配信ファイルは一度消え、定期処理の後に戻る)。ただし定期処理が 1 回に頼むのは 25 サイトまでなので、公開中のサイトが 25 を超えると、全サイトが戻るまで 15 分ごとに 25 サイトずつ進み、その間は一部のサイトの配信ファイルが 404 になることがある。だから作り直したらすぐ押す

## 3. control のデプロイ

**control のデプロイより前に 2.4 と 2.9 を済ませる**(control は `wtt-deployer` への binding と、edge の Durable Object `ResultsBudget`・`ResultsHealth` への binding を持つ。`wtt-deployer` と、この 2 つを含む edge が無いとデプロイできない)。

### 3.1 D1

```bash
pnpm -C apps/control exec wrangler d1 create wtt-control </dev/null   # 2.2 と同じく、設定ファイルへの追記は非対話なので行わない
```

出力される `database_id` を `apps/control/wrangler.jsonc` の `d1_databases[0].database_id` に反映する(ローカル / vitest は wrangler のローカル D1 を使うので値は問われない)。設定ファイルへの追記の問いは 2.2 と同じく **No**。

ここで作るのは設定用の `wtt-control` だけ。計測用のデータベース `wtt-results` は 2.2 で作り、`d1_databases[1]`(`RESULTS_DB`)に書いてある。

確認:

```bash
grep -n '"database_id"' apps/control/wrangler.jsonc   # 期待: 2 行(wtt-control の行がここで作成したもの、wtt-results の行が 2.2 で作成したもの)
grep -c 00000000-0000-0000-0000-000000000000 apps/control/wrangler.jsonc || true   # 期待: 0(仮の ID が残っていない)
pnpm -C apps/control exec wrangler d1 list --json | jq -r '.[] | select(.name == "wtt-control") | .uuid'
```

期待と違うとき: `already exists` と出る → 前回の作業の D1 が残っている。`d1 list --json` の uuid を書く。

### 3.2 R2 と公開ドメイン

`asset_public_base` で分かれる。

**`none`(R2 を使わない)のとき**: ここから先は飛ばし、`apps/control/wrangler.jsonc` の `r2_buckets` の行を削除する。3.4 の `AB_ASSET_PUBLIC_BASE` も書かない。

- R2 の有効化(支払い方法の登録)は不要になり、control は画像アップロード・画像の一覧と IMAGE の変更を無効にして動く。画像の差し替えは ATTRIBUTE の `src` で行う。管理画面は左メニューの「画像」と IMAGE の選択肢を出さない
- 後から R2 を使い始める(`none` → あり): R2 を有効化 → 下の「R2 を使うとき」のとおりバケットを作り `r2_buckets` と `AB_ASSET_PUBLIC_BASE` を戻す → 3.5 の再デプロイ。既存のエクスペリエンスには影響しない
- あり → `none` の切り替えはサポートしない。IMAGE の変更を含むエクスペリエンスを archive してから `r2_buckets` と `AB_ASSET_PUBLIC_BASE` を外す。残った IMAGE の変更の保存は 422 になる
- `GET /capabilities`(認証要)の `imageUpload` で、どちらの構成で動いているかを確認できる

確認(`none` のとき):

```bash
grep -c '"binding": "ASSETS"' apps/control/wrangler.jsonc   # 期待: 0
```

**R2 を使うとき**: 次の順に行う。(1) R2 の有効化(人)→ (2) バケットの作成 → (3) 公開ベースの決定(カスタムドメインか `dev-assets`)→ (4) 確認。

(1) **【人に依頼】** R2 はアカウントで一度ダッシュボードから有効化する。

- 画面: 左のメニュー Storage & databases(ストレージとデータベース)→ R2 Object Storage(R2 オブジェクトストレージ)
- まだ有効でなければ Get started with R2(R2 で始めましょう)の画面が出るので、Add R2 subscription to my account(R2 サブスクリプションをアカウントに追加する)を押す
- 支払い方法の登録を求められることがある。有効化しても無料枠内なら請求は発生しない

(2) バケットを作る。設定ファイルへの追記の問いには、2.2 と同じく No と答える:

```bash
pnpm -C apps/control exec wrangler r2 bucket create wtt-assets </dev/null   # 2.2 と同じく、設定ファイルへの追記は非対話なので行わない
```

期待と違うとき: `Please enable R2 through the Cloudflare Dashboard. [code: 10042]` で失敗する → R2 が有効化されていない。(1) を人に頼んでから再実行する。

(3) 公開ベースを決める。`asset_public_base` の値を変えずに 3.4 の `AB_ASSET_PUBLIC_BASE` に使う。

- **本番ではカスタムドメインを勧める**。カスタムドメインなら、訪問者と管理画面は R2 から直接画像を読み、Worker は動かない(Cloudflare のキャッシュも使われる)。`dev-assets` は、R2 にドメインを接続できない間の暫定と、手元の開発のためのもの
- `dev-assets` を選んだ場合: 実値は `<control URL>/dev-assets`。control URL は 3.5 の初回 deploy で分かる。control 自身が R2 を読んで画像を返すので、アップロードと IMAGE の変更は動作する。ただし、訪問者のページと管理画面の画像の一覧で画像を 1 枚表示するたびに control が 1 回動き、Workers Free の 1 日のリクエスト数(アカウント全体で 10 万)を edge・管理画面と分け合う。Cloudflare のキャッシュも使われない(ブラウザのキャッシュだけ)。訪問者の多いサイトで IMAGE の変更を配信すると、この枠を先に使い切るおそれがある。R2 直配信より遅くもなる
- `dev-assets` からカスタムドメインに変えるなら、**画像を使い始める前に**変える。`AB_ASSET_PUBLIC_BASE` をカスタムドメインに変えると `GET /dev-assets/*` は自動的に閉じ、それまでに上げた画像の URL(`…/dev-assets/sites/…`)は読めなくなる。画像の一覧の URL・保存済みの変更・公開した設定の URL は書き換わらないので、前の画像は一覧でも表示されなくなり、その画像を使うパターンでは画像を上げ直して選び直すことになる
- カスタムドメイン(例 `assets.<運用者ドメイン>`)を選んだ場合: 下のコマンドでバケットに接続し、`vars.AB_ASSET_PUBLIC_BASE` をその URL にして再デプロイする。DNS レコードと証明書は Cloudflare が作る。ドメインのゾーンが同じアカウントにあること。権限で拒否されたときだけ人に頼む(下の「期待と違うとき」):

```bash
ZID=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=<ゾーン名>" -H "Authorization: Bearer $(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)" | jq -r '.result[0].id')
pnpm -C apps/control exec wrangler r2 bucket domain add wtt-assets --domain <assets.example.com> --zone-id "$ZID" --min-tls 1.2 --force
pnpm -C apps/control exec wrangler r2 bucket domain list wtt-assets   # 期待: 上のドメインが一覧に出る(有効になるまで数分かかることがある)
curl -sS -o /dev/null -w '%{http_code}\n' "https://<assets.example.com>/"   # 期待: 404(バケットに届いている)
```

期待と違うとき:

- 最後の確認が `000` / `5xx`、または `403` で、`domain list` の `ownership_status` か `ssl_status` が `pending` → 接続の反映待ち。接続の直後は 403 が返ることがある。30 秒おきに `domain list` と最後の確認をやり直す。5 分たっても `pending` のままなら、作業を中断して人に報告する
- どちらも `active` になった後も 403 → 反映待ちではない。応答の本文(`curl -sS "https://<assets.example.com>/"`)と `domain list` の出力を `deploy-log.md` に残す。ドメインとバケット名の設定を確かめてから人に報告する
- `domain add` がゾーンの所有を理由に失敗する(zone が見つからない / 別アカウント)→ そのドメインのゾーンが同じアカウントに無い。`dev-assets` に切り替えるか、ゾーンを持つアカウントに導入する
- `domain add` が権限を理由に失敗する → **【人に依頼】** ダッシュボードで同じドメインを接続してもらい、`domain list` の確認から再開する。この失敗は、`wrangler login` の資格情報で DNS の書き込みが拒否される場合で、実サイトでは未検証
  - 画面: Storage & databases(ストレージとデータベース)→ R2 Object Storage(R2 オブジェクトストレージ)のバケットの一覧で `wtt-assets` → Settings(設定)タブ → Custom Domains(カスタム ドメイン)の Add(追加)。Status(ステータス)が Active(アクティブ)になれば接続済み
  - 接続するまでは `AB_ASSET_PUBLIC_BASE` を `<control URL>/dev-assets` にしておけば、アップロードと IMAGE の変更は動作する

(4) 確認。`r2_buckets` が 1 件だけであることも見る:

```bash
pnpm -C apps/control exec wrangler r2 bucket info wtt-assets   # 期待: 終了コード 0、出力に name: wtt-assets を含む
grep -c '"binding": "ASSETS"' apps/control/wrangler.jsonc   # 期待: 1
```

**画像の一覧の縮小版(Cloudflare Images)**: 管理画面の画像の一覧に出す縮小画像(幅 320px の WebP)は、Cloudflare Images の変換で control が作る。`apps/control/wrangler.jsonc` には `"images": { "binding": "IMAGES" }` の行が最初から入っていて、書き換えは要らない。

- Cloudflare の Free のプランでも変換を使える。無料で使えるのは月 5,000 種類の変換まで。超えた月は新しい変換が断られ、課金はされない。その月の残りは縮小版が作られず、一覧には元の画像を出す。翌月の最初の定期処理から、作り待ちの縮小版を作り始める
- ダッシュボードで有効にする操作は要らない見込み。ダッシュボードの Images の画面にある Hosted images(ホストされた画像)は、画像を Cloudflare に保存して配る別の機能で、サブスクリプションが要るが、この製品は使わない。ゾーンの変換の設定(Transformations(変換)の画面でゾーンごとに有効にする設定)が binding からの変換に要るかは、公式の文書から確定できていない。導入の後に縮小版ができるかで確かめる(5 節の確認 4)
- 使った数は、Images の Transformations(変換)の画面の使用量の「ユニークな変換」で見られる(この欄の英語の表示は未確認)
- 縮小版を作らないなら、`images` の行を消して 3.5 の再デプロイをする。一覧は元の画像を縮小せずに出す(画像が多いと一覧の表示が重くなる)。後から行を戻したときは、運用ガイドの画像の節の手順で、それまでに上げた画像を縮小版の作り待ちに戻す
- R2 を使わない導入(`none`)では、この行があっても何もしない(消さなくてよい)

### 3.3 secrets

```bash
# 32 バイト以上のランダム文字列。Better Auth のセッション署名鍵
openssl rand -hex 32 | pnpm -C apps/control exec wrangler secret put BETTER_AUTH_SECRET

# 初回セットアップ専用の使い捨てトークン AB_SETUP_TOKEN は 5 節で生成・登録・使用・削除を 1 つのブロックで行う(ここでは置かない)

# 0.5 で受け取った Google のクライアント シークレット(クライアント ID のほうは 3.4 の vars)
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
if [ -n "$GOOGLE_CLIENT_SECRET" ]; then printf '%s' "$GOOGLE_CLIENT_SECRET" | pnpm -C apps/control exec wrangler secret put AB_GOOGLE_CLIENT_SECRET; else echo "GOOGLE_CLIENT_SECRET is empty: load deploy-secrets.env (0.5)"; fi

# 管理画面の使用状況の表示用(0.5 の (4) で受け取った Account Analytics: Read のみのトークン)
if [ -n "$CF_USAGE_TOKEN" ]; then printf '%s' "$CF_USAGE_TOKEN" | pnpm -C apps/control exec wrangler secret put CF_USAGE_TOKEN; else echo "CF_USAGE_TOKEN is empty: load deploy-secrets.env (0.5)"; fi
```

補足:

- 管理画面のログインは Google アカウントで行う。OAuth クライアント(ID・シークレット・リダイレクト URI)は 0.5 で人に作ってもらったものを使う。0.5 でサブドメインが取れずリダイレクト URI の登録を後回しにした場合は、3.5 の初回 deploy で URL が分かった時点で登録してもらう
- `AB_BREAK_GLASS_TOKEN` は普段は置かない(Google でログインできなくなったときだけ置く。8 節)
- エージェントが実行する場合: `BETTER_AUTH_SECRET` は画面に出さない(上のようにパイプで直接入力する)。`CF_USAGE_TOKEN` の値も画面やログに出さない
- secret は書込み専用で後から読めない。控え忘れたら新しい値で `secret put` し直す
- **秘密情報はリポジトリに置かない。** 上記はすべて `wrangler secret put`(Cloudflare 側に保存)で行い、ローカル用の `.dev.vars` と `apps/admin/.env.local` は git 管理外にする。コミットするのはテンプレート(`.dev.vars.example` / `apps/admin/.env.example`)だけで、実際の値は書かない

確認:

```bash
pnpm -C apps/control exec wrangler secret list | jq -r '.[].name' | sort   # 期待: AB_GOOGLE_CLIENT_SECRET と BETTER_AUTH_SECRET と CF_USAGE_TOKEN(AB_SETUP_TOKEN は 5 節で作る)
```

### 3.4 vars(`apps/control/wrangler.jsonc`)

必須 5 つ(R2 なしは 4 つ)+ edge の origin 1 つ(+ ドメインなし構成の設置タグの origin 1 つ):

| キー | 内容 |
|---|---|
| `AB_ADMIN_URL` | ← `admin_address`(`workers-dev` なら `https://wtt-admin.<アカウントのサブドメイン>.workers.dev`。サブドメインは 0.5 の API で取ったもの。`custom` なら `https://<admin_host>`)。管理画面の公開 URL。招待リンクとパスワードリセットリンクの先頭、Google ログイン後の戻り先、Better Auth の `trustedOrigins` になる |
| `AB_CONTROL_URL` | ← `control_address`(`workers-dev` なら初回 deploy の出力の URL、`custom` なら `https://<control_host>`)。control 自身の公開 URL。Better Auth の `baseURL` に使われ、`trustedOrigins`(= `AB_ADMIN_URL`)との整合が要る。workers.dev のまま使う場合の値は `https://wtt-control.<アカウントのサブドメイン>.workers.dev`。サブドメインは 0.5 の API で取ったもの(または初回 `wrangler deploy` の出力)。0.5 で確定した URL と一致すること |
| `AB_ASSET_PUBLIC_BASE` | ← `asset_public_base`(URL なら変えずに、`dev-assets` なら `<control URL>/dev-assets`)。画像の公開ベース URL。R2 のカスタムドメイン、または暫定で `<control URL>/dev-assets`(3.2)。**`asset_public_base: none` では書かない**(binding が無いので無視される。binding があるのに空だと画像は無効として扱われる) |
| `AB_ASSET_MAX_MB` | ← `asset_max_mb`。アップロード 1 件の上限(MB)の文字列 |
| `AB_ASSET_SITE_MAX_MB` | 任意。1 サイトの画像の合計の上限(MB)の文字列。書かなければ `"1024"`。超えるアップロードは 409 `asset_quota_exceeded` になる。削除待ちの画像も、消えるまで数える。縮小版は数えない |
| `AB_ASSET_SITE_MAX_COUNT` | 任意。1 サイトの画像の枚数の上限の文字列。書かなければ `"1000"`。超えたときは上と同じ。約 1,200 より大きくすると、同じ名前(`hero.png`・`hero (2).png` のような番号違いを含む)の画像が約 1,200 枚を超えたサイトでは、その名前のアップロードが 409 `asset_name_taken` になる(空いている番号を探す回数に上限があるため。別の名前を付ければ上がる) |
| `AB_GOOGLE_CLIENT_ID` | 0.5 で受け取った Google の OAuth クライアント ID(`deploy-secrets.env` の `GOOGLE_CLIENT_ID`)。秘密ではない(クライアント シークレットのほうは secret に置く)。この値か `AB_GOOGLE_CLIENT_SECRET` が欠けていると Google ログインは 503 になり、代わりにパスワードで入れるようにはならない(8 節) |

edge の公開 origin(必ず書く):

| キー | 内容 |
|---|---|
| `AB_EDGE_ORIGIN` | ← `edge_address`。decision / event を受ける edge の公開 origin。`route` なら `https://<設置ホスト>`、`custom-domain` なら `https://<edge のホスト>`(`edge_host`)、`workers-dev` なら 2.4 の出力の `https://wtt-edge.<アカウントのサブドメイン>.workers.dev`。管理画面がこの値で構成(workers.dev かどうか)を判定し、設置タグのファイルに API(decision / event)の宛先として書き込む。変えたら公開中の全サイトの配信ファイルを作り直す(2.8 の手順 6) |
| `AB_STATIC_ORIGIN` | **`workers-dev`(ゾーンなし)のときだけ書く**。`route` と `custom-domain` では書かない(設置タグと edge が同じホスト)。設置タグを配る配信専用の Worker の origin(`https://wtt-static.<アカウントのサブドメイン>.workers.dev`。2.9)。省略すると `AB_EDGE_ORIGIN` と同じホストとして扱う。管理画面の導入タグの `src` のホストになる |

使用状況の表示(3.3 の `CF_USAGE_TOKEN` と対。どちらかが欠けていれば使用状況は「未設定」と表示され、ほかの機能には影響しない):

| キー | 内容 |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare のアカウント ID(32 桁の 16 進。`pnpm -C apps/control exec wrangler whoami` の Account ID) |
| `AB_USAGE_RESOURCES` | 内訳に出す本製品のリソース。`wrangler.jsonc` には文字列ではなく **JSON のオブジェクト**として書く。雛形は `d1` と `kv` が空の配列なので、本製品の D1 と KV を足す: `"d1": [{ "id": "<3.1 の database_id>", "name": "wtt-control" }, { "id": "<2.2 の計測用のデータベースの database_id>", "name": "wtt-results" }]`、`"kv": [{ "id": "<2.2 の KV の id>", "name": "CONFIG_KV" }]`(`workers` は既定で `["wtt-edge", "wtt-control", "wtt-admin"]`)。設置タグを配る `wtt-static` と、デプロイ専用の `wtt-deployer`(2.9)も内訳に出すなら、その名前も `workers` に足す。`d1` が空のまま、または書いた ID がどのデータベースとも一致しないと、D1 の 1 データベースあたりの上限は「判定していません」と表示される。`wtt-results` も書くのは、テストの結果の記録で大きくなるデータベースの容量を上限(Free は 1 データベース 500 MB)と比べるため |

**`wrangler.jsonc` の `vars` は本番値を置く場所。** ローカル開発・テストは次の 3 か所で localhost 値に上書きする: `wrangler dev` は `apps/control/.dev.vars`(`.dev.vars.example` を写す)、vitest は `apps/control/vitest.config.ts` の `miniflare.bindings`、admin の E2E は `apps/admin/playwright.config.ts` の control 起動コマンドの `--var`。

### 3.5 マイグレーションとデプロイ

```bash
pnpm -C apps/control d1:migrate:remote
pnpm -C apps/control exec wrangler deploy
```

deploy の回数:

- 0.5 でサブドメインを取れていれば、3.4 の `AB_CONTROL_URL` / `AB_ADMIN_URL` / `AB_ASSET_PUBLIC_BASE` は deploy 前に実値で書けるので deploy は 1 回
- 取れなかった場合だけ「1 回デプロイ → 出力の URL で 3.4 を書く → 再デプロイ」の 2 回になる
- カスタムドメイン(7.1)に置くなら、先に 7.1 を済ませてから 3.4 を書く。`control_address: custom` の場合、`AB_CONTROL_URL` に使う URL は `https://<control_host>`(deploy の出力に workers.dev の URL も出るが使わない)

Cron と edge への binding:

- control は 15 分ごとの Cron Trigger(`*/15 * * * *`。`apps/control/wrangler.jsonc` の `triggers`)を 1 本持つ。Cron Trigger の数にはアカウントごとの上限がある(Free は 5 本)。この製品が使うのは、デプロイ専用の Worker の毎時の 1 本(6.4)と合わせて 2 本。deploy の出力の triggers に `schedule: */15 * * * *` が出る
- この Cron は、使用状況の表示と同じ値(3.3 の `CF_USAGE_TOKEN`・3.4 の `CF_ACCOUNT_ID`)でアカウント全体の使用量を見る。Free で Workers のリクエストか D1 の書き込みの行数が日次上限の 8 割に届いたら、結果の記録を次の UTC 0 時まで止める(配信と管理操作に残りを残すため)。UTC 0 時の直後の回(00:00 の回)は見ない(日が替わった直後は当日の使用量がまだ少なく、使用状況の取得も失敗しやすいため)。使用状況の設定が無いとき・取得に失敗したときは何もしない。Paid では判定しない
- 同じ Cron が、テストの結果の記録の作業も行う: 15 分ごとに、公開した設定が訪問者に配られたことの確認・記録の締め切り(評価時点)の書き直し・計測用のデータベースの容量の測定(95% 以上なら記録を止める)。UTC 0 時を過ぎた後に 1 日 1 回、目標参加者数に届いたことの確認と、評価時点の結果の記録の作成。UTC 23 時台に 1 回、保持期間を過ぎた参加者ごとの記録と、エクスペリエンス・サイトの削除で残った記録の削除(その日の書き込みの予算の残りの範囲で。大きなテストは数日かかる)。1 回の実行で使うデータベースの問い合わせの数に上限があり、終わらなかった分は次の実行で続ける
- control は edge の Durable Object `ResultsBudget`(結果の記録の予算)と `ResultsHealth`(収集できなかった送信の数)を参照する(Worker をまたぐ binding)。そのため edge(2.4)を先にデプロイする。control だけを先にデプロイすると失敗する。更新(6.3)でも edge を先にデプロイする
- control は計測用のデータベース(`RESULTS_DB`。2.2 で `database_id` を書いた)を、結果の集計の読み取りと、保持期限・エクスペリエンスやサイトの削除に伴う記録の削除にだけ使う。表を作るのは edge の `results:migrate:remote` で、control の `d1:migrate:remote` は `wtt-control` だけに当たる

deploy の出力の URL が、0.5 で確定した control の URL(= Google に登録したリダイレクト URI の元)と一致することを確認する。違っていれば(0.5 でサブドメインが取れなかった場合を含む)**【人に依頼】** `<AB_CONTROL_URL>/auth/callback/google` を承認済みのリダイレクト URI に登録し直してもらう。後で control の URL を変えたときも同じ。

確認:

```bash
# control の URL は上の deploy の出力(https://wtt-control.<アカウントのサブドメイン>.workers.dev)から拾う
curl -sS "<control URL>/llms.txt" -o /dev/null -w '%{http_code}\n'   # 期待: 200(認証不要のガイド本文。control に /healthz は無い)
```

期待と違うとき:

- deploy の直後(特に、0.5 で作ったばかりのサブドメインへの初回 deploy)に 404 や本文 `error code: 1042` が返る → 公開の反映待ち(数十秒)。**30 秒待ってから同じ確認をやり直す**。2 回目も同じなら、deploy の出力に `https://wtt-control.<サブドメイン>.workers.dev` の行があるかを確かめる(無ければ 0.5 のサブドメインの作成と、`wrangler.jsonc` に `workers_dev: false` が入っていないかを見る)
- `d1:migrate:remote` が `✅ No migrations to apply` 以外の失敗で止まる → 3.1 の `database_id` を疑う
- `wrangler deploy` が `wtt-edge`・`ResultsBudget`・`ResultsHealth` のどれかを含むエラーで失敗する → edge がまだデプロイされていないか、この 2 つを含まない古い edge のまま。2.4(更新では 6.3 の手順 1)で edge をデプロイしてからやり直す

### 3.6 公開アドレス

control は `*.workers.dev` のままでも動く(ゾーンのキャッシュや Route に頼らない API で、認証は Bearer トークンと API キーなので、URL がどこにあっても機能は変わらない)。ただし `AB_CONTROL_URL` と admin 側の設定は必ず一致させる。

カスタムドメインを使う場合:

1. 7.1 のとおり `apps/control/wrangler.jsonc` を書き換えて(`routes` に加えて `workers_dev` / `preview_urls` を `false` にする)再デプロイする
2. control 側の `AB_CONTROL_URL`(と `AB_ASSET_PUBLIC_BASE` が control URL を含むならそれ)と、admin 側 `apps/admin/wrangler.jsonc` の `vars.AB_CONTROL_URL` もその URL に合わせて更新・再デプロイする(7 節)
3. `AB_ADMIN_URL` は管理画面の実際の URL(4.2)のままにする。Better Auth の `trustedOrigins` に使われるため、control の URL にすると admin の認証 Origin が一致しなくなる

## 4. admin のデプロイ

管理画面は control とは別の Worker(`wtt-admin`)として Cloudflare Workers に置く。Next.js を Vite で動かす vinext を使い、ビルドが `dist/` 配下に生成設定(`wrangler.json`。デプロイ用の設定)と `dist/client`(静的ファイル)を出す。

- 運用者の PC でのローカル実行は開発用(`pnpm admin:dev`)で、導入の選択肢ではない。招待やリセットのリンクが `localhost` を指して複数人で使えないため
- 管理画面と control はそれぞれ自分の版を名乗る。更新の後も古い管理画面を開いたままの人がいると、その画面からの保存は control が `426 client_too_old` で断る(古い画面が新しい control に書き込む食い違いを防ぐため)。管理画面の上部に帯が出るので、ページを再読み込みすれば直る。帯の種類は[運用ガイド 6 節](operations.md#6-ロールと管理操作)
- admin は control を **service binding**(`apps/admin/wrangler.jsonc` の `services`。宛先は control の `ControlBff`)で呼ぶ。同じ Cloudflare アカウントの Worker 同士を、公開 URL を経由せずに内部の接続でつなぐ仕組みで、管理画面を操作した人の IP を control に渡すために使う(control のログインの回数の制限が、利用者ごとに分かれる)。**binding は同じ Cloudflare アカウントの Worker しか指せないので、admin と control は同じアカウントに置く**(この文書の手順は 1 つのアカウントに置く形)。binding の宛先が要るので、control を先にデプロイしてから admin をデプロイする

### 4.1 vars(`apps/admin/wrangler.jsonc`)

| キー | 内容 |
|---|---|
| `AB_CONTROL_URL` | 3.5 で確認した control の公開 URL。control 側の `vars.AB_CONTROL_URL` と同じ値にする(違うと sign-in 後に 401 になる)。binding がある構成でも書く(Google のログインでブラウザを control へ送る先と、`services` の binding を外した場合(この文書の手順には無い)に呼ぶ先に使う) |

`services` の binding(`CONTROL` → `wtt-control` の `ControlBff`)はリポジトリの `apps/admin/wrangler.jsonc` に書いてあり、書き換えない。control の Worker 名を `wtt-control` から変えていなければそのまま使える。

`apps/admin/.env.local` は `pnpm admin:dev`(開発)専用で、デプロイには使われない。

### 4.2 公開アドレス(`admin_address`)

- `workers-dev`(既定): `apps/admin/wrangler.jsonc` は何も書き換えない。URL は `https://wtt-admin.<アカウントのサブドメイン>.workers.dev`(サブドメインは control と同じ)。以下の `custom` の手順は行わない
- `custom`: 自分のドメインに置く(DNS レコードと証明書は wrangler が作る。ゾーンが Cloudflare にあること)

自分のドメインに置く利点: 招待・リセットリンクが `https://admin.<運用者ドメイン>/...` になる / ゾーンの WAF と Cloudflare Access(4.5)を掛けられる。後から `workers-dev` → `custom` に切り替えるときも、下の (0) の確認(作業用のトークンを作り直す。0.5 の最後の段落)と (1) の編集をして admin を再デプロイ → 3.4 の `AB_ADMIN_URL` を新 URL にして control を再デプロイすればよい(ユーザー・API キー・公開履歴は引き続き使える)。

**`custom` のとき**(ここから 4.3 の前までは `custom` を選んだ場合だけ。`workers-dev` なら 4.3 へ):

**(0) 先に、`<admin_host>` が空いていることを API で確かめる。** 非対話で実行した `wrangler deploy` は、Custom Domain を作るときに、同じ名前の既存の DNS レコードと、ほかの Worker への割り当てを確認なしに上書きするため(2.3 の `custom-domain` のときと同じ確認)。既にこのホストに管理画面を置いていて、デプロイし直すだけのときは行わない(自分の割り当てがあるので `n` が 1 になる)。

```bash
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
HOST=<admin_host>               # 例 admin.example.com
ZONE=<そのホストのゾーン名>      # 0.5 の 2 で確かめたゾーン(例 example.com)
T=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
AID=${CLOUDFLARE_ACCOUNT_ID:-$(pnpm -C apps/control exec wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}
ZID=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=$ZONE" -H "Authorization: Bearer $CF_TOKEN" | jq -r '.result[0].id')
echo "ZID=$ZID"   # 期待: 32 桁の ID(null なら、ZONE の名前が違うか、CF_TOKEN の対象のゾーンに入っていない)

# 1. 同じ名前の DNS レコードが無い(CF_TOKEN の DNS Read を使う)
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?name=$HOST" -H "Authorization: Bearer $CF_TOKEN" | jq '{ok: .success, n: (.result | length)}'   # 期待: {"ok": true, "n": 0}
# 2. ほかの Worker の Custom Domain に使われていない(wrangler login の資格情報を使う)
curl -sS "https://api.cloudflare.com/client/v4/accounts/$AID/workers/domains?hostname=$HOST" -H "Authorization: Bearer $T" | jq '{ok: .success, n: (.result | length)}'   # 期待: {"ok": true, "n": 0}
```

期待と違うとき:

- `ok` が `true` でない・権限のエラーが出る・jq がエラーになる(応答が JSON でない)→ 空いているとはみなさず、作業を中断して人に聞く。1 の権限のエラーは、`CF_TOKEN` に Zone → DNS → Read が無いときに出る。`ZID` が null のときは、`ZONE` の名前が違うか、`ZONE` が `CF_TOKEN` の対象のゾーンに入っていない(0.5 の 2)
- `n` が 1 以上 → そのホストは使われている。別のホストにする(`admin_host` を変える)か、使っていないことを人に確かめてから人に消してもらう。消した後に、このブロックをやり直す

**(1) `apps/admin/wrangler.jsonc` を編集する。** `workers_dev` と `dev` は**既存の行を置き換え**、`preview_urls` と `routes` は**足す**(同じキーを二重に書くと後ろの行が勝ち、`host: localhost` が失われる)。

```jsonc
"workers_dev": false,
"preview_urls": false,
"routes": [{ "pattern": "<admin_host>", "custom_domain": true }],
"dev": { "port": 3000, "host": "localhost" }
```

`workers_dev` / `preview_urls` を false にしないと `https://wtt-admin.<アカウントのサブドメイン>.workers.dev` と Preview URL が残り、Access / WAF を迂回できる。

**(2) ゾーン側で「Always Use HTTPS」を有効にする**(http で開くとセッション Cookie に `Secure` が付かない)。管理画面は https では `__Host-` で始まる名前の Cookie だけを使い、同じドメインの別のホストから置かれた同じ名前の Cookie を受け付けない。この保護も Always Use HTTPS が前提で、無効だと、管理画面を http で開かせて、今の名前(`__Host-` の無い名前)の Cookie を使わせることができる。

**同じドメインに置くときの注意**: 管理画面を設置サイトと同じドメインの下(例 `admin.example.com` と `www.example.com`)に置くと、ブラウザは両者を同じサイトとして扱い、別のホストのページからの要求にもログインの Cookie を付ける。管理画面は、別のオリジンからの書き込みの要求・枠(iframe)への埋め込み・同じ名前の Cookie の持ち込みを断るが、同じドメインの下に、他の人が内容を置けるホスト(利用者が作るページ、外部のサービスに任せたサブドメイン、使わなくなったのに DNS レコードが残ったホスト)があるなら、管理画面はそれと別のドメインに置くか、`workers-dev` のままにする。`workers-dev` でも、ブラウザは同じアカウントの `*.<アカウントのサブドメイン>.workers.dev` のホスト同士を同じサイトとして扱う(別のアカウントのホストとは別のサイト)。同じアカウントの別の Worker で他の人が内容を出せるなら、同じ注意が当たる。

**(3) デプロイ(4.3)の後に、workers.dev 側が閉じたことを確認する:**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://wtt-admin.<アカウントのサブドメイン>.workers.dev/login"   # 期待: 404 か接続失敗(workers.dev が閉じている)
```

### 4.3 デプロイ

```bash
pnpm -C apps/admin build      # vinext build。dist/ 配下に生成設定(wrangler.json)と dist/client を出す
pnpm -C apps/admin deploy:cf  # wrangler deploy --config <ビルドが出した生成設定>
```

deploy の出力に `https://wtt-admin.<アカウントのサブドメイン>.workers.dev` が出る。`custom` のときは `https://<admin_host>` を使う。出力の bindings の一覧に `env.CONTROL (wtt-control#ControlBff)` が出ていれば、control への service binding が設定されている。

### 4.4 確認

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "<AB_ADMIN_URL>/setup"                 # 期待: 200(画面が出る)
curl -sS -w '\n%{http_code}\n' "<AB_ADMIN_URL>/api/control/me"                     # 期待: {"error":"unauthorized",...} と 401(admin → control が通っている)
```

期待と違うとき:

- `/setup` が 404 → `routes` か Worker 名が違う。`pnpm -C apps/admin exec wrangler deployments list --config <ビルドが出した生成設定>` で確認
- deploy の直後に `/setup` か `/api/control/me` が 404、または本文が `error code: 1042` → 3.5 と同じく公開の反映待ちのことがある。**30 秒待ってから同じ確認をやり直す**(この応答は JSON ではないので `jq` で処理しない)。2 回目も同じなら次の 2 つを見る
- `/api/control/me` が 404 か、本文に `error code: 1042` → `services` の binding を外した構成で、admin の `compatibility_flags` に `global_fetch_strictly_public` が無い(binding が無いときは公開 URL で control を呼ぶので、同じアカウントの Worker 同士の fetch に要る)。`apps/admin/wrangler.jsonc` を確認して再デプロイする
- `/api/control/me` が 502(`control_unreachable`)か、JSON でない 5xx → admin から control に届いていない。binding がある構成では、control が未デプロイか、`ControlBff` を持たない古い版の control が動いている(control をデプロイしてから admin をデプロイし直す)。binding が無い構成では、4.1 の `AB_CONTROL_URL` の値のミスか control が未デプロイ
- ログイン後に 401 → control の `AB_ADMIN_URL`(3.4)と実際の admin の URL が違う(`trustedOrigins` 不一致)

### 4.5 任意: Cloudflare Access で管理画面の到達を絞る

既定では掛けない。**実機検証は未実施。**

- 掛け方: `admin_address: custom` にしたうえで、Zero Trust(Free で 50 ユーザーまで)の Access アプリケーション(Self-hosted)を `<admin_host>` に作り、許可するメールドメインや IP を決める
- 管理画面はブラウザから人が開くだけなので、control(7.3)と違ってサービストークンは要らない
- Access が適用されるのは admin の入口だけ。control の無認証入口(`/auth/*`、`/login-options`、`/break-glass/reset-link`、`/setup`、`/invitations/:id/accept`、API キー経路。一覧は 7 節)には適用されない

ログインを Google アカウントにしても、Access には残る利点がある: 管理画面のプログラム自体に穴があっても Worker が動く前で止まる / 許可するメールドメイン・IP・デバイスなどの組織の方針をまとめて掛けられ、到達の記録も残る / 非常用のパスワード経路を開けているあいだ(8 節)の防御になる。引き換えに、Access のログインと管理画面のログインで二重にログインすることになる。

## 5. 初回セットアップ

オーナーと最初のワークスペースの登録はエージェントが API で行い、人は Google でログインするだけ。ここで登録したオーナーはシステム管理者になる。システム管理者はこの導入全体の管理者で、新しいワークスペースを作れるのはシステム管理者だけ。運用を始めたら、もう 1 人をシステム管理者にしておく(運用ガイド 6 節)。

ここで行うこと: (1) `POST /setup` → (2) 人が Google でログイン → (3) `AB_SETUP_TOKEN` の削除 → サイトを作る → スモーク → 任意で 5.1。

1. エージェントが使い捨てトークンを作って登録し、続けて `POST /setup` を送る
   - 送る値は入力ファイルの `owner_email` / `workspace_name` / `usage_visibility`。`usage_visibility` が入力ファイルに無ければ `members` を入れる。空文字のまま送ると 422 になる
   - `owner_email` は、ログインに使う Google アカウントと同じもの。パスワードは無い
   - トークンはこのブロックの中だけで使い、画面にも `deploy-log.md` にも出さない
   - 1 つのシェルで続けて実行し、生成と使用を分けない。エージェントの実行環境は、コマンドごとにシェルが変わることがあるため

```bash
SETUP_TOKEN=$(openssl rand -hex 16) \
&& printf '%s' "$SETUP_TOKEN" | pnpm -C apps/control exec wrangler secret put AB_SETUP_TOKEN \
&& sleep 10 \
&& curl -sS -X POST "<control URL>/setup" -H "X-Setup-Token: $SETUP_TOKEN" -H 'content-type: application/json' \
     -d '{"email":"<owner_email>","workspaceName":"<workspace_name>","usageVisibility":"<usage_visibility>"}' -w '\n%{http_code}\n'   # 期待: {"workspaceId":"…","userId":"…"} と 201
```

期待と違うとき:

- 403 `setup_closed` → 原因は 2 つ: (a) 既にオーナーがいる(再実行のとき)/ (b) `AB_SETUP_TOKEN` が一致しない(`secret put` の反映前に送った、または別の値が残っている)
  - 初回導入で 403 が返ったら、まず (b) として扱う。secret の反映を 30 秒待ってから、上のブロックをもう一度、変更せずに実行する。新しい値で登録し直して送ることになる
  - それでも 403 なら (a) = 登録済みなので手順 2 へ進む。人が Google でログインできれば確定する
  - 直前に 503 が返っていた場合は下の 503 の項に従う
- 422 → `owner_email` の形式か `workspace_name` の長さ(1〜100 文字)、または `usage_visibility` が `members` / `instance_admins` 以外。入力ファイルを直して再実行
- 429 → 10 秒待って再実行(無認証入口は IP 単位で 30 回 / 10 秒)
- 503 `setup_failed` → ワークスペースの作成に失敗。60 秒待ってから上のブロックをもう一度、変更せずに実行する。途中の状態は、60 秒たつと次の実行が片付ける。60 秒以内に再実行すると 403 `setup_closed` が返ることがある。その 403 は上の (a) ではないので、60 秒待ってからやり直す
- 400 → JSON の形。上のコマンドの引用符を確認

2. **【人が行う】** `<AB_ADMIN_URL>/login`(4.3 で確認した admin の URL)を開き、「Google でログイン」から `owner_email` の Google アカウントでログインする。管理画面(`/w`)が開いたらエージェントに「ログインできた」と伝える
3. エージェントが `AB_SETUP_TOKEN` を削除する。以後はユーザーを招待リンク経由でしか増やせなくなる。手順 1 で 403 (a) だった場合も、secret が残っていれば消す:

```bash
pnpm -C apps/control exec wrangler secret delete AB_SETUP_TOKEN
curl -sS "<control URL>/login-options"   # 期待: {"google":true,"passwordLogin":false}
```

期待と違うとき:

- `secret delete` が確認を求める → 人が端末で実行する場合は `y` を入れる。エージェントの非対話実行では自動で進む
- `google` が false → 3.3 / 3.4 の Google の設定が届いていない
- `passwordLogin` が true → 非常用のトークンが残っている(8 節)

セットアップはユーザーが 1 件でもあれば拒否される。削除を忘れても実害は小さい。ただしユーザーが増えるまでの間は、トークンを知る全員がオーナーを名乗れてしまうので早めに消す。ログインまで確認できたら `rm deploy-secrets.env` も行う(0.5)。

**サイトを作る**: 管理画面でワークスペースの配下にサイトを作る。ワークスペースはセットアップで 1 つ作られている。作成画面の項目は[サイト導入ガイド 2 節](site-install.md#2-サイトを作る)を参照。サイト ID とパターン ID は作成後に変更できない。

入力ファイルに `extra_hosts`(タグを置くページのほかのホスト)があるときは、Mode A でも Mode B でも、サイトを作った後に、左メニューの下の「設定」→「サイト設定」の「ドメイン」の節の「タグを置くドメイン」に、`extra_hosts` のホストをすべて足して保存する(作成の画面で入れられるのは 1 つ目だけのため)。ゾーンの中のホストも外のホストも足す。Mode B では、`dlite_hosts` に入っている(Route を作った)ホストの札が `Cloudflare 経由(edge が応答しました)` になる。ゾーンの外のホストの札が `Cloudflare 外(edge が応答しません)` になるのは期待どおりで、誤りではない。そのホストは Cloudflare 外のドメインとして、Mode A と同じ動きで動く(テストと目標は動き、Safari では ID が弱い)

`dlite_hosts` があるときは、サイトを作るときに次のとおりにする([サイト導入ガイド 8 節](site-install.md#mode-bサーバー発行-cookie)):

- `タグを置くドメイン(1 つ目)` に `install_host` を入れる(`install_host` が `dlite_hosts` に無いときは、`dlite_hosts` のホストを入れる)
- `導入の形` を `B: サーバー発行 Cookie(同じゾーンの Workers Route。サイトが Cloudflare 配下のとき)` にする。作成画面の既定は Mode A なので、選ばないと Safari 対策が有効にならない
- Mode B で作ると、作成のときに、入れたドメインで edge が応答するか(Cloudflare 経由か)を control が確かめる。作った後、左メニューの下の「設定」→「サイト設定」の「ドメイン」の節で、そのドメインの行の札が `Cloudflare 経由(edge が応答しました)` になったことを確かめる
- ほかのホストにもタグを置くときは、同じ「ドメイン」の節の「タグを置くドメイン」に足して保存する。保存のたびに、一覧のドメインごとに確かめ直す

期待と違うとき:

- `dlite_hosts` のホストの札が `Cloudflare 外(edge が応答しません)` → そのホストに `/__ab/*` の Route が無いか、まだ edge に届いていない(2.3)。Route を足してから、ドメインの節でもう一度保存すると確かめ直す
- 札が `確かめられませんでした` → 確認の要求が 403・429・5xx を受けたか、時間切れになった。そのドメインは前回の判定のまま(初めてなら Cloudflare 外として動く)。サイトのゾーンの WAF(2.7 のレート制限ルールや、ほかの遮断のルール)が、control からの確認の要求を止めていることがある。2.7 の「遮断を見る」と同じ、ゾーンの Security(セキュリティ)→ Analytics → Events のタブ(Analytics・Events の日本語の表示は未確認)で、`/__ab/ping` への要求が止められていないかを見る。止められていたら、その要求を止めないようにルールを直してから、もう一度保存する

**スモーク**(**【人が行う】** 管理画面の操作): サイトを作る → エクスペリエンスを作る → 開始(成功すると自動で公開される)→ 下の確認 → 終了。エージェントは確認コマンドを用意する。

`<設置タグのホスト>` は 2.9 の (4) のとおり。`route` は設置ホスト、`custom-domain` は edge のホスト、`workers-dev` は `wtt-static.<アカウントのサブドメイン>.workers.dev`。`workers-dev` では Cache Rule の確認(`cf-cache-status`)は飛ばす。

確認 1(配信の経路): 先頭付近に config のバージョンと作成したエクスペリエンス ID が含まれていれば、control → デプロイ専用の Worker → 配信専用の Worker の経路が動作している。

```bash
curl -s https://<設置タグのホスト>/s/<siteId>.js | head -c 400
```

確認 2(2.6 の Cache Rule。作った場合): `cache-control: public, max-age=60` なら OK。判定は 2.6 の「確認」を見る。

```bash
curl -sSI "https://<設置タグのホスト>/s/<siteId>.js" | grep -iE 'cache-control|cf-cache-status'
```

確認 3(配信専用の Worker のヘッダー): 設置タグのファイルで 200 を得た後に `curl -sSI "https://<設置タグのホスト>/s/<siteId>.js" | grep -i x-content-type-options` が `nosniff` を返すこと。これが配信専用の Worker が付けたヘッダーの証拠になる。

確認 4(画像。`asset_public_base` が `none` 以外のときだけ): 管理画面から画像を 1 枚アップロードし、応答の URL を取得して 200 を確認する。`dev-assets` なら URL は `<control URL>/dev-assets/...`。

- **【人が行う】** アップロードの入口は、サイトの左メニューの「画像」。右上の「画像をアップロード」でファイルを選ぶ(画面にファイルをドラッグ&ドロップしてもよい)。上がった画像を一覧で押すと右に詳細が出て、公開 URL をコピーできる
- 人にはその URL をチャットに貼ってもらう(秘密ではない)
- 縮小版(3.2 の「画像の一覧の縮小版」)の確かめ: アップロードの直後か、遅くとも 15 分ごとの定期処理で作られる。15 分ほど後に下の 2 つ目のコマンドで `ready` の行があれば、縮小版ができている。`pending` のまま残る・`failed` が出るときは、運用ガイド 10 節の手順で control の Workers Logs を開き、`asset-housekeeping` の行を見る。縮小版ができなくても、一覧は元の画像で動き、ほかの機能にも影響しない
- 拡張子と中身の形式が違う画像(中身が JPEG の `.png` など)は 415 で拒否される。そのときは別の画像で試す

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "<アップロード応答の URL>"   # 期待: 200
pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --json --command "select thumb_state, count(*) as n from assets group by thumb_state" | jq -c '.[0].results'   # 期待: thumb_state が ready の行がある(images の行を消した導入では skipped)
```

期待と違うとき:

- 設置タグのファイルが 404 → 公開がまだか、配信ファイルの更新が済んでいない。管理画面のサイトの上部に、警告と「配信ファイルを作り直す」が出ていないかを見る。公開の結果の `staticDeploy` が `pending` なら再試行中。いくつものサイトで 404 になるときは、管理画面の左メニューの下の「設定」→「配信ファイル」(「システム」の見出しの下)で状態を見て、「公開中の全サイトの配信ファイルを作り直す」を押す(エージェントは、サイトごとの `POST /sites/<siteId>/static/redeploy` を公開中のサイトの数だけ呼ぶ)。`wtt-deployer` が失敗しているなら、secret `CF_DEPLOY_TOKEN` と `apps/deployer/wrangler.jsonc` の `CF_ACCOUNT_ID`(2.9)を確かめる。判定や計測の送信が 404 のときは、KV の id が edge / control で違う(2.2)
- `max-age=14400` など → Cache Rule が適用されていない(2.6 の確認)
- `cf-cache-status: DYNAMIC` のまま → 配信専用の Worker の Route が適用されていない(2.9 の (3)・(4))
- `cf-cache-status` が出ない(workers-dev)→ 正常。この構成ではゾーンのキャッシュが無い

**終了**: 確認できたらエクスペリエンスを終了(archived)する。

- **【人が行う】** エクスペリエンスの画面の右上の「終了(元に戻せません)」を押し、確認のモーダルで「終了する」を押す。「一時停止」とは別のボタン。成功すると、画面の上部の状態の行が「状態: 終了 / 本番: 終了」になる。終了も自動公開されるので追加操作は不要
- 人から「終了した」と聞いたら、エージェントが読み取りで確かめる:

```bash
pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --json --command "select id, status, published_status from experiments where site_id = '<siteId>'" | jq -c '.[0].results'   # 期待: スモークのエクスペリエンスが status = archived、published_status = archived
```

期待と違うとき: `running` や `paused` のまま → 終了の操作が完了していない。モーダルで取り消した、一時停止を押した、などが考えられる。画面の状態の行を見てもらい、上の操作をもう一度頼む。

**`plan: paid` のとき**(【人が行う】。スモークのついでに): 管理画面の左メニューの下の「設定」→「Cloudflare 使用状況」で、プランを Workers Paid にする。使用状況の比べ方が、Free の 1 日の上限から、月の含まれる量の目安に変わる。

**新しい版の知らせ**(【人が行う】): 導入が終わったら、[6.0](#60-新しい版に気づく) のとおり、新しい版の公開を受け取れるようにしておく。自動更新は無く、脆弱性を直した版も知らせを受けないと気づけない。

### 5.1 エージェント向けの設定(推奨・任意)

導入が終わったら、続けて AI エージェントから control を操作できるようにしておく。方式は REST + API キーで、詳しくは[エージェント向けガイド](agent-guide.md)にある。人に次の 1 問で聞く。答えは 3 の有効期限で使う:

- 「導入の後も、AI エージェントにエクスペリエンスの作成などの操作をさせますか。(a) 続けて任せる / (b) この会話の作業の間だけ / (c) しない」
- (c) なら、5.1 を飛ばす

1. エージェントが[エージェント向けガイド 1.1 節](agent-guide.md#11-鍵の範囲と権限を決める必要なら専用ユーザーも)のロールの表を要約して見せ、鍵の権限と範囲を選んでもらう
   - 権限の既定は編集者。下書きまでエージェントが作り、公開は人が管理画面で行う
   - 範囲の既定は、操作するワークスペースを 1 つ選ぶ。漏れたときの被害がそのワークスペースに留まる。すべてのワークスペースを横断して操作させたいときだけ「すべてのワークスペース」(API の値は `full`)にする。これはシステム管理者だけが発行できる
2. エージェントがリポジトリ直下に `.env.agent`(git 管理外)を作る。値は空の行を残し、人が貼る:

```bash
[ -e .env.agent ] || (umask 077 && printf 'AB_CONTROL_URL=%s\nAB_API_KEY=\n' '<control URL>' > .env.agent)   # 既にあれば上書きしない(貼った鍵を消さない)
chmod 600 .env.agent   # 所有者だけが読める権限にする(前からあるファイルにも効かせる)
```

3. **【人が行う】** 管理画面の左メニューの下の「設定」→「API キー」の「新しい API キーを発行」で、名前と 1 で選んだ範囲・権限と、有効期限を指定して発行する
   - 表示された鍵を `.env.agent` の `AB_API_KEY=` の右に貼る。開き方は 0.5 の `deploy-secrets.env` と同じ。鍵は `wtt_` で始まり、発行の直後に 1 回だけ表示される。控えたら「保管したので閉じる」を押す
   - 鍵はチャットにも、エージェントの画面から実行するコマンドにも書かない。会話の記録に残る(0 節の「API キーの受け渡し」)
   - 有効期限は、5.1 の初めの問いの答えで決め、エージェントが依頼のときに伝える。(a) 続けて任せる → 90 日など。期限が来たら発行し直す。(b) この会話の作業の間だけ → 1 日。期限切れで自然に無効になり、失効の操作が要らない。期限なしの鍵は、漏れたときに失効させるまで使われ続ける。選んだ期限は最後の報告の「残る鍵」に書く
4. エージェントが鍵を確かめる。値は表示しない:

```bash
set -a; eval "$(tr -d '\r' < .env.agent)"; set +a
curl -sS "$AB_CONTROL_URL/me" -H "Authorization: Bearer $AB_API_KEY" | jq '{email, roleCap, keyScope, keyWorkspaceId}'   # 期待: owner_email と、1 で選んだ権限(小文字。「本人と同じ」を選んだなら null)と範囲(workspace とその ID /「すべてのワークスペース」なら full と null)
```

5. 以後の使い方として、エージェント向けガイドの「レシピ」を案内する。レシピは、エクスペリエンスを作って公開まで / 下書きの検証 / 結果を読む / 配信条件の what-if / オーディエンス / 使用状況の監視 / 複製。鍵が漏れたときは、同じ画面か「メンバーの API キー」画面で失効させる

## 6. 更新(リリースタグ単位)

更新は `git pull` ではなく **tag から tag へ** 行う。流れ: 6.0 新しい版に気づく → 6.1 現在と目標の確認 → 6.2 取得 → 6.3 凍結を入れてデプロイ → 6.4 確認して凍結を外す。戻すときは 6.5。

**edge → deployer → control → admin の順にデプロイする。** 理由: core の共有スキーマ(`SiteSettingsSchema` / `CompiledConfigSchema`)は `z.strictObject` で未知フィールドを拒否するため、逆順にすると古い edge が新しい形式の record を parse できず、当該サイトの decision / event が 404(fail-closed)になる。deployer も同じスキーマで検証してから設置タグのファイルを作るので、control より先に更新する。control は edge の Durable Object(`ResultsBudget`・`ResultsHealth`)を参照するので、この点でも edge が先になる。

### 6.0 新しい版に気づく

自動更新の仕組みは無く、新しい版が出ても導入先には何も届かない。導入が終わったら、次のどちらかで新しい版の公開を受け取れるようにしておく(【人が行う】)。

- **GitHub の通知**: 公開リポジトリ(https://github.com/AnalyticsDesign/ab-test-and-target-harness)の画面の右上の **Watch** → **Custom** で **Releases** にチェックを入れ、**Apply** を押す(GitHub の画面は英語の表示だけを書いている)。新しい版の Release が出るたびに、GitHub の通知(設定によってはメール)が届く
- **フィード**: GitHub のアカウントを使わない場合や、社内のチャットに流したい場合は、Releases のフィード `https://github.com/AnalyticsDesign/ab-test-and-target-harness/releases.atom` を RSS リーダーやチャットの RSS 連携に登録する

届いたら、Release の本文(`CHANGELOG.md` のその版の節と同じ)を読む。版の節の先頭に **「セキュリティの修正」** の項がある版は、脆弱性を直した版で、深刻度・影響する版・更新しない場合の緩和策が書いてある。影響する版を使っているなら、ほかの版より先に、早めに入れ替える。修正は最新のリリースに対して出すので、古い版向けの修正版は無い。

### 6.1 現在と目標の確認

**先に導入先のアカウントを固定する**: `pnpm -C apps/control exec wrangler whoami` にアカウントが 2 つ以上出るなら、導入先を人に 1 問で選んでもらい、`export CLOUDFLARE_ACCOUNT_ID=<導入先>` を以後のすべてのシェルで設定する(0.4 と同じ)。更新は別の会話で始まるので、導入時に固定した値は残っていない。wrangler は非対話のとき導入先を選べず、6.3 の export と deploy が止まる。

```bash
git describe --tags --exact-match          # 現在の tag(例 v0.9)。出ない場合は 0.3 のとおり tag を checkout していない
git checkout -- packages/runtime/generated/source.ts apps/control/src/generated/agent-guide.ts   # 生成物のローカル差分を捨てる(6.3 の runtime:build / guide:build で作り直す)
git status --short                         # 期待: 差分は apps/edge/wrangler.jsonc / apps/control/wrangler.jsonc / apps/admin/wrangler.jsonc / apps/deployer/wrangler.jsonc の 4 ファイルだけ(M が 4 行。deployer は 2.9 で `CF_ACCOUNT_ID` を書いた分)。それ以外に差分があれば人に報告して止まる
git fetch --tags origin
git tag --list 'v*' --sort=-v:refname | head -3   # 目標の tag(例 v1.0)
```

更新手順は、目標 tag の文書(`git show <目標 tag>:docs/deploy.md` の 6 節)に従う。古い版の 6 節は古い手順のことがある。

`git show <目標 tag>:CHANGELOG.md` で現在 tag と目標 tag の間の項目を読み、次の 3 つがあるか確認する。6.3・6.4 では (a)(b)(c) として参照する:

- (a) **マイグレーション**(`apps/control/migrations` か、計測用のデータベースの `apps/edge/results-migrations` の追加)
- (b) **サイト設定のフィールド追加**(既存サイトの record を書き直す必要)
- (c) **runtime の変更**

CHANGELOG に次の目印があるリリースは、6.3 の該当する項も読む: 「配る設定の版(`schemaVersion`)が上がる」「計測用のデータベースを足す」「レート制限の既定値が変わる」。パスワードでログインしていた版からの更新も 6.3 に項がある。「レート制限の既定値が変わる」は 6.2 の衝突の項も読む。

### 6.2 取得

`wrangler.jsonc` の id・routes・vars と、edge の `ratelimits` の `limit` はローカルで編集した値なので、tag を切り替えても失わないように退避する。

```bash
# 退避の対象は「今 checkout している版に存在する設定ファイル」だけにする。存在しないパスを
# git stash push -- に渡すと pathspec did not match で失敗するため。
# git ls-files -z + xargs -0 で渡すので bash / zsh のどちらでも同じ結果になる
# (4 つの設定ファイルは必ず追跡されているので、一覧が空になることはない。deployer は `CF_ACCOUNT_ID` を 2.9 で書いた分が退避の対象)
git ls-files -z apps/edge/wrangler.jsonc apps/control/wrangler.jsonc apps/admin/wrangler.jsonc apps/deployer/wrangler.jsonc | xargs -0 git status --short --   # 変更されている設定ファイル
CHANGED=$(git ls-files -z apps/edge/wrangler.jsonc apps/control/wrangler.jsonc apps/admin/wrangler.jsonc apps/deployer/wrangler.jsonc | xargs -0 git status --short -- | wc -l)
if [ "$CHANGED" -gt 0 ]; then git ls-files -z apps/edge/wrangler.jsonc apps/control/wrangler.jsonc apps/admin/wrangler.jsonc apps/deployer/wrangler.jsonc | xargs -0 git stash push -m "wtt-deploy-config" --; fi
git checkout v1.0                          # 目標 tag に読み替える
if [ "$CHANGED" -gt 0 ]; then
  S=$(git stash list | grep -m1 'wtt-deploy-config' | cut -d: -f1)   # 期待: stash@{0}
  git stash apply "$S" && git stash drop "$S"
fi
git status --short                         # 期待: 4 ファイル
git describe --tags --exact-match          # 期待: 目標 tag
pnpm install
```

期待と違うとき:

- 差分なし(初回導入で `wrangler.jsonc` を編集していない = 通常あり得ない)→ stash を作らずに進む
- apply で衝突 → 両方の変更を見て id・routes・vars・`ratelimits` の `limit` を残し、`git stash drop "$S"` を手で行う。解消後は `grep -n '<<<<<<<' apps/*/wrangler.jsonc` が空であることを確認し、`git restore --staged apps/edge/wrangler.jsonc apps/control/wrangler.jsonc apps/admin/wrangler.jsonc apps/deployer/wrangler.jsonc`(存在するものだけを並べる)で index を戻す(`git status --short` が ` M` の行だけになる)。計測用のデータベースを足すリリースでは `apps/control/wrangler.jsonc` の `d1_databases` で衝突することがある(解き方は 6.3 の該当の節の手順 3)
  - レート制限の既定値が変わる版(CHANGELOG の目印)への更新では、`apps/edge/wrangler.jsonc` の KV の id の行から `ratelimits` の行までの 3 行が 1 回衝突する。KV の id は手元の値にし、その下のコメントと `ratelimits` の行は新しい版の形にして、`limit` は 2.3 の規則で書く。Route などほかの行は自動で戻る
  - ゾーンの WAF があるかは、`deploy-answers.yaml` の `edge_address`・`edge_waf_rate_limit` で見る。ファイルが無ければ 2.7 の GET で確かめる。見るのはルールの有無ではなく、式に `/v1/sites/` を含むルールがあるか(既存の別のルールがあるだけでは WAF があるとは言えない。別のルールがあるために「作らない」を選んだ導入があるため)。そのためのトークンも無ければ人に聞く。更新は別の会話で始まるので、導入時の答えが手元に残っていないことがある
- `git stash list` に `wtt-deploy-config` が残っている → 前回の更新の取りこぼし。中身を確認して drop
- `git checkout` が `Your local changes to the following files would be overwritten` で失敗 → 表示されたファイルの差分を確認し、生成物なら `git checkout -- <file>` で捨て、設定ファイルなら stash の対象に加えてから 6.2 をやり直す(失敗したまま先に進まない。`git describe --tags --exact-match` が目標 tag でなければここに戻る)

### 6.3 デプロイ(順序を守る)

**更新の間は書き込みを凍結する**: 下の手順 0 の前に、6.6 のコマンドで凍結を入れる(理由の例: `v1.0 への更新`)。1 分待って、凍結が有効になったことを確かめる。手順 4(admin)の後、6.4 の読み取りの確認が済んだら外す。外す位置は 6.4 の中に書いてある。凍結中に止まるのは管理画面と API の変更操作だけで、訪問者への配信は止まらない。

**凍結の仕組みが入る前の版から更新するとき(この 1 回だけ)**: 動いている control に凍結の仕組みがあるかは、`curl -sSI "<control URL>/llms.txt" | grep -i x-wtt-api-version` で確かめられる。行が出れば入っている。出なければ、この 1 回に当たる。

- 更新前の control は凍結の行を読まず、データベースに凍結の表がまだ無いこともある。そのため 6.6 のコマンドは失敗するか、有効にならない。6.6 の「有効になったか確かめる」も使えない
- 代わりに、手順 0 の前に管理画面の利用者とエージェントに書き込みを止めてもらい、進行中の操作が終わってから手順 0 に進む
- 6.4 の読み取りの確認が成功し、admin の deploy を終えるまで止めてもらったままにする。その後に書き込みを再開してもらう。6.4 の「外す」の手順は飛ばす

**計測用のデータベースを足すリリースの更新**(CHANGELOG の目印「計測用のデータベースを足す」。この 1 回だけ): 新しい版の edge は計測用のデータベース `wtt-results` と鍵 `RESULTS_VISITOR_KEY` を使い、新しい版の control は同じデータベースを結果の集計のために読む。下の手順 0(控え)の後、`pnpm runtime:build` と手順 1(edge)の前に、2.2 の「計測用のデータベース」を上から行う。全体の順は次のとおり:

1. 6.6 の凍結を入れ、1 分待って有効になったことを確かめる(この節の先頭)
2. 下の手順 0 のブロックで控えを取る。控えが取れなかったら、ここで止まる(2 つ目のブロックは控えのファイルが無いと動かない)
3. `wrangler d1 create wtt-results` で作り、`database_id` を **`apps/edge/wrangler.jsonc` と `apps/control/wrangler.jsonc` の `RESULTS_DB` の行の両方**に書く(6.2 で戻した設定ファイルには、新しい版の仮の ID が入っている。control の行は新しい版で足した行で、退避した設定には無い)。新しい版で `apps/control/wrangler.jsonc` の `d1_databases` を 1 行から複数行に変えたので、更新前に `wtt-control` の `database_id` を書いた行と重なり、6.2 の stash の apply がこの部分で衝突することがある。衝突したら、`wtt-control` の行には退避した `database_id` を、`RESULTS_DB` の行にはここで作った `database_id` を書いて解消する(6.2 の「apply で衝突」)
4. `pnpm -C apps/edge results:migrate:remote` で表を作る
5. `RESULTS_VISITOR_KEY` を登録する
6. 2.2 の確認のブロックを流す
7. 同じシェルで、下の 2 つ目のブロック(`pnpm runtime:build` から)を流す(`pnpm -C apps/edge results:migrate:remote`(4 で済んでいるので "No migrations to apply")→ edge → deployer → `pnpm -C apps/control d1:migrate:remote`(`wtt-control` に結果の記録・評価計画・採用の表を足す)→ control → admin)
8. 6.4 で確かめてから凍結を外す

- 3.4 の `AB_USAGE_RESOURCES` の `d1` にも `wtt-results` を足しておく(control のデプロイの前)
- control の `RESULTS_DB` の行に仮の ID が残ったまま control をデプロイしない。3 の後に `grep -c 00000000-0000-0000-0000-000000000000 apps/control/wrangler.jsonc || true` が 0 であることを確かめる
- 更新しても、既存のサイトの「結果を記録する」は無効のまま。記録を始めるには、管理者がサイト設定で有効にしてから、テストを開始する(有効にする前に開始したテストは記録されない)
- control だけを先にデプロイすると失敗する(edge の `ResultsBudget`・`ResultsHealth` を参照するため。3.5)

手順 0 の控えと、手順 1〜3 は別のブロックにしてある。どちらも**リポジトリ直下で**流す(控えのファイルは `$PWD/deploy-backups/` に絶対パスで書く。`pnpm -C apps/control` で動く wrangler に相対パスを渡すと、`apps/control` の下に書かれるため)。控えのディレクトリは所有者だけが開ける権限にし、export のダウンロード URL を標準出力にも wrangler のログのファイルにも残さない(理由は 10.1)。2 つ目のブロックは、同じシェルで 1 つ目のブロックが作った控えのファイル(`$BACKUP`)が空でないときだけ動く。控えが取れなかったとき(1 つ目のブロックが `$BACKUP` を消す)・別のシェルで始めたとき(`$BACKUP` が無い)は、何もせずに「控えがありません」と出して止まる。2 つ目のブロックの中は `&&` でつないであり、途中の手順が失敗するとそこで止まる(止まった手順の出力を読んで直し、2 つ目のブロックを流し直す。どの手順も何度流しても結果は同じ)。

```bash
# 0. 更新前の控え(必須。10.1)。成功すると「控え: <ファイル名>」と出る
BACKUP="$PWD/deploy-backups/wtt-control-$(date -u +%Y%m%dT%H%M%SZ).sql" && mkdir -p "$PWD/deploy-backups" && chmod 700 "$PWD/deploy-backups" && WRANGLER_WRITE_LOGS=false pnpm -C apps/control exec wrangler d1 export wtt-control --remote --output "$BACKUP" >/dev/null && test -s "$BACKUP" && echo "控え: $BACKUP" || unset BACKUP
```

手順 0 で「控え: <ファイル名>」と表示され、今回作ったファイルが存在して空でないことを確認してから、手順 1 以降へ進んでください。export が失敗した場合、ファイルが無い場合、または空の場合は、手順 4 の管理画面のデプロイも含めて更新を中止し、凍結を外さずに原因を調べ、手順 0 からやり直してください。

```bash
if test -s "${BACKUP:-}"; then
  ls -l "$BACKUP"   # 期待: 今回の控えのファイルがあり、サイズが 0 でない
else
  echo "控えがありません。更新を中止し、手順 0 をやり直してください"
fi
```

```bash
# 1〜3。0 の控えのファイルが空でないときだけ動き、途中の手順が失敗したらそこで止まる
if test -s "${BACKUP:-}"; then
pnpm runtime:build &&                                   # (c) が無くても実行してよい(冪等)
pnpm -C apps/edge results:migrate:remote &&             # 0.5 計測用のデータベースの (a) があれば。無ければ "No migrations to apply"(冪等)
pnpm -C apps/edge exec wrangler deploy &&               # 1. edge
pnpm -C apps/deployer exec wrangler deploy &&           # 1.5 デプロイ専用の Worker(更新のたびに `wrangler deploy` する。secret と `wtt-static` の作成は 2.9 で 1 回済ませてあるので繰り返さない。配信ファイルの作り直しは自動で、次の公開か 1 時間以内)
pnpm -C apps/control d1:migrate:remote &&               # 2. (a) があれば。無ければ "No migrations to apply"
pnpm -C apps/control guide:build &&                     # エージェント向けガイド本文の再生成(冪等)
pnpm -C apps/control exec wrangler deploy               # 3. control
else echo "控えがありません。手順 0 をやり直してください(マイグレーションとデプロイには進まない)"; fi
```

runtime を作り直したら control と deployer も必ず再デプロイする。control は下書きプレビュー用に同じ runtime 文字列を配るので、古い runtime を検証に配らないようにする。deployer は設置タグのファイルに runtime を書き込むので、更新しないと古い runtime を配り続ける。`wtt-static` には `wrangler deploy` を使わない(2.9)。

ここから手順 4(admin)の前までは、特定のリリースにだけ要る追加の手順。対象のリリースは CHANGELOG に目印がある。該当しなければ飛ばして手順 4 へ進む。

**配る設定の版(`schemaVersion`)が上がるリリースの更新**。公開の最初の版は配る設定の版 2 で、版 3 に上げたのは下の「ページの条件を対象 URL にまとめるリリース」。この手順が要るのは、版を上げるリリースだけ:

- 更新した後、6.6 の凍結を外してから、各サイトで 1 回公開する。配る設定を新しい形に置き換えるため。1 つ前の版の設定も読めるが、新しい規則は公開した設定から適用される(1 つ前の版の設定のままでは配れないものがあるリリースは、そのリリースの項に書く)。公開は API(`POST /sites/<siteId>/publish`、権限が管理者以上の鍵)か、管理画面の上部の「公開」で行う。エージェントは両方を示して人に選んでもらう(0 節の「管理画面での操作が要る工程の進め方」)
- 配る設定の版を上げたリリースを飛ばして更新しない。edge と control は 1 つ前の版までしか読めない。CHANGELOG の目印を確かめ、版を上げたリリースが間にあれば 1 つずつ順に更新する
- データベースの更新(マイグレーション。上の手順 2)から control の deploy(手順 3)までの間は公開しない。凍結中は公開できないので、凍結を外してから各サイトで公開する
- データベースの形が変わる更新(CHANGELOG に書いてある)は、コードを戻すだけでは前の版に戻せない。戻すときは 10 節の手順でデータベースも戻す(6.5)
- プレビューの別ファイルも配信専用の Worker が配る。更新の直後は 1 つ前のファイルも残る。そのため、前の設置タグのファイルを持つページがプレビューを求めても表示される。設置タグのファイルは最大約 60 秒キャッシュされる

**ページの条件を対象 URL にまとめるリリースの更新**(CHANGELOG の目印「データベースの形が変わる」「配る設定の版(`schemaVersion`)が上がる」「この版より前に開いたタブは再読み込みが要る」)。配る設定の版が 2 から 3 に上がる最初のリリース。上の「配る設定の版が上がるリリースの更新」も読む:

- 順は上の 2 つ目のブロックと手順 4 のまま(edge → デプロイ専用の Worker → マイグレーション(D1 の `0026_url_match_include.sql`)→ `guide:build` → control → admin)。新しい edge とデプロイ専用の Worker は版 2 と版 3 の両方の設定を読むので、control が版 3 を書き出す前に入っていれば、版 3 を読めない時間はできない
- **更新した直後から、配信条件か、配信条件が参照するオーディエンスに、ページの URL・ホスト・パス・パラメータの条件を持つエクスペリエンスは配信されない**。新しい版は版 2 の設定を読むとき、こうしたエクスペリエンスを外す(新しい設置タグはこの条件を判定しないため。1 つ前の版を古い規則のまま評価する、の例外)。止まるのは、edge の判定では edge のデプロイの直後、配信ファイルでは自動の作り直しの時点(次の公開か 1 時間以内)。ブラウザに残った前の設置タグのファイル(最大約 60 秒)と開いたままのページでは、前の規則のまま動く
- **マイグレーションは、こうしたエクスペリエンスのうち配信中のものを一時停止にする**(1 件ずつ操作の記録に `via: "system"`・理由 `page_condition_moved` の行を残す)。下書き・一時停止中・終了したものは状態を変えない。保存済みの対象 URL は、意味を変えずに新しい形(含める 1 行)に包む
- 当たるものは、凍結を入れる前(手順 0 の前)に一覧にしておく。読むだけの SQL で、結果は更新の後の直しに使う:

  ```bash
  # 配信条件にページの条件を持つエクスペリエンス(配信中のものは一時停止になる)
  pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select distinct e.site_id, e.id, e.status from experiments e, json_tree(e.targeting_json) t where e.targeting_json is not null and t.key = 'ctx' and t.value in ('url','host','path','query') order by e.status, e.site_id, e.id"
  # ページの条件を持つオーディエンスと、それを参照する配信中のエクスペリエンス(一時停止になる)
  pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select distinct a.site_id, a.id from audiences a, json_tree(a.definition_json) t where t.key = 'ctx' and t.value in ('url','host','path','query')"
  pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select distinct e.site_id, e.id, t.value as audience_id from experiments e, json_tree(e.targeting_json) t where e.status = 'running' and t.key = 'audience' and t.value in (select a.id from audiences a, json_tree(a.definition_json) u where a.site_id = e.site_id and u.key = 'ctx' and u.value in ('url','host','path','query'))"
  ```

  前の版の管理画面では、対象 URL を 1 行でしか書けない。更新の前に 1 行の対象 URL に書き直せるものは直してもよい。書き直せないものは、更新の後に新しい管理画面で直す
- 凍結の中で、6.4 の確認と一緒に、上の SQL を流し直して配信中(`running`)の行が無いことを確かめる。あれば凍結を外さずに調べる
- 凍結を外した後: 各サイトで 1 回公開する(上の「配る設定の版が上がるリリースの更新」)。一時停止になったエクスペリエンスは、管理画面の「配信条件」のカードで、警告の色の条件の行の内容を「① どのページで(対象 URL)」に書き、その行を「この条件を消す」で消して保存してから再開する(API では、エージェント向けガイドの「ページの条件を対象 URL に移す」)。古い条件が、更新の前の対象 URL と組み合わせて(「すべて満たす」で)使われていたときは、新しい行を足さずに、その対象 URL の行と同じ行に入れる(パラメータの条件は行の `params` に、ホスト・パスの条件は行の URL の「完全一致」「で始まる」の値にまとめる)。別の行に足すと「または」になり、配信先が広がる。オーディエンスに残った条件は、オーディエンスの画面で消し、参照するエクスペリエンスごとに対象 URL に書く。再開の後の公開で、そのテストの結果に「テスト中の変更」が 1 件記録される(届く定義の書き方が変わるため。判定は止まらない)
- **この版より前に開いた管理画面のタブは、凍結を外した後の最初の保存で「管理画面が古い版です」(426)になる**。ページを再読み込みすれば直る(未保存の入力は消えるので、必要なら控えてから)。更新の前に利用者に伝えておく。API で対象 URL を古い形で書き込んでいるエージェントや手順は、新しい形に書き換える(古い形は 422 `invalid_input`)
- 6.4 では、`curl -sSI "<control URL>/llms.txt" | grep -i x-wtt-min-client-version` が `x-wtt-min-client-version: 5` を返すことも確かめる
- このマイグレーションは後方互換ではない(前の版の control は新しい形の対象 URL を読めない)。前の版に戻すときは 6.5 の「ページの条件を対象 URL にまとめるリリースより前の版へ戻すとき」に従う

**システム管理者を導入するリリースの更新**。更新すると、最初に作られたワークスペースのオーナー全員がシステム管理者になり、すべてのワークスペースのオーナーになる:

- 最初に、凍結を入れる前(手順 0 の前)に、誰がシステム管理者になるかを確かめる: `pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select u.email from member m join \"user\" u on u.id = m.\"userId\" where m.role = 'owner' and m.\"organizationId\" = (select id from organization order by \"createdAt\", id limit 1)"`。意図しない人が入るなら、ここでその人の Role を直しておく。控えより後に Role を直すと、控えから戻したときに失われる書き込みになる
- 手順 0(更新前の控え)の前に 6.6 の凍結を入れる。下の確認が成功し、admin の deploy を終えるまで外さない。凍結は、公開・エクスペリエンスの状態の変更・ワークスペースやメンバーの作成・変更・削除・招待の受諾を含む変更操作をすべて止める。凍結の仕組みが入る前の版から更新するときは、凍結の代わりに上の「この 1 回だけ」のとおり書き込みを止めてもらう
  - 控えより前に止める理由: 控えの後に入った書き込みが、控えから戻したときに失われないようにするため。古い control はシステム管理者の扱いを知らないため、手順 2 の途中に書き込みが入ると直せない状態が残り得る
- control の deploy の後に、修復の SQL を 1 回流す。何度流しても結果は同じ: `pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --file scripts/instance-admins-repair.sql -y`
- 確認: `pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select (select count(*) from organization) as workspaces, (select count(*) from instance_admins) as admins, (select count(*) from organization o cross join instance_admins a where not exists (select 1 from member m where m.\"organizationId\" = o.id and m.\"userId\" = a.user_id and m.role = 'owner')) as missing"` が `workspaces` 1 以上・`admins` 1 以上・`missing` 0
  - どれかが外れた → 凍結を外さず、6.5(データベースも戻す)を人に相談する
  - `admins` が 0(最初のワークスペースにオーナーの行が無かった)→ システム管理者にしたい人を SQL で登録し、修復の SQL をもう一度流してから、上の確認をやり直す: `pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "insert into instance_admins (user_id, granted_by, created_at) select id, null, CAST(strftime('%s','now') AS INTEGER) * 1000 from \"user\" where lower(email) = lower('<メールアドレス>')"`
- 確認が成功したら、admin の deploy(下の「手順 4(admin)」のコマンド)を済ませてから、凍結を外す(6.6)。admin の deploy の前に外すと、古い画面が新しい control に書き込んでしまう
- その後、管理画面の左メニューの下の「設定」→「システム管理者」で一覧を確かめ、意図しない人が入っていれば「システム管理者から外す」。この更新で登録された人には、システム管理者になる前の記録が無い。そのため外すとすべてのワークスペースから外れるので、必要なワークスペースへ招待し直す

**パスワード再設定リンクの発行条件が変わるリリースの更新**:

- データベースの更新の後に、未使用のパスワード再設定リンクを一括で失効させる: `pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "delete from verification where identifier like 'reset-password:%'"`。発行の条件が変わり、古い条件で発行されたリンクを残さないため。非常時にだけ使うリンクなので失うものは無い

**パスワードでログインしていた版から更新するとき**。新しい版はログインが Google アカウントになり、メール + パスワードの経路は普段閉じる:

- deploy の前に、3.3(クライアント シークレットの secret 登録)と 3.4(`AB_GOOGLE_CLIENT_ID`)の Google の設定を済ませる
- 念のため、先に非常用トークンを置く(8 節の 1)。この工程は人が行う。エージェントは「8 節の 1 を済ませてください」と頼み、置けたことを `login-options` で確かめるだけ。control を先に更新した時点でパスワードの経路が閉じるので、admin の更新が失敗しても入口が残るようにしておく
- control → admin の順に deploy し、Google でログインできることを確かめてからトークンを消す
- 既存のユーザーは、同じメールアドレスの Google アカウントでログインすれば、同じユーザーとして入れる。ロールも招待も引き継がれる。Google アカウントを持たないメールアドレスのユーザーは、Google アカウントのあるメールアドレスで招待し直す
- オーナー自身が Google アカウントを持たないとき(オーナーのメールアドレスで Google アカウントを作れない)は、何もしないと更新後に誰も入れなくなる。どちらかを先に行う: (a) そのメールアドレスで Google アカウントを作る / (b) 8 節の非常用トークンを置いたまま更新し、非常口から入って Google アカウントのあるメールアドレスを管理者として招待 → その人が Google でログインして受諾 → メンバー画面でオーナーにする → 確認できてからトークンを消す

**レート制限の既定値が変わるリリースの更新**:

- edge の Rate Limiting binding の値は、6.2 の衝突の解消で 2.3 の規則の値になっている。手順 1 の edge の deploy で反映される
- ゾーンの WAF Rate Limiting Rule が以前の既定(100 回 / 10 秒)のままなら、200 に上げるのを勧める(必須ではない)。変え方は 2.7。上げた後も binding の値が 2.3 の規則の値以上かを確かめる(下回っていれば 2.3 の規則の値に上げる)
- 7.2 の control の WAF を「10 秒に 10 回」で作っていたら、7.2 の新しい目安に見直すのを勧める(必須ではない)

**管理画面の版の確認と service binding を足すリリースの更新**(CHANGELOG の目印「この版より前に開いたタブは再読み込みが要る」「オーナーと非常口でパスワードを使った人が 1 回ログアウトされる」「admin の設定に binding が増える」):

- 順は上の 2 つ目のブロックと手順 4 のまま(edge → deployer → マイグレーション → control → admin)。**edge は control より先にデプロイする**。新しい版の control は、各サイトのサイト設定の記録(KV)に新しい訪問者の記録の上限を書く。前の版の edge はこの項目を知らないので、その記録を読めないものとして扱い、そのサイトの判定と送信が 404 になる。**admin は control より後にデプロイする**。admin の binding の宛先(control の `ControlBff`)が要るため
- 手順 4 の出力の bindings に `env.CONTROL (wtt-control#ControlBff)` が出ることを確かめる(4.3)。6.4 では、`curl -sSI "<control URL>/llms.txt" | grep -i x-wtt-min-client-version` が `x-wtt-min-client-version: 1` を返すことも確かめる
- **この版より前に開いた管理画面のタブは、凍結を外した後の最初の保存で「管理画面が古い版です」(426)になる**。ページを再読み込みすれば直る(未保存の入力は消えるので、必要なら控えてから)。更新の前に利用者に伝えておく
- **更新の後、オーナーと、これまでに非常口(8 節)でパスワードを使った人が 1 回ログアウトされる**。Google でログインし直せばよい。新しい版は、非常口が閉じている間、パスワードの記録とその持ち主のログイン状態を 15 分ごとに消す(8 節)。既存の導入では、初回セットアップがオーナーに誰も知らない乱数のパスワードの記録を残しているので、オーナーも対象になる。非常口が閉じていれば凍結を外してから通常 15 分以内に、非常口を開けたまま更新したら閉じた後の最初の定期処理で消える。作業者自身もログアウトされうるので、先に伝えておく
- 新しい訪問者の記録の上限(運用ガイド 7 節)は、凍結を外した後の control の定期処理(15 分ごと)が、1 回に 10 サイトずつ各サイトのサイト設定の記録に入れる。入るまでは上限なしで今までどおり動く。翌日に `pnpm -C apps/control exec wrangler kv key get "site:<siteId>:settings" --namespace-id <namespace ID> --remote` で `newProfileBudget` が入ったことを確かめる。すぐに入れたいサイトは、管理画面でサイト設定を一度保存する
- Cron Trigger の本数は増えない(新しい定期処理は既存の 15 分ごとの Cron の中で動く)

**非常口のパスワードのセッションから API キーを発行できなくなるリリースの更新**(CHANGELOG の目印「マイグレーションを control より前に」):

- マイグレーション(上の 2 つ目のブロックの手順 2)を control の deploy(手順 3)より前に当てる。2 つ目のブロックの順のままでよい。control を先にデプロイすると、新しい control がログイン状態を作るときに書く列がまだ無いので、ログインが失敗する。この列は足すだけで、前の版の control は読まないので、前の版へ戻すとき(6.5)にデータベースを戻す必要は無い
- この版より前に作られたログイン状態のうち、パスワードの記録を持つ人のものは、Google でログインしたものも含めて、API キーの発行が 403 になる。Google でログインし直せば発行できる。非常口を閉じた後のパスワードの記録の削除(8 節)が済んでいれば当たらない。削除は閉じてから通常 15 分以内に行われ、その回の量が多いと次の回に回り、書き込みの凍結中は止まる
- 前の版で非常口(8 節)を開けたことがあれば、管理画面の各ワークスペースの「メンバーの API キー」(左メニューの下の「設定」の「ワークスペース」の見出しの下。管理者以上)の一覧で、心当たりの無い鍵を失効させる(鍵はそのワークスペースの一覧にだけ出るので、ワークスペースごとに見る)。前の版では、パスワードでログインしたセッションからも鍵を発行でき、その鍵は非常口を閉じても残るため

**タグを置くドメインの一覧を入れるリリースの更新**(CHANGELOG の目印「タグを置くドメインの一覧(壊れる変更)」):

- control の `apps/control/wrangler.jsonc` の `compatibility_flags` に `global_fetch_strictly_public` が増えた。保存のときに control が各ドメインの `/__ab/ping` へ送る確認を、control とサイトが同じゾーンにある構成でも、ゾーンの Route を経由して edge に届くようにするため。6.2 の stash の apply でこの行が衝突したら、新しい版の行(`"nodejs_compat", "global_fetch_strictly_public"`)を残す。手順 3(control)の前に `grep -c global_fetch_strictly_public apps/control/wrangler.jsonc` が 1 であることを確かめる
- マイグレーション(D1 の `0022_site_domains.sql`)が、今の 3 つの欄(ドメイン・受け付けるサイトのアドレス・Mode B の `hosts`)からタグを置くドメインの一覧を作る。上の 2 つ目のブロックの順(マイグレーション → control)のままでよい
- **この版より前に開いた管理画面のタブは、凍結を外した後の最初の保存で「管理画面が古い版です」(426)になる**。ページを再読み込みすれば直る。API で `domain`・`allowedOrigins`・`hosts` を書き込んでいるエージェントや手順は、`domains` に書き換える(古い欄を送ると 422 `legacy_domain_fields`)
- 凍結を外した後、Mode B のサイトはドメインの節で一度保存すると、一覧のドメインごとに Cloudflare 経由かを確かめる。保存するまでは、今の `hosts` にあったドメインは Cloudflare 経由、それ以外は確かめていないドメイン(Cloudflare 外として動く)のまま

**操作の記録を足すリリースの更新**(CHANGELOG の目印「操作の記録を足す」)。追加の手順は無く、マイグレーションは上の 2 つ目のブロックの手順 2 で当たる。次の点に注意する:

- マイグレーション(D1 の `0023_audit_events.sql`)は control の deploy(手順 3)より前に当てる。2 つ目のブロックの順のままでよい。順を誤って control を先にデプロイすると、新しい control は記録の表が無いので、記録を伴う変更操作(保存・公開・メンバーの操作など)がすべて 500 になる
- このマイグレーションは、操作の記録の表 `audit_events`(と索引)と、保持の定期処理が 1 日に消した数を持つ 1 行の表 `audit_retention_state` を作る。`sites`・`experiments` には世代の列 `generation` を足し、既存の行を乱数で埋める(同じ ID で作り直したサイト・エクスペリエンスの前の記録を、変更履歴に混ぜないため)。既存の行で書き換えるのはこの列だけ。トリガーを 4 つ作る: `audit_events_no_update`(記録の書き換えを断る)・`audit_events_keep_365d`(365 日より新しい記録の削除を断る)・`sites_fill_generation`・`experiments_fill_generation`(世代を入れずに作られた行に世代を入れる。凍結を入れる前に届いていた前の版の control の作成や、前の版に戻しているあいだの作成で起きる)
- admin は control より後にデプロイする(手順 4 の順のまま)。逆にすると、エクスペリエンスの「変更履歴」タブと設定の「操作の記録」が開けない案内になる(ほかは壊れない)
- 凍結の中で、6.4 の確認と一緒に次を確かめる。期待と違えば凍結を外さずに調べる:

  ```bash
  pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select (select count(*) from sqlite_master where name like 'audit_events%') as audit_objects, (select count(*) from sqlite_master where type = 'trigger' and name in ('sites_fill_generation', 'experiments_fill_generation')) as fill_triggers, (select count(*) from audit_retention_state) as retention_rows, (select count(*) from sites where generation is null) + (select count(*) from experiments where generation is null) as missing_generation"   # 期待: audit_objects 10(表 1・索引 7・トリガー 2)・fill_triggers 2・retention_rows 1・missing_generation 0
  ```

  管理画面で、エクスペリエンスの「変更履歴」タブと、設定の「操作の記録」(「ワークスペース」と「システム」の見出しの下)が開くことも確かめる(凍結中は、パスワードでのログインと非常用トークンでの再設定リンクの発行のほかは記録が増えないので、一覧は空でよい)
- 凍結を外した後に、管理画面で、システム管理者でないメンバーのロールを 1 回変えて元に戻し、そのワークスペースの「操作の記録」に 2 行出ることを確かめる(システム管理者のほかにメンバーがいなければ、下書きのエクスペリエンスのメモを保存し、「変更履歴」タブに 1 行出ることを確かめる)。出なければ、もう一度凍結を入れて調べる
- この版より前の操作は記録に無い。記録は 365 日残り、control の定期処理(今の 15 分ごとの Cron の中。Cron Trigger の本数は増えない)が 1 日 1 回、それより古い記録を消す
- 前の版へ戻すとき(6.5)に、データベースを戻す必要は無い。前の版の control は記録の表と世代の列を使わない。戻しているあいだの操作は記録されず、そのあいだに作ったサイト・エクスペリエンスにはトリガーが世代を入れるので、新しい版に戻した後の操作は変更履歴に出る
- edge・deployer・runtime・計測用のデータベース(`wtt-results`)は変わらない(この変更のための deploy は要らない)

**ログインのライブラリを上げるリリースの更新**(CHANGELOG の目印「非常口で作った人は Google に自動で結びつかない」):

- マイグレーション(D1 の `0025_apikey_config_id.sql`。上の 2 つ目のブロックの手順 2)を control の deploy(手順 3)より前に当てる。2 つ目のブロックの順のままでよい。control を先にデプロイすると、API キーの発行が列の不足で失敗する。この列は足すだけなので、前の版へ戻すとき(6.5)にデータベースを戻す必要は無い(前の版の control はこの列を書かず、既定の値が入る)
- 凍結を入れる前(手順 0 の前)に、次の 2 つを数える:

  ```bash
  pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select (select count(*) from \"user\" u where u.\"emailVerified\" = 0 and not exists (select 1 from account a where a.\"userId\" = u.id and a.\"providerId\" != 'credential')) as unlinked, (select count(*) from (select \"providerId\", \"accountId\" from account group by 1, 2 having count(*) > 1)) as duplicated"
  ```

  - `unlinked` は、更新の後に Google でログインできなくなる人の数(非常用のパスワードで作られ、まだ Google でログインしたことのない人)。0 でなければ、更新の後に運用ガイド 6 節「ログインできなくなったとき」の手順で招待し直す。誰が当たるかは、同じ条件で `u.email` を select して確かめる(エージェントの会話や端末の出力に残してよいかは人が決める)
  - `duplicated` が 0 でなければ更新しない(新しい版のライブラリは、同じ組の account を 2 行以上持つ人のログインを断るため)。人に相談する
  - `unlinked` にシステム管理者が含まれるかも数える(上の `unlinked` の条件に `and exists (select 1 from instance_admins i where i.user_id = u.id)` を足す)。含まれ、ほかに Google でログインできるシステム管理者がいなければ、その人は更新の後に管理画面に入れず、システム管理者から外すこともできない。**人が本人であることを確かめたうえで**、更新の前に次の 2 つの SQL でその人を確認済みにする。書き換わるのはパスワードの記録が無い人だけである。パスワードの記録が残っていれば、先に非常口を閉じ、15 分ごとの定期処理で消えるのを待つ(8 節)。パスワードの記録が無ければ、確認済みにしても、他人がその人として先に入っている状態にはならないため

    1. 読むだけの SQL で、そのメールアドレスの人を一覧にする。大文字と小文字だけが違うメールアドレスの人が別にいれば、ここに複数の行が出る(メールアドレスをエージェントの会話や端末の出力に残してよいかは人が決める):

       ```bash
       pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select u.id, u.email, u.\"emailVerified\", exists (select 1 from account a where a.\"userId\" = u.id and a.\"providerId\" = 'credential') as has_password from \"user\" u where lower(u.email) = lower('<メールアドレス>')"
       ```

       人が、出た行のうちどれが本人かを確かめ、その行の `id` を控える。`has_password` が 1 なら、パスワードの記録が残っている(上のとおり、先に消えるのを待つ)
    2. 確かめた `id` の 1 行だけを書き換える:

       ```bash
       pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "update \"user\" set \"emailVerified\" = 1 where id = '<確かめた id>' and not exists (select 1 from account a where a.\"userId\" = \"user\".id and a.\"providerId\" = 'credential') returning id, \"emailVerified\""
       ```

       出力に 1 行だけが出て、その `id` が確かめた `id` と同じで、`emailVerified` が 1 なら書き換わった。行が出なければ、パスワードの記録が残っているか、`id` が違う。更新の後に流しても効果は同じで、条件も同じ

- API キーはそのまま使える。更新の後、エージェントの鍵で `GET /me` が 200 を返すことを確かめる
- API の契約の版は変わらない(開いたままの管理画面のタブが、この更新で 426 になることは無い)

手順 0 の控えと手順 1〜3 がすべて成功した場合だけ、次の管理画面の更新を実行してください。途中で失敗した場合は、管理画面の更新に進まず、失敗した手順の原因を解消してください。

```bash
pnpm -C apps/admin build && pnpm -C apps/admin deploy:cf   # 4. admin
```

### 6.4 確認

ここからの確認は凍結中に行う(読み取りだけなので凍結の影響を受けない)。`<設置タグのホスト>` は 2.9 の (4) のとおり(`route` は設置ホスト、`custom-domain` は edge のホスト、`workers-dev` は `wtt-static` の workers.dev のホスト)。

```bash
curl -sSI "https://<設置タグのホスト>/s/<siteId>.js" | grep -iE 'HTTP/|cache-control'   # 期待: 200 と max-age=60
curl -sS "https://<設置タグのホスト>/s/<siteId>.js" | head -1                        # 先頭の注釈の `runtime <ハッシュ>` が下の値と同じ
grep -o 'RUNTIME_HASH = "[0-9a-f]*"' packages/runtime/generated/source.ts
curl -sS -o /dev/null -w '%{http_code}\n' "<control URL>/llms.txt"   # 期待: 200
curl -sS -o /dev/null -w '%{http_code}\n' "<AB_ADMIN_URL>/login"   # 期待: 200
```

確認が成功したら、6.6 の「外す」で凍結を外し、外れたことを確かめる:

```bash
pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select count(*) as frozen from instance_settings where key = 'writeFreeze'"   # 期待: frozen 0
curl -sS -X POST "<control URL>/workspaces" | jq -r '.error'   # 期待: "unauthorized"
```

凍結を外してから行うこと(凍結中は 503 になる):

- (b) がある場合は **【人に依頼】**: 管理画面で対象のサイトのサイト設定を開いて一度保存してもらう。エージェントは `pnpm -C apps/control exec wrangler kv key get "site:<siteId>:settings" --namespace-id <namespace ID> --remote` で新しいフィールドが入ったことを確認する(record を書くのはサイト作成と設定画面の保存だけ)
- 各サイトでの公開(6.3 の「配る設定の版が上がるリリース」に当たるとき)

期待と違うとき: 先頭の注釈の `runtime <ハッシュ>` が違う → まだ前の runtime の設置タグのファイルが配られている。凍結を外してから、管理画面の左メニューの下の「設定」→「配信ファイル」(「システム」の見出しの下)で「公開中の全サイトの配信ファイルを作り直す」を押すか(エージェントは、サイトごとの `POST /sites/<siteId>/static/redeploy` を公開中のサイトの数だけ呼ぶ)、1 時間待つ(毎時の Cron が全サイトを作り直す)。

`deploy-log.md` に「更新 <日付>: <現在 tag> → <目標 tag>、(a)(b)(c) の有無、凍結を入れた時刻、読み取りの確認結果、凍結を外した時刻、(b) の確認結果」を追記する。

### 6.5 戻すとき

目標 tag で問題が出たら、6.2 と同じ手順で現在 tag に戻して 6.3 を **同じ順序**で再実行する。戻す作業の間も 6.6 の凍結を入れておく(外すのは戻した版の確認が済んでから)。

ただし (a) のマイグレーションは戻せない(D1 のスキーマは進んだまま)。戻す前に `CHANGELOG.md` でそのマイグレーションが後方互換かを確認し、後方互換でない、またはデータが壊れたときは、D1 を更新前の時点に戻す(10.2 の Time Travel。手順 0 の export からの読み戻しは 10.3)。

**計測用のデータベースを足すリリースより前の版へ戻すとき**(CHANGELOG の目印「計測用のデータベースを足す」): edge だけは戻さず、新しい版のまま残す。ほかの Worker(deployer・control・admin)は前の版に戻してよい。

- 理由: 新しい版の edge は Durable Object の `ResultsBudget` と `ResultsHealth` を足している。前の版の edge はこの 2 つを持たない。Cloudflare は、使われている Durable Object を消す版のデプロイを、消すためのマイグレーションの指定が無いと受け付けないことがある(実機では確かめていない)
- 新しい版の edge は、前の版の control・前の版の設置タグ・結果の設定が無い配る設定と組み合わせても動く。結果の送信が無ければ、計測用のデータベースに何も書かない
- 新しい版の control も edge の `ResultsBudget`・`ResultsHealth` を参照している。control を新しい版のまま残すときも、edge は新しい版でなければならない

**新しい訪問者の記録の上限を足したリリースより前の版へ戻すとき**(CHANGELOG の目印「admin の設定に binding が増える」と同じリリース): edge だけは戻さず、新しい版のまま残す。

- 理由: 新しい版の control がサイト設定の記録(KV)に新しい訪問者の記録の上限を書いた後は、前の版の edge がその記録を読めず、サイトの判定と送信が 404 になる。control を前の版に戻しても、書いた記録は KV に残る
- 新しい版の edge は、上限の無い記録(前の版の control が書くもの)も今までどおり読む

**ページの条件を対象 URL にまとめるリリースより前の版へ戻すとき**(CHANGELOG の目印「データベースの形が変わる」「配る設定の版(`schemaVersion`)が上がる」): コードだけを戻すことはできない。マイグレーションの後のデータベースは、前の版の control が対象 URL を読めない。版 3 の設定を公開した後は、前の版の edge がその設定を読めない(読めない設定は空の応答になり、ページは元の表示のまま)。マイグレーションを逆向きに当てる手順は無いので、データベースも戻す。更新の後に公開したサイトがあるかで、手順が 2 つに分かれる(公開履歴の画面か `GET /sites/<siteId>/publishes` で、更新の時刻より後の公開を探す)。

- **更新の後、どのサイトも公開していないとき**: 6.6 の凍結を入れて 1 分待ち、10.2 の手順でデータベースを更新の前の時点(6.3 の手順 0 の控えを取った時点)に戻し、前の版を 6.3 と同じ順でデプロイし直す(デプロイ専用の Worker も前の版にする)。公開中の設定(KV)は版 2 のままなので、前の版がそのまま読む。10.2 の手順 8 の全サイトの作り直しは、前の版のデプロイ(デプロイ専用の Worker を含む)を終えて凍結を外した後に行う。新しい版のデプロイ専用の Worker が残っている間に作り直すと(サイト設定の保存も配信ファイルの更新を依頼する)、読み替えた版 3 の設定で配信ファイルが作られるため。その後、下の確認の条件を確かめる
- **更新の後に公開したサイトがあるとき**: 公開中の設定(KV)と配信ファイルの記録は、データベースと一緒には戻らない(10.2 の手順 8)。データベースを戻すと配信ファイルの世代も戻るので、ふつうの公開だけでは配信ファイルは更新待ち(`pending`)のまま進まない。また、新しい版のデプロイ専用の Worker は、版 2 の設定を版 3 に読み替えてから配信ファイルを作り、中身の照合の値も読み替えた後の値から作る。そのため、前の版の control が送る値と合わず、新しい版のままでは配信が済んだと認められない。次の順で戻す:
  1. 6.6 の凍結を入れ、1 分待つ
  2. 10.2 の手順で、データベースを更新の前の時点に戻す(10.2 の手順 8 の公開し直しと全サイトの作り直しは、下の 5・6 で行う)
  3. 前の版の control と admin をデプロイする
  4. 前の版のデプロイ専用の Worker をデプロイする。保存してある入力が版 3 のサイトは、自動の作り直しが失敗し(最後のエラー `rebake_failed`)、新しい版の設置タグのファイルが残る。edge はまだ新しい版なので、このファイルはそのまま動く
  5. 凍結を外し、公開中の全サイトを、前の版の control で公開し直す(公開中の設定が版 2 になる)
  6. 管理画面の左メニューの下の「設定」→「配信ファイル」(「システム」の見出しの下)で「公開中の全サイトの配信ファイルを作り直す」を押す(エージェントは、サイトごとの `POST /sites/<siteId>/static/redeploy` を公開中のサイトの数だけ呼ぶ)。その後、下の確認の条件を確かめる
  7. 確認の条件がそろってから、前の版の edge をデプロイし、6.4 の確認を行う
- 確認の条件(更新の後に公開したサイトがあるときは上の 7 の前。どのサイトも公開していないときも、作り直しの後に同じ条件を確かめる):
  - 全サイトの公開中の設定の版が 2: `pnpm -C apps/control exec wrangler kv key get "site:<siteId>:active" --namespace-id <namespace ID> --remote` の値を `<N>` として、`pnpm -C apps/control exec wrangler kv key get "site:<siteId>:config:v<N>" --namespace-id <namespace ID> --remote | jq .schemaVersion` が `2`
  - 配信ファイルの画面(か `GET /static/status`)に、更新待ちのサイト・最後のエラーが `rebake_failed` のサイト・記録が食い違っているサイトが無い
  - 各サイトの設置タグのファイルの先頭の注釈の `runtime <ハッシュ>` が、前の版で作った `packages/runtime/generated/source.ts` の `RUNTIME_HASH` と同じ(6.4 のコマンド)
  - デプロイ専用の Worker が保存した入力と、設置タグのファイルに書き込んだ設定の版が 2 に戻っている: `curl -sS "https://<設置タグのホスト>/s/<siteId>.js" | grep -o '"schemaVersion":[0-9]*' | head -1` が `"schemaVersion":2`。保存した入力は、全サイトの作り直しで前の版の control が送った設定に置き換わる(最後のエラーが `rebake_failed` のサイトが残っていれば、置き換わっていない)
  - 記録が食い違っているサイトの一覧は、同じ世代で中身が違うかを ID の順に先頭の 25 サイトまでしか比べない(10.2 の手順 8 の注意)。それより多いサイトのある導入では、残りのサイトも上の 2 つ(runtime のハッシュと設定の版)をサイトごとに確かめる
- 前の版の edge にした後も、開いたままのページと、ブラウザに残った設置タグのファイル(最大約 60 秒)は、版 3 の公開の版を指して判定を求めることがある。前の版の edge はこれを読めず空の応答を返す(ページは元の表示のまま)。配信先は広がらないので、この間は待つ。KV の書き込みが全拠点に届くまでの遅れも同じ
- この手順は、版 3 で 2 回以上公開したサイトを持つ試験用の導入で一度通してから、本番の導入で使う

### 6.6 書き込みの凍結(メンテナンス中)

更新・データベースを戻す作業・SQL での修復の間、管理画面と API からの変更操作を止める。

- 止まるもの: ログイン以外の変更操作(保存・公開・エクスペリエンスの開始と一時停止・招待の受諾など)。`503 write_frozen` になる
- 止まらないもの: 読み取り・ログイン・配信条件の確認(`POST /sites/{sid}/evaluate`)・訪問者への配信・テストの結果の記録(訪問者の送信は edge が受け、計測用のデータベースに書く)
- 管理画面の全ページに「メンテナンス中」のバナーが出る。開いたままの画面にも 1 分ほどで出て、外すと 1 分ほどで消える
- 凍結は入れた人がコマンドで外すまで続く。再開の見込みの時刻を過ぎても自動では外れない

**入れる**。`<理由>` と `<再開の見込み>` を書き換える:

- 理由はログインしていない人にも 503 の応答で見えるので、秘密を書かない
- 理由に `'` を含めるときは `''` と 2 つ重ねる。`"`・`$`・`` ` ``・`!` はシェルが壊れるか展開されるので使わない。`!` は対話シェルの履歴展開で置き換わる

```bash
pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', json_object('reason', '<理由。例: v1.1 への更新>', 'until', '<再開の見込み。例: 2026-10-10T12:00:00+09:00>'), CAST(strftime('%s','now') AS INTEGER) * 1000, null) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
```

再開の見込みを書かないときは `json_object('reason', '<理由>')` にする。見込みはタイムゾーン付き(`+09:00` か `Z`)で書く。付けないと設定が読めない扱いになり、バナーが「凍結の設定が読めません」になる。凍結自体は有効になる。

**有効になったか確かめる**。入れてから 1 分待ってから、次の作業に進む。入れる直前に受け付けた変更の書き込みが終わるのを待つため:

```bash
curl -sS -X POST "<control URL>/workspaces" | jq '{error, hint}'   # 期待: error が "write_frozen"、hint に理由
```

1 分の意味と限界: 1 分は通常の処理が終わる目安で、保証ではない。まれに 1 分を過ぎて書き込みが届いても、データベースの控えを取る間は他の要求が待たされる。そのため控えは一時点のまま取れ、その書き込みは控えに入らない。

control の Cron(15 分ごと。3.5)も、`wtt-control` に書く前に毎回凍結を確かめ、凍結中ならそこで止まる。凍結の後に残りうる Cron の書き込みは、確かめた直後の 1 回だけになる。1 分が目安で保証ではないのは、ほかの書き込みと同じ。使用量で結果の記録を止める処理は `wtt-control` に書かないので、凍結中も動く(メンテナンス中も訪問者の送信は続くため)。

マイグレーションは 1 ファイルの中では割り込まれない。ただし、ファイルとファイルの間や、マイグレーションの後に、更新前の版の処理が書くことはあり得る。まれに、そうした遅れた書き込みでデータが食い違うことがある(例: 公開の履歴に無い版の番号が公開中になる)。

確認(6.4・10.2 の手順 6)で、公開中の版と公開の履歴の食い違いに気づいたら、凍結を外してから公開し直す。公開中の版が履歴の最新と同じ番号になったことを確かめ、揃わなければもう一度公開する。

**状態を見る**:

```bash
pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select value, updated_at from instance_settings where key = 'writeFreeze'"   # 1 行 = 凍結中 / 0 行 = 凍結していない
```

**外す**:

```bash
pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "delete from instance_settings where key = 'writeFreeze'"
curl -sS -X POST "<control URL>/workspaces" | jq -r '.error'   # 期待: "unauthorized"(凍結が外れ、認証の判定まで進んだ)
```

困ったとき:

- **凍結中に、エクスペリエンスを急いで止めたい**(サイトの表示を壊しているなど)→ 凍結を外す → 管理画面で一時停止する → 凍結を入れ直す。データベースの更新(6.3 の手順 2)の最中は外さず、更新が終わってから行う
- **凍結を入れていたのに保存できた・バナーが出ない** → 状態を見るコマンドで行があるかを確かめる。行があるのに保存できるなら、control が凍結を知らない版(この機能より前の版)で動いている。その版からの更新では凍結が有効にならないので、6.3 の「凍結の仕組みが入る前の版から更新するとき」のとおり書き込みを止めてもらう
- **凍結を入れていないのに保存が断られる(「凍結の設定が読めません」)** → control は凍結の設定を読めないときも凍結中として扱う。読めない設定を無視して書き込みを受け付けることがないようにするため。原因は 3 つ
  - 状態を見るコマンドが、表 `instance_settings` が無いという内容のエラーになる → データベースの更新を当てる前に control を deploy している。6.3 の手順 2(`pnpm -C apps/control d1:migrate:remote`)を実行すれば直る。手順 2 より前に手順 3 を実行すると、その間の書き込みはすべて `503 write_frozen` になる
  - 表があり、行が無いのに断られる → D1 の障害を疑い、Cloudflare のダッシュボードで D1 の状態とエラーを確かめる
  - 行があって値が読めない(バナーが「凍結の設定が読めません」)→ 6.6 の「入れる」で値を書き直すか、「外す」で外す

### 6.7 Mode B のホストを後から足す

導入の後に、Mode B(サーバー発行 Cookie)で使うページのホストを増やすときの手順。例: `www.example.com` に加えて、申し込みフォームの `form.example.com` でも Safari 対策を使いたい。版の更新ではないので、6.1〜6.4 は行わない。

Route を置けるのは、導入のゾーン(`zone_name`)の中のホストだけ。ゾーンの外のホストは、手順 4 で「タグを置くドメイン」に足すだけにする。そのホストは Cloudflare 外のドメインとして、Mode A と同じ動きで動く(テストと目標は動き、Safari では ID が弱い)。

1. **入力ファイルの `dlite_hosts` にホストを足し、ゾーンの中かを確かめる。** `deploy-answers.yaml` があれば、`dlite_hosts` の配列にホストを足して `node tools/deploy-answers/cli.mjs; echo "exit=$?"` を実行する。ゾーンの外のホストなら「ゾーン … に属していない」と出るので、`dlite_hosts` から外す(手順 4 の「タグを置くドメイン」には足す)。入力ファイルが無ければ、ホストがゾーン名そのものか、`.<ゾーン名>` で終わることを目で確かめる。あわせて、そのホストが Cloudflare のプロキシを経由していることを確かめる(経由していないと Route が動かない):

   ```bash
   curl -sI "https://<足すホスト>/" | grep -i '^server:'   # 期待: server: cloudflare
   ```

2. **2.7 の WAF のルールの式を確かめる。** 式に `/__ab/` が入っていれば、足すホストもルールに入る(式はパスだけで書くため)。入っていなければ、[2.7](#27-waf-rate-limiting-rule推奨) の「期待と違うとき」の `/__ab/` を足す手順を行う(人に依頼する手順なので、待つことがある)。Route より先に行う。Route を置いてから待つと、その間 Route があるのにどのサイトも持っていないホストができる(この節の最後の段落)。

3. **edge の `apps/edge/wrangler.jsonc` に Route を足して、edge を deploy する。** `routes` に `{ "pattern": "<足すホスト>/__ab/*", "zone_name": "<ゾーン名>" }` を足す(ワイルドカードでまとめる書き方は [2.3](#23-route-を書く))。Route はダッシュボードだけで足さない。ダッシュボードで足した Route は、次の `wrangler deploy`(更新のときの edge の deploy を含む)で設定ファイルの内容に置き換わり、消える(Cloudflare の資料のとおり)。設定ファイルに書いておけば、更新のときも 6.2 の退避で残る。deploy は、今動いている版の tag を checkout したまま行う(`git describe --tags --exact-match` が今の版を返すこと。ここで版を変えない)。導入とは別の会話や端末で行うときは、先に 6.1 の先頭のとおり導入先のアカウントを固定し、`pnpm install` を済ませておく:

   ```bash
   pnpm -C apps/edge exec wrangler deploy
   ```

   確認: 出力の triggers に `<足すホスト>/__ab/*` が出る。

4. **管理画面でホストを足して保存する。** 左メニューの下の「設定」→「サイト設定」の「ドメイン」の節で、「タグを置くドメイン」にホストを足して保存する。保存のとき、control が一覧のドメインごとに edge が応答するかを確かめる。
5. **札を確かめる。** 足したホストの行の札が `Cloudflare 経由(edge が応答しました)` になれば終わり。`Cloudflare 外(edge が応答しません)` や `確かめられませんでした` のときは、5 節の「サイトを作る」の「期待と違うとき」を見る。Route を直した後は、もう一度保存すると確かめ直す。

タグを置くドメインが Cloudflare 経由かの確認は、同じ導入のどのサイトの管理者でも、そのホストを自分のサイトの一覧に足して保存すれば行える。そのホストを本当に管理している人かどうかは確かめない。そのため、導入の後に Route を足すときは、そのホストを使うサイトを管理画面で作り終えてから Route を置き(手順 3)、置いたらすぐに手順 4・5 を行う。Route があり、どのサイトの一覧にも Cloudflare 経由として入っていないホストは、ほかのサイトの管理者が先に自分のサイトの一覧に足して、Cloudflare 経由として持ててしまう(一度どれかのサイトが持つと、ほかのサイトの保存は 409 `host_in_use` になる)。最初の導入で 2.3 の Route を 5 節のサイトの作成より先に置くのは、この順で問題ない。その時点では、ほかのサイトの管理者がまだいないため。

## 7. 無認証入口の防御

control の無認証入口をどう防御するかは、**導入時に次の 3 つから選ぶ**。入口は次のとおり。

- 常時開いている: `/auth/google/start`(Google へ送り出す)/ `/auth/callback/google`(Google からの戻り)/ `/auth/handoff/exchange`(ログイン直後に管理画面がセッションを受け取る使い捨てコードの交換)/ `/login-options`(この導入で使えるログイン方法)/ `/break-glass/reset-link`(非常用トークンの照合)/ `/setup`(ユーザー 0 件のときだけ)/ `/invitations/:id/accept`(招待の受諾)
- **非常時だけ開く**: `/auth/sign-in/email` / `/auth/sign-up/email` / `/auth/request-password-reset` / `/auth/reset-password` の 4 つ(非常用トークンを置いているあいだだけ。置いていなければ 404。8 節)

Workers 内の Rate Limiting binding は本番で実効していなかった実測があるため、補助としては残すが防御の中心にはしない(管理画面経由の要求も、操作した人の IP ごとに数える。[運用ガイド 7 節](operations.md#7-レート制限の実効))。

**(2)(3) の対象になる要求**: 管理画面(admin)から control への通信は service binding(4 節)で、control のゾーンを経由しない。そのため (2) の WAF と (3) の Access の対象は、control の公開アドレスに直接届く要求だけになる。

- 対象になる: ブラウザが直接開く Google ログインの 2 経路(`/auth/google/start`・`/auth/callback/google`)/ 非常口のトークンの照合(`/break-glass/reset-link`。8 節で人が curl で送る)/ 初回セットアップの `POST /setup`(5 節でエージェントが curl で送る)/ 管理画面を経由せずに無認証の入口を直接呼ぶ第三者の要求
- API キーを使うエージェント・スクリプトの呼び出しは、(3) の Access(control のホスト全体に掛かる)の対象になる。(2) の WAF は 7.2 の式の無認証の入口だけを数えるので、API キーの呼び出しは数えない
- 対象にならない: 管理画面からのログイン・ログイン直後のセッションの受け取り・管理画面の `/setup` の画面からの初回セットアップ・招待の受諾・その他の管理画面の操作。回数は control の binding が利用者の IP ごとに数える

`GET /llms.txt` も無認証だが、返すのはエージェント向けガイドの本文だけでサイト / エクスペリエンスのデータに触れないため、この 3 択の対象には含めない。

既定は (1)(`control_protection: none`)。`waf` / `access` を選ぶには先に `control_address: custom` にする(7.1)。

| 選択 | 向く相手 | 前提 | コード変更 |
|---|---|---|---|
| (1) 何もしない(`*.workers.dev` のまま) | 個人利用、管理者 1 人 | なし(パスワードの経路は普段閉じており、総当たりの標的が無い。本人確認と多要素認証は Google 側) | なし |
| (2) ゾーンの WAF Rate Limiting Rules | 小規模チームの標準 | control をカスタムドメインに置く(7.1)。Free のゾーンでは、同じゾーンのほかのサイトが control と同じパスを使っていないこと(7.2) | なし |
| (3) Cloudflare Access(単独または (2) と併用) | 外部エージェントに API を呼び出させる、到達自体を絞りたい | カスタムドメイン(7.1)。エージェントはサービストークンを付ける | なし |

3 つは互いに干渉しない。(1) で始めて後から (2)(3) へ移るコストは小さい(7.1 の作業(ホストの空きの確認のための作業用のトークンの作り直しを含む。0.5 の最後の段落)+ `AB_CONTROL_URL` の差し替えだけで、ユーザー・API キー・公開履歴は引き続き使える。招待 / リセットのリンクは `AB_ADMIN_URL` 側なので影響しない)。

### 7.0 (1) 何もしない

`*.workers.dev` のまま使う。

- **失うもの**: ゾーンの外にいるため WAF も Access も掛けられず、入口への到達を絞る仕組みが無い
- **残る防御**: ログインは Google アカウントだけで、パスワードを当てにいく入口が普段は存在しない(本人確認と多要素認証は Google 側)/ ログインできるのは招待されたメールアドレスだけ(招待リンクは 7 日で失効)/ setup はトークン一致かつユーザー 0 件のときだけ / API キーはハッシュ保存

この選択では次を必須条件とする。

- 5 節の `AB_SETUP_TOKEN` 削除を必ず行う
- 非常用トークン(`AB_BREAK_GLASS_TOKEN`)を置きっぱなしにしない(置いているあいだは、管理画面にログインしているあいだ、どのページにも注意の帯が出る。次に管理画面を開いた人が閉じ忘れに気づける。8 節)
- 管理画面に入る Google アカウントでは 2 段階認証を有効にする
- アカウントは必要最小限に留め、使わなくなったメンバーと API キーは失効させる

### 7.1 (2)(3) の共通前提: control をカスタムドメインに載せる

先に、`control.<運用者ドメイン>`(`control_host`)が空いていることを API で確かめる。非対話で実行した `wrangler deploy` は、Custom Domain を作るときに、同じ名前の既存の DNS レコードと、ほかの Worker への割り当てを確認なしに上書きするため(2.3 の `custom-domain` のときと同じ確認)。既にこのホストに control を置いていて、デプロイし直すだけのときは行わない(自分の割り当てがあるので `n` が 1 になる)。

```bash
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
HOST=<control_host>             # 例 control.example.com
ZONE=<そのホストのゾーン名>      # 0.5 の 2 で確かめたゾーン(例 example.com)
T=$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)
AID=${CLOUDFLARE_ACCOUNT_ID:-$(pnpm -C apps/control exec wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)}
ZID=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=$ZONE" -H "Authorization: Bearer $CF_TOKEN" | jq -r '.result[0].id')
echo "ZID=$ZID"   # 期待: 32 桁の ID(null なら、ZONE の名前が違うか、CF_TOKEN の対象のゾーンに入っていない)

# 1. 同じ名前の DNS レコードが無い(CF_TOKEN の DNS Read を使う)
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?name=$HOST" -H "Authorization: Bearer $CF_TOKEN" | jq '{ok: .success, n: (.result | length)}'   # 期待: {"ok": true, "n": 0}
# 2. ほかの Worker の Custom Domain に使われていない(wrangler login の資格情報を使う)
curl -sS "https://api.cloudflare.com/client/v4/accounts/$AID/workers/domains?hostname=$HOST" -H "Authorization: Bearer $T" | jq '{ok: .success, n: (.result | length)}'   # 期待: {"ok": true, "n": 0}
```

期待と違うとき:

- `ok` が `true` でない・権限のエラーが出る・jq がエラーになる(応答が JSON でない)→ 空いているとはみなさず、作業を中断して人に聞く。1 の権限のエラーは、`CF_TOKEN` に Zone → DNS → Read が無いときに出る。`ZID` が null のときは、`ZONE` の名前が違うか、`ZONE` が `CF_TOKEN` の対象のゾーンに入っていない(0.5 の 2)
- `n` が 1 以上 → そのホストは使われている。別のホストにする(`control_host` を変える)か、使っていないことを人に確かめてから人に消してもらう。消した後に、このブロックをやり直す

確かめたら、`apps/control/wrangler.jsonc` に `workers_dev` / `preview_urls`(どちらも `false`)と `routes` を**足し**、既存の `dev` の行を下の `dev` で**置き換えて**(同じキーを二重に書くと後ろの行が勝つ)再デプロイする。DNS レコードと証明書は wrangler が自動で作る。

`workers_dev` / `preview_urls` を `false` にしないと `https://wtt-control.<アカウントのサブドメイン>.workers.dev` と Preview URL が開いたままになり、(2)(3) の防御を迂回できる。

確認: `wrangler deploy` の出力の `Deployed wtt-control triggers` に `control.<運用者ドメイン>` だけが並び、workers.dev の行が**無い**こと。

```jsonc
"workers_dev": false,
"preview_urls": false,
"routes": [{ "pattern": "control.<運用者ドメイン>", "custom_domain": true }],
// edge と同じ落とし穴: routes を書くと local mode の origin host も route になるので、ローカル開発用に host を固定する
"dev": { "port": 8788, "host": "localhost" }
```

同時に `vars.AB_CONTROL_URL`(と暫定運用中なら `AB_ASSET_PUBLIC_BASE`)を `https://control.<運用者ドメイン>` に変え、`apps/admin/wrangler.jsonc` の `vars.AB_CONTROL_URL` も揃えて admin を再デプロイする(`pnpm -C apps/admin build && pnpm -C apps/admin deploy:cf`)。`/setup` の前に行えばやり直しは発生しない。

### 7.2 (2) WAF Rate Limiting Rules

ルールの本数と、条件に使える項目は、ゾーンのプランで違う(Cloudflare の文書 [Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) の Availability の表。2026-10-20 に確認):

| プラン | 本数 | 条件に使える項目 |
|---|---|---|
| Free | 1 | パスと Verified Bot だけ。**ホスト名は使えない** |
| Pro | 2 | ホスト名・パス・URI・クエリ・Verified Bot |
| Business | 5 | Pro の項目 + メソッド・送信元 IP・User Agent |

数える単位は Free と Pro では IP だけ。期間は Free では 10 秒に決まっている。

**Free の注意**: ホスト名で絞れないので、下の control のパスの条件は、ゾーンのすべてのホストへの要求で数える。同じゾーンに会社のサイトなどほかのホストがあり、そこで同じパスを使っていると、そのサイトへの要求も数える。しきい値を超えた IP からは、そのサイトのそのパスへの要求も遮断される(そのサイトのほかのパスは遮断されない)。Free で使う前に、下の「Free で使う前の確認」を行う。

edge 用のルール(2.7)と枠を取り合う点に注意する:

- Free で両方が要るなら、新しいルールは作れない。2.7 のルールの条件式に、control のパスを OR で足して 1 本にする(手順 2 の Free の式)。しきい値は edge と共通(2.7 の値)になる。edge と control への要求は IP ごとに合わせて数えるので、会社の拠点などで訪問者の閲覧がしきい値を超えると、同じ IP の管理者がブラウザで直接開く Google ログインの 2 経路(`/auth/google/start`・`/auth/callback/google`)も遮断され、ログインできなくなる(逆も同じ)。管理画面のほかの通信は service binding で control に届き、この WAF を通らないので遮断されない(7 節の冒頭)。1 本にした後は、2.7 の API の PUT を流し直さない(ルールが edge の式だけで置き換わり、control のパスが消える)。control 側でこれ以上絞りたいなら (3) Access を足す(7.3)
- 別々のしきい値が要るなら Pro 以上(Pro は 2 本まで)
- 専用のルールを持てるなら(別のゾーン、または Pro 以上)、50 回 / 10 秒にする。WAF は経路を区別せずに数え、Google ログインは開始と戻りで 1 人 2 回になる。50 なら、同じ拠点から 10 秒に約 25 人がログインできる(研修などの一斉ログインの目安)

#### Free で使う前の確認

1. ゾーンでプロキシが有効なホストを一覧にする。ダッシュボード → 対象ゾーン → DNS → Records(レコード)で、Proxy status(プロキシ ステータス)がプロキシ(オレンジの雲)の行がそれに当たる。プロキシが無効(DNS only(DNS のみ))のホストは、WAF を通らないので数えない
2. この製品のホスト(control・edge・設置タグの配信・admin)以外の各ホストで、次のパスを使っていないかを、そのサイトの担当者に確かめる(サイトのルーティングの設定やサイトマップで探してもらう): `/auth/` で始まるパス・`/setup`・`/invitations/` で始まるパス・`/break-glass/reset-link`。手早い目安として `curl -sS -o /dev/null -w '%{http_code}\n' https://<ホスト>/setup` が 404 なら、`/setup` は使われていない。ただし `/auth/` や `/invitations/` で始まるパスの有無はこれでは分からないので、担当者への確認は省かない。admin を同じゾーンに置いた場合、admin にも `/setup` の画面があるが、最初の導入のときにだけ使う画面なので、数えられても困らない
3. どのホストでも使っていなければ、下の手順で Free の式を書く
4. 使っているホストがあれば、次から選ぶ:
   - control のパスを WAF に入れない。control の無認証の入口の制限は、control の Rate Limiting binding(`AUTH_RATE_LIMITER`。経路ごと・IP 単位で 30 回 / 10 秒)だけになる。この binding の本番での効き方は限定的([運用ガイド 7 節](operations.md#7-レート制限の実効))なので、(1) と同じ扱いにして、7.0 の必須条件を守る。入力ファイルの `control_protection` は `none` にする
   - (3) Access に任せる(7.3)。入力ファイルの `control_protection` は `access` にする。管理画面から control への通信は service binding で Access を経由しないので、Access を掛けても管理画面の操作は止まらない。ブラウザが直接開く Google ログインの 2 経路は Access の判定を受けるので、その扱いを 7.3 のとおりに決める
   - ゾーンを Pro 以上にして、手順 2 の Pro 以上の式(ホスト名の条件つき)を書く
   - control を、ほかのサイトを置いていない別のゾーン(別のドメイン)に置く(7.1)。そのゾーンの 1 本を control 専用に使える

#### 手順

1. ダッシュボード → 対象ゾーン → Security(セキュリティ)→ Security rules(セキュリティ ルール)→ Create rule(ルールを作成)→ **Rate limiting rules(レート制限ルール)**。Free で 2.7 のルールを作ってあるなら、新しく作らずに、そのルールを開いて条件を書き換える
2. 条件(Edit expression(式を編集)で書く):
   - **Pro 以上**: ホスト名の条件とパスの条件を `and` でつなぐ。パスの 4 つは括弧でくくる(括弧が無いと `and` が先に結びつき、後ろの 3 つがゾーンのすべてのホストに掛かる)

     ```text
     (http.host eq "control.<運用者ドメイン>") and (starts_with(http.request.uri.path, "/auth/") or http.request.uri.path eq "/setup" or starts_with(http.request.uri.path, "/invitations/") or http.request.uri.path eq "/break-glass/reset-link")
     ```

   - **Free**: ホスト名を書かず、パスだけで書く。2.7 のルールと 1 本にするときは、次の式で 2.7 の式を置き換える(前半の 2 つが 2.7 の式)。2.7 のルールが無く control だけで使うなら、後半の 4 つだけにする

     ```text
     (starts_with(http.request.uri.path, "/v1/sites/")) or (starts_with(http.request.uri.path, "/__ab/")) or (starts_with(http.request.uri.path, "/auth/")) or (http.request.uri.path eq "/setup") or (starts_with(http.request.uri.path, "/invitations/")) or (http.request.uri.path eq "/break-glass/reset-link")
     ```

     招待の受諾の入口は、`/accept` を含むパスではなく `/invitations/` で始まるパスで書く(Pro 以上の式も同じ)。Free ではゾーンのすべてのホストで数えるので、ほかのサイトでも使われやすい `/accept` を含むパスを広く対象にしないため。admin の画面の内部の経路にも `/accept` を含むものがある。control の `/invitations/` の下にあるのは、招待の内容の表示と受諾だけで、どちらも無認証の入口

   `/break-glass/reset-link` は非常用トークンを照合する入口で、`/auth/` にも `/setup` にも当たらないので明示的に足す(`/login-options` は秘密を扱わない読み取りなので足さない)
3. 同一 IP から 10 秒あたり、上の値(edge と 1 本にするなら 2.7 の値、専用のルールなら 50 回)を超えたら Block(Block の継続時間は選べる範囲で最短にする)
4. 保存後にスモーク: 誤ったトークンの `POST /setup` を 50 並列で、30 秒を上限に繰り返す。本文が `error code: 1015` の 429(Cloudflare の遮断)が出れば有効。control の封筒の 429 `rate_limited` は control の binding の遮断なので数えない。そのため、状態コードではなく本文で判定する

```bash
# 50 並列で 30 秒以内にしきい値を超える。本文が error code: 1015 の応答が 1 つでも出れば有効
END=$((SECONDS+30)); HIT=0
while [ $SECONDS -lt $END ]; do
  seq 1 50 | xargs -P 50 -I{} curl -sS -X POST "https://control.<運用者ドメイン>/setup" -H 'X-Setup-Token: wrong' -H 'content-type: application/json' -d '{}' -w '\n' | grep -q 'error code: 1015' && { HIT=1; break; }
done
echo "hit=$HIT"   # 期待: hit=1
```

hit=0 なら 1 分後に 1 回だけやり直す。それでも hit=0 なら人に報告する。

管理画面の BFF の通信は service binding で control に届き、control のゾーンを経由しないので、この WAF には数えられない(7 節の冒頭)。WAF が数えるのは、上の式に当たる要求のうち、ブラウザが直接開く Google ログインの 2 経路・非常口のトークンの照合・5 節でエージェントが curl で送る `POST /setup` と、無認証の入口を直接呼ぶ第三者の要求。API キーを使う呼び出しは式に当たらないので数えない。管理画面からのログインの回数は、control の binding が利用者の IP ごとに数える。CI や運用スクリプトから無認証の入口(ログイン・`/setup` など)を連続して呼ぶ場合は、この WAF の回数に入る。**実機検証は未実施。**

### 7.3 (3) Cloudflare Access

Zero Trust(Free で 50 ユーザーまで)の Access アプリケーション(Self-hosted)を `control.<運用者ドメイン>` に作り、ポリシーで許可する相手を決める。ブラウザからの直アクセスにはメールのワンタイム PIN や Google ログインを要求できる。

**この構成での注意**: Access の判定を受けるのは、control の公開アドレスに直接届く要求だけ(7 節の冒頭)。

- **管理画面の操作**: admin の BFF は service binding で control を呼び、Access を経由しない。admin にサービストークンを持たせる必要は無い
- **エージェント**: Access で Service Token を発行し、エージェントが `CF-Access-Client-Id` / `CF-Access-Client-Secret` を毎回付ける。control 側の変更は不要(Access は Worker に届く前で判定する)。サービストークンを付けるのはエージェントだけでよい
- **Google ログインの 2 経路**(`/auth/google/start`・`/auth/callback/google`): ブラウザが control を直接開くので、Access の判定を受ける。次のどちらかにする
  - 管理画面に入る人を Access のポリシーで許可し、ログインの前に Access のログインを済ませてもらう(Access のログインと Google のログインの 2 回になる)
  - この 2 つのパスだけを Bypass にする(Access のアプリケーションをパスごとに分け、その 2 つに Bypass のポリシーを付ける。Bypass・Service Token は Cloudflare の画面の名前。日本語の表示は未確認)。この 2 つは Google の認証の開始と戻りで、Bypass にしても、招待されたメールアドレスの Google アカウントでなければログインできない
- **非常口のトークンの照合**(`/break-glass/reset-link`。8 節): 人が curl で送るので、Access のログインを済ませられない。Access を掛けた導入では、エージェントと同じくサービストークンのヘッダーを curl に付ける
- **初回セットアップの `POST /setup`**(5 節): エージェントが curl で送るので、これも Access の判定を受ける。Access を `/setup` より前に掛けたときは、サービストークンのヘッダーを curl に付ける

(2) と併用すると、入口で量を絞りつつ到達自体も絞れる。**実機検証は未実施。** 管理画面自体に Access を掛ける話は 4.5 を参照。

ログインを Google アカウントにしても、Access には残る利点がある: control のプログラム自体に穴があっても、直接の呼び出しは Worker が動く前で止まる / 許可するメールドメイン・IP・デバイスなどの組織の方針をまとめて掛けられ、到達の記録も残る / 非常用のパスワード経路を開けているあいだ(8 節)、control への直接のパスワードの試行を止められる(管理画面からのパスワードのログインは service binding を経由するので、止めるには管理画面にも Access を掛ける。4.5)。引き換えに、admin にも掛けるなら Access のログインと管理画面のログインで二重にログインすることになる。

## 8. 非常時の入り方

**【人が行う】** Google でログインできなくなったとき(OAuth クライアントを消した・壊した、Google 側の障害など)の入口。

- 使えるのは **Cloudflare アカウントで control の secret を設定できる人だけ**。その人は D1 も触れるので、この入口で権限が増えることはない
- **ここは人が自分の端末で行う**(エージェントに頼まない)。非常用トークンと再設定リンクは、持っていればオーナーのアカウントに入れる秘密なので、エージェントの会話・作業ログ・CI の出力に残さない。端末の画面に出した場合は、使い終わったら scrollback を消す(多くのターミナルで Cmd/Ctrl + K)

1. 非常用トークンを置く(16 文字以上。短い値は無視される)。secret にするのは、vars は次の `wrangler deploy` で設定ファイルの内容に上書きされて消えるため。ダッシュボードで置くなら Compute(コンピュート)→ Workers & Pages → `wtt-control` → Settings(設定)→ Runtime variables and secrets(ランタイム変数とシークレット)→ Add variable(変数を追加する)で種類を secret にして → Add variable and deploy(変数を追加してデプロイ)

   ```bash
   BG=$(openssl rand -hex 16)                                              # 画面には出さない(echo しない)
   printf '%s' "$BG" | pnpm -C apps/control exec wrangler secret put AB_BREAK_GLASS_TOKEN
   ```

   `$BG` はこのシェルの中だけで使う(手順 2 で curl の標準入力に渡す)。別のシェルで続けるなら、`read -rs BG` で入力してから手順 2 を実行する(入力は画面に出ない)。

   secret の反映には数秒かかることがある。`curl -sS "<control URL>/login-options"` が `"passwordLogin":true` を返すのを確かめてから次へ進む(反映前は次の手順が 404 になる)。置いた時刻(開いた時刻)を `deploy-log.md` などに控える(閉じた後に、操作の記録をこの時刻から見る)

2. オーナーのパスワード再設定リンクを得る(オーナー以外のメールアドレスや、違うトークンには 404 が返る。control の前段に WAF のレート制限を入れている導入では、連打すると遮断される)

   ```bash
   printf '{"token":"%s","email":"%s"}' "$BG" '<オーナーのメールアドレス>' \
     | curl -sS -X POST "<control URL>/break-glass/reset-link" -H 'content-type: application/json' --data-binary @-   # 期待: {"url":"<admin URL>/reset?token=…"}
   ```

   本文は標準入力で渡す。curl の引数に入れると、curl が動いている間、同じ端末の他のアカウントが実行中のコマンドの引数からトークンを読めるため(`printf` はシェルの中で動くので、引数は他のアカウントから見えない)。値はそのまま JSON に入るので、手で入れるトークンには `"` と `\` を含めない(手順 1 で作るトークンは 16 進の文字だけなので当たらない)。

   URL を画面に出さずにクリップボードへ直接入れるなら、末尾を `| jq -r .url | pbcopy`(macOS)/ `| jq -r .url | clip.exe`(Windows の Git Bash)/ `| jq -r .url | xclip -selection clipboard`(Linux)にする。リンクは 1 回限り・1 時間で失効する。

3. 返ってきた URL を**末尾まで全部コピーして**ブラウザのアドレスバーに貼り、パスワードを決め、ログイン画面に出ている「非常用」の欄からログインする
   - ターミナル上のリンクをクリックすると、折り返しの位置で URL が切れて開かれることがある。`token=` の値が途中で切れていると「パスワードを変更できませんでした」になる
   - パスワードは普段使わないので、覚えておく必要はない(非常時は毎回ここからやり直す)
4. 用が済んだら必ず閉じる

   ```bash
   pnpm -C apps/control exec wrangler secret delete AB_BREAK_GLASS_TOKEN
   curl -sS "<control URL>/login-options"   # 期待: "passwordLogin":false
   ```

   消した時刻(閉じた時刻)も控える。

   閉じた後の注意:

   - **閉じてから通常 15 分以内に、パスワードの記録と、パスワードの記録を持つ人のログイン状態(Google でログインしたものを含む)がすべて消える**(control の 15 分ごとの定期処理。その回の処理の量が多いと次の回に回る。書き込みの凍結中は、凍結を外した後の最初の処理で消える)。非常口でパスワードを使った人は、閉じた後に 1 回 Google でログインし直す。パスワードは残らないので、次の非常時もトークンを置いて再設定リンクから入り直す
   - **非常口で作られた人(開いているあいだに招待をパスワードで受けて入った人)は、閉じた後に Google でログインしても、同じアカウントに自動では結びつかない**。ログイン画面に案内が出る。[運用ガイド 6 節「ログインできなくなったとき」](operations.md#ログインできなくなったとき)の手順で、同じメールアドレスで招待し直す
   - 消えたことは次のコマンドで確かめられる。`passwords` が 0 なら消えている

     ```bash
     pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select count(*) as passwords from account where \"providerId\" = 'credential'"
     ```

   - **操作の記録で、開いていた間のすべての操作を確かめる**: 左メニューの下の「設定」→「操作の記録」(「システム」の見出しの下。システム管理者)で、期間に開いた時刻と閉じた時刻を入れ(「非常口を開いていた期間で絞る」)、種類は「すべて」のまま、すべてのログイン方法の操作を見る。閉じた後も、上の削除が済むまでは、開いているあいだに作ったログイン状態が使えるので、終わりの時刻は閉じた時刻より余裕を見て後にする(閉じた直後に見るなら、終わりは空 = 今まででよい)。「パスワードのログイン・非常口だけ」の絞り込みは補助にとどめる。開いているあいだに招待を受けて入った人が、その後 Google でログインして行った操作(API キーの発行など)は、ログイン方法が Google になり、この絞り込みには出ないため。読み方は[運用ガイド 6 節](operations.md#操作の記録と変更履歴)
   - 管理画面に入れないとき(Google のログインが直らないまま閉じたなど)は、同じ期間の記録を wrangler で読む。`<開いた時刻の ms>`・`<終わりの時刻の ms>` は控えた時刻を epoch ミリ秒にした値(例: `jq -n '"2026-01-01T00:00:00Z" | fromdate * 1000'`。終わりは上と同じく余裕を見て後にする)。出力にはメールアドレスが入るので、ファイルに残すなら所有者だけが開ける `deploy-backups/` に置く:

     ```bash
     pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select datetime(at / 1000, 'unixepoch') as at_utc, action, via, actor_email, api_key_name, target_type, target_label, detail_json from audit_events where at >= <開いた時刻の ms> and at < <終わりの時刻の ms> order by at, id"
     ```

   - **期間は自分で入れる**: 画面が記録から出す期間の初期値(非常用トークンでの最初の再設定リンクの発行から、次の「パスワードのログインを閉じた後の掃除」まで)は目安で、実際より狭くなりうる。再設定リンクを出す前の招待の受諾は入らず、閉じた後の掃除は消すものが無いと記録されないため。手順 1 と 4 で控えた、secret を置いた時刻と消した時刻で確かめる
   - **記録を見た後も、下の各一覧(メンバーの API キー・メンバー・招待・システム管理者・ロール)を目で確かめる**。招待の発行・受諾・パスワードでのログインと、API キーの発行の成功の行は、操作の後に別に書くので、D1 が一時的に失敗すると記録だけが欠けることがある(control のログに `audit: failed to record` が出る)
   - 開いているあいだも、パスワードでログインしたセッションからは API キーを発行できない(Google でログインし直せば発行できる)。ただし、開いているあいだに招待を受けて入った人は、自分の Google のアカウントでログインして鍵を発行できる。鍵はこの削除では消えないので、閉じた後は毎回、管理画面の各ワークスペースの「メンバーの API キー」(左メニューの下の「設定」の「ワークスペース」の見出しの下。管理者以上)の一覧で心当たりの無い鍵が無いかを確かめ、あれば失効させる([運用ガイド 6 節](operations.md#api-キー))。開いているあいだに受諾された招待で増えたメンバーと、発行された招待も残るので、メンバー一覧と招待一覧に心当たりの無いものが無いかを確かめる(次の 2 つの箇条)
   - 意図せず開いていた疑いがあるときは、閉じるだけでなく、心当たりのあるユーザーをメンバー一覧から外す。外した時点でその人のログイン状態も切れる(他のワークスペースにも所属している人は、そちらの資格が残るのでログイン状態も残る。必要なら各ワークスペースから外す)
   - まだ受けられていない招待に心当たりがあれば、招待一覧から取り消す。必要なら後から招待し直す
   - システム管理者が増えていないか(左メニューの下の「設定」→「システム管理者」の一覧)と、メンバーのロールが上がっていないか(メンバー一覧のロール)も確かめる。パスワードでログインしたセッションでも、招待・システム管理者への追加・ロールの変更はできる(Google のアカウントを失ったときに、別の Google のアカウントを招待してオーナーにするのが非常口の使い道なので、止めていない)。心当たりの無い人はシステム管理者から外し、上がったロールは戻す

なぜすぐ閉じるか:

- 開くのはオーナーのためだけではない。**開いているあいだは、パスワードを設定した人なら誰でもパスワードでログインできる**(パスワードの記録は、閉じた後の削除まで残る)
- トークンを置いているあいだは、メール + パスワードのログイン・招待リンクからのパスワードでのアカウント作成・メンバー画面の「リセットリンク」も開く(パスワードでログインしたセッションからの API キーの発行は開かない)
- **管理画面にログインしているあいだ、どのページにも**「非常用のパスワードログインが開いています」の帯が出る(ログイン前の画面には出ない)。トークンに期限は無いので、ログインして帯が出ていたら閉じ忘れを疑う
- 開いているあいだ、パスワードの試行を絞るのは補助的な制限だけになる。control の Rate Limiting binding(経路ごと・IP 単位で 30 回 / 10 秒。本番での効き方は限定的。[運用ガイド 7 節](operations.md#7-レート制限の実効))で、パスワードの総当たりを止める仕組みではない。使い終わったらすぐ閉じ、パスワードは推測しにくい長いものにする

## 9. 稼働の確認

### (a) 設置タグのファイルの応答ヘッダー

```bash
curl -sI https://<設置タグのホスト>/s/<siteId>.js | grep -i -e content-type -e cache-control -e nosniff
```

`content-type: text/javascript; charset=utf-8`、`cache-control: public, max-age=60`、`x-content-type-options: nosniff` の 3 つが返ること(配信専用の Worker の応答。ヘッダーは `wtt-static` の `_headers` が付ける)。`<設置タグのホスト>` は 2.9 の (4) のとおり。`max-age` が 60 でなければ 2.6 の Cache Rule を確認する。

### (b) Workers の指標(GraphQL Analytics API)

Workers の実行回数・失敗と、訪問者に返った 5xx を GraphQL Analytics API で取る。

用意するもの:

- **【人に依頼】** 稼働確認用のトークン `CF_ANALYTICS_TOKEN`。稼働確認は導入の数日後に行うので、0.5 の導入用トークンは期限切れになっている。権限 = **Account(アカウント)→ Account Analytics(アカウント分析)→ Read(読み取り)+ Zone(ゾーン)→ Analytics → Read(読み取り)**(対象ゾーンのみ、期限は短く。作り方は 0.5 の Cloudflare API トークンと同じ画面)。control に入れる `CF_USAGE_TOKEN` とは別物
- アカウント ID = `pnpm -C apps/control exec wrangler whoami`
- ゾーン ID = `wrangler login` の資格情報で API から取る(ダッシュボードを開かなくてよい):

```bash
ZONE=<ゾーン名>
CF_ZONE_ID=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=$ZONE" -H "Authorization: Bearer $(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)" | jq -r '.result[0].id')
echo "${#CF_ZONE_ID}"   # 期待: 32
```

```bash
# CF_ANALYTICS_TOKEN: Account Analytics: Read + Zone Analytics: Read のみのトークン / CF_ACCOUNT_ID: pnpm -C apps/control exec wrangler whoami の Account ID / CF_ZONE_ID: zone_name のゾーンの ID
# 半開区間 [SINCE, UNTIL)。UNTIL を過ぎた実時刻になってから実行する
G=https://api.cloudflare.com/client/v4/graphql; H=(-H "Authorization: Bearer $CF_ANALYTICS_TOKEN" -H 'content-type: application/json')
SINCE=<開始 UTC> UNTIL=<終了 UTC>

# (1) Worker の実行結果(日 × status。errors = 例外・資源超過などの実行失敗。Worker が自分で返す 5xx はここには出ない)
curl -sS $G "${H[@]}" -d '{"query":"query($acct: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: { accountTag: $acct }) { workersInvocationsAdaptive(limit: 500, filter: { scriptName_in: [\"wtt-edge\",\"wtt-control\"], datetime_geq: $since, datetime_lt: $until }) { dimensions { scriptName date status } sum { requests errors } } } } }","variables":{"acct":"'$CF_ACCOUNT_ID'","since":"'$SINCE'","until":"'$UNTIL'"}}' \
  > $SCRATCH/cf-inv.json
# 応答の検証(GraphQL は HTTP 200 でも本文の errors に失敗を返す)。失敗したら止める
jq -e '.errors == null and (.data.viewer.accounts | length) == 1 and (.data.viewer.accounts[0].workersInvocationsAdaptive | type) == "array"' $SCRATCH/cf-inv.json >/dev/null \
  || { echo "GraphQL error: $(jq -c .errors $SCRATCH/cf-inv.json)"; exit 1; }
# 検証を通ってから集計する
jq -c '.data.viewer.accounts[0].workersInvocationsAdaptive | map({s: .dimensions.scriptName, d: .dimensions.date, st: .dimensions.status, r: .sum.requests, e: .sum.errors}) | sort_by(.s, .d)' $SCRATCH/cf-inv.json

# (2) 訪問者に返った 5xx(ゾーン HTTP 分析。/s/* /v1/* /__ab/* のみ。1 日ずつ)
#     requestSource: "eyeball" で訪問者のリクエストに限定する(Cloudflare 内部の操作を 5xx として数えないため)
# Linux / Windows(Git Bash)は GNU date なので s=$(date -u -d "$SINCE + ${d} day" +%Y-%m-%dT%H:%M:%SZ) / e=$(date -u -d "$SINCE + $((d+1)) day" +%Y-%m-%dT%H:%M:%SZ) に読み替える
for d in $(seq 0 7); do
  s=$(date -u -j -v+${d}d -f %Y-%m-%dT%H:%M:%SZ "$SINCE" +%Y-%m-%dT%H:%M:%SZ); e=$(date -u -j -v+$((d+1))d -f %Y-%m-%dT%H:%M:%SZ "$SINCE" +%Y-%m-%dT%H:%M:%SZ)
  [ "$s" \< "$UNTIL" ] || break
  f=$SCRATCH/cf-zone-$(echo "$s" | cut -c1-10).json
  curl -sS $G "${H[@]}" -d '{"query":"query($zone: string!, $since: Time!, $until: Time!) { viewer { zones(filter: { zoneTag: $zone }) { httpRequestsAdaptiveGroups(limit: 100, filter: { datetime_geq: $since, datetime_lt: $until, edgeResponseStatus_geq: 500, requestSource: \"eyeball\", OR: [{clientRequestPath_like: \"/s/%\"},{clientRequestPath_like: \"/v1/%\"},{clientRequestPath_like: \"/__ab/%\"}] }) { count dimensions { clientRequestPath edgeResponseStatus } } } } }","variables":{"zone":"'$CF_ZONE_ID'","since":"'$s'","until":"'$e'"}}' \
    > "$f"
  jq -e '.errors == null and (.data.viewer.zones | length) == 1 and (.data.viewer.zones[0].httpRequestsAdaptiveGroups | type) == "array"' "$f" >/dev/null \
    || { echo "GraphQL error: $(jq -c .errors "$f")"; exit 1; }
  jq -c --arg d "$s" '{day: $d, rows: (.data.viewer.zones[0].httpRequestsAdaptiveGroups | map({p: .dimensions.clientRequestPath, st: .dimensions.edgeResponseStatus, c: .count}))}' "$f"
done
```

`$SCRATCH` は出力を置く作業ディレクトリ(実行前に自分で作って設定する)。

期待する形: (1) は Worker × 日 × `status`(`success` など)の `requests` / `errors`。(2) は日ごとに `rows: []`(5xx 無し)。

注意点:

- **GraphQL は HTTP 200 でも本文の `errors` に失敗を返す**ので、上のように必ず検査してから集計する
- 変数型は `string!`(小文字)と `Time!`
- Workers の invocations は 8 日以上遡れるが、**ゾーンの HTTP 分析は Free プランでは 1 クエリの時間範囲が 1 日まで**なので、上のように日ごとにループする
- `errors` は Worker の実行失敗(例外・リソース超過など)。Worker が意図して返す 4xx / 5xx はここに出ないので、訪問者から見た失敗は (2) で見る

使用量と上限の比べ方は運用ガイドの 11 節。

### (c) GA4 に届いていること

GA4 の DebugView で `ab_exposure` イベントが届くことを確認する。手順は[サイト導入ガイド 5 節](site-install.md#5-設置後の確認)、レポートの作り方は[分析ガイド](analytics.md)を参照。

## 10. バックアップ・復旧・撤去

ここでは、D1 を保護する手順(10.1〜10.3)と、導入全体を消す手順(10.4)を書く。

- 運用データの原本は **D1(`wtt-control`)**。KV の公開済み config と R2 の画像はそこから作り直せる(KV は公開で、R2 の画像は再アップロードで)
- Durable Objects の Visitor Profile(訪問者の割当と履歴)は列挙も複製もできないので、バックアップの対象にしない。失われても割当はハッシュで同じパターンに戻り、履歴条件だけが最初からになる
- 計測用のデータベース(`wtt-results`)にあるのは、テストの参加者ごとの記録(個票)だけ。サイト・エクスペリエンスの設定と、固定した結果の記録は `wtt-control` にある。`wtt-results` も Time Travel で過去の時点に戻せる(10.2 の手順 1・2 と、手順 5 の最初の行(戻すコマンド)の `wtt-control` を `wtt-results` に読み替える。凍結・非常口・人とアクセス権の一覧・セッションと API キーの手当て・KV の整合の手順は要らない。`wtt-results` にはその表が無い)
- 個票を消しても(保持期間の削除・同意の撤回による削除)、D1 の Time Travel の保持期間(Workers Free は 7 日、Workers Paid は 30 日)のあいだは過去の時点として残り、運用者が取った export(10.1)にも残る

### 10.1 手元バックアップ(`wrangler d1 export --remote`)

D1 の中身を 1 つの `.sql` ファイル(スキーマ + データ)として手元に落とす。**6.3 の更新前に必ず 1 回取り**、ほかに定期(週 1 を目安)と、サイト削除やメンバー整理のような取り消せない操作の前に取る。

次のコマンドは**リポジトリ直下で**流す。控えのファイルは 6.3 と同じく `$PWD/deploy-backups/` に絶対パスで書く(`pnpm -C apps/control` で動く wrangler に相対パスを渡すと、`apps/control` の下に書かれ、リポジトリ直下の `ls` や `grep` から見えないため)。

```bash
mkdir -p "$PWD/deploy-backups" && chmod 700 "$PWD/deploy-backups" \
  && WRANGLER_WRITE_LOGS=false pnpm -C apps/control exec wrangler d1 export wtt-control --remote --output "$PWD/deploy-backups/wtt-control-$(date -u +%Y%m%dT%H%M%SZ).sql" >/dev/null   # ディレクトリは所有者だけが開ける(前からあっても効く)。ダウンロード URL を標準出力にも wrangler のログのファイルにも残さない(下の注意)
ls -la "$PWD/deploy-backups/" | tail -3           # 期待: 今の日時のファイルがあり、サイズが 0 でない
grep -c 'CREATE TABLE' "$PWD"/deploy-backups/wtt-control-*.sql | tail -1   # 期待: 1 以上(テーブル定義が入っている)
```

- `deploy-backups/` は git に入らない(`.gitignore` 済み)。**ファイルにはメンバーのメールアドレス・パスワードと API キーのハッシュ・エクスペリエンスの内容と、ログイン中のセッションのトークンが入る**。トークンはそのまま使えば、その人としてログインできる(使われている間は同じトークンのまま期限が延びる)。そのため、ディレクトリは所有者だけが開ける権限にし(上の `chmod 700`)、リポジトリや共有フォルダに置かず、暗号化されたディスクやアクセス制御のある置き場に移す
- `wrangler d1 export` は、控えを 1 時間ダウンロードできる URL を標準出力に出す。URL を知っていれば誰でも D1 全体の控えを落とせるので、上のコマンドは標準出力を捨て、エージェントの会話の記録に残さない。wrangler は同じ内容を自分のログのファイル(`~/.wrangler/logs` など。macOS は `~/Library/Preferences/.wrangler/logs`)にも書くので、`WRANGLER_WRITE_LOGS=false` を付けて書かせない。失敗の文言は標準エラー出力に出るので、捨てずに読める
- エラー `Authentication error` / `code: 10000` → `wrangler login` のアカウントが違う。`pnpm -C apps/control exec wrangler whoami` で確認する
- Time Travel(10.2)は Cloudflare 側の保持期間を過ぎると遡れない(Workers Free は 7 日、Workers Paid は 30 日)ので、それより古い時点に戻す控えがこのファイル。読み戻し方は 10.3

### 10.2 D1 を過去の時点に戻す(Time Travel)

誤操作(エクスペリエンスやサイトの削除、メンバーを誤って外した)や失敗した更新のあと、D1 を**時刻を指定して**丸ごと戻す。Cloudflare 側の機能で、事前準備は要らない。保持期間は 10.1 のとおり。

1. **今の状態の控え**を取る(戻したあと「やはり戻す前に戻したい」ときのため)。10.1 の export に加え、今の bookmark も記録する:

```bash
pnpm -C apps/control exec wrangler d1 time-travel info wtt-control --json | jq -r '.bookmark'   # 期待: 英数字の文字列。deploy-log.md に書き留める
```

2. 戻す時刻(UTC、RFC3339)を決め、その時点の bookmark を引く。時刻は「壊す操作の直前」にする:

```bash
pnpm -C apps/control exec wrangler d1 time-travel info wtt-control --timestamp 2026-01-01T00:00:00Z --json | jq -r '.bookmark'
```

期待: bookmark が返る。`timestamp is out of range` を含むエラー → 保持期間より前なので、10.3(手元バックアップからの読み戻し)に切り替える。

3. 6.6 の凍結を入れ、1 分待つ(戻す途中の書き込みは失われる)。非常口(8 節)が開いていれば、ここで閉じる。D1 を戻すと、パスワードの記録と再設定のリンクも戻った時点のものに戻るため。閉じておけば、戻ったパスワードの記録は、凍結を外した後の最初の定期処理で消える。戻した後も非常口が要る(Google でログインできない)なら、凍結を外した後に 8 節を最初からやり直す(新しいトークンと再設定のリンクを作る):

```bash
curl -sS "<control URL>/login-options"   # "passwordLogin":true なら開いている → 次の行で閉じる
pnpm -C apps/control exec wrangler secret delete AB_BREAK_GLASS_TOKEN   # 開いているときだけ。閉じた後に上の curl が "passwordLogin":false を返すことを確かめる
```

4. **人とアクセス権の一覧と、操作の記録を控える**。D1 を戻すと、戻した時点より後に外したメンバー・下げたロール・取り消した招待・システム管理者から外したことが、戻した時点の状態に戻る。一覧そのものには変更の時刻が残らないので、戻す前と戻した後の一覧を比べて見つける(手順 6)。1 行が 1 件で、列は 種類(`member` = メンバー / `invitation` = 受諾待ちの招待 / `instance_admin` = システム管理者)・メールアドレス・ワークスペースの名前・ロール・ワークスペースの ID の順。ワークスペースの名前は重なることがあるので、ID も控える。ファイルにはメールアドレスが入るので、10.1 の控えと同じく所有者だけが開ける `deploy-backups/` に置く。下の 2 行(SQL と関数の定義)は、手順 6・7 でも同じシェルで使う。別のシェルで続けるときは、この 2 行を流し直す:

```bash
ACCESS_SQL="select 'member' as kind, lower(u.email) as email, o.name as workspace, m.role as role, o.id as workspace_id from member m join \"user\" u on u.id = m.\"userId\" join organization o on o.id = m.\"organizationId\" union all select 'invitation', lower(i.email), o.name, coalesce(i.role, ''), o.id from invitation i join organization o on o.id = i.\"organizationId\" where i.status = 'pending' union all select 'instance_admin', lower(u.email), '', '', '' from instance_admins a join \"user\" u on u.id = a.user_id order by kind, email, workspace_id"
access_list() { pnpm -C apps/control exec wrangler d1 execute "$1" --remote --json --command "$ACCESS_SQL" | jq -r '.[0].results[] | [.kind, .email, .workspace, .role, .workspace_id] | @tsv'; }
mkdir -p "$PWD/deploy-backups" && chmod 700 "$PWD/deploy-backups" && access_list wtt-control > "$PWD/deploy-backups/access-before.tsv" && test -s "$PWD/deploy-backups/access-before.tsv" && wc -l < "$PWD/deploy-backups/access-before.tsv"   # 期待: 1 以上の数(何も出ない・エラーなら取れていない。先へ進まない)
```

続けて、戻した時点より後の操作の記録を控える。操作の記録(運用ガイド 6 節)には誰がいつ変えたかが残るが、D1 を戻すと記録も戻した時点のものに戻り、その後の記録は消えるため。`<戻す時刻の ms>` は手順 2 の時刻を epoch ミリ秒にした値(手順 6 の `<戻した時刻の ms>` と同じ。例: `jq -n '"2026-01-01T00:00:00Z" | fromdate * 1000'`)。手順 1 の控え(export)にも入っているが、戻すと消える分だけを読みやすい形で残し、手順 6 で何が戻ったかを確かめるのに使う。戻したデータベースには入れ直さない(戻して取り消された操作の記録になるため)。メールアドレスが入るので `deploy-backups/` に置く:

```bash
pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --json --command "select * from audit_events where at >= <戻す時刻の ms> order by id" | jq '.[0].results' > "$PWD/deploy-backups/audit-events-before.json" && test -s "$PWD/deploy-backups/audit-events-before.json" && jq length "$PWD/deploy-backups/audit-events-before.json"   # 期待: 0 以上の数(エラーなら取れていない。先へ進まない)
```

5. **戻す**。戻すコマンドに、凍結の入れ直し・全員のセッションの削除・すべての API キーの失効を `&&` でつなぎ、1 回で実行する。戻した直後から、この 3 つが済むまでの間を短くし、順番を崩さないため:

```bash
pnpm -C apps/control exec wrangler d1 time-travel restore wtt-control --bookmark <手順 2 の bookmark> \
  && pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "<6.6 の「入れる」の SQL>" \
  && pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "delete from session" \
  && pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "insert or ignore into apikey_revocations (key_id, revoked_at, revoked_by) select id, CAST(strftime('%s','now') AS INTEGER) * 1000, null from apikey; update apikey set enabled = 0"
```

`y` で確認する。期待: `Database wtt-control restored back to bookmark …` と、新しい bookmark。続く 3 つのコマンドもエラーなく終わる。

- **凍結の入れ直し**: 戻す時刻が凍結を入れた時刻より前なら、戻したデータベースには凍結が入っていないため
- **セッションの削除**: 戻すと、戻した時点で有効だったログイン状態(後でログアウトや失効で消したものを含む)が生き返るため。全員がログインし直す
- **すべての API キーの失効**: 戻すと失効の記録も消え、漏れたために失効させた鍵がまた使えるようになるため。鍵を選ばずに全部失効させるのは、戻したデータベースには、どの鍵を信用してよいかを決める材料が無いため。戻した時点より後に発行した鍵はどのみち消えていて、発行し直しは持ち主が自分でできる。エージェントの鍵(5.1 の `.env.agent`)も発行し直す

期待と違うとき:

- 戻してから入れ直すまでの数秒は凍結が有効でない → その間に保存された変更が無かったかは、手順 6 の確認の SQL(戻した時刻より後の書き込みを数える)で見る
- 続く 3 つのどれかが `no such table` で失敗する(戻す時刻が、その表を作ったマイグレーションより前)→ そこから後ろのコマンドは動いていない。`pnpm -C apps/control d1:migrate:remote` でマイグレーションを当ててから、失敗したコマンドから後ろを同じ順で流し直す

6. **凍結中の確認と直し**:

- **戻した後に書き込みが入っていないかの確認**(手順 5 の数秒の間): 次がすべて 0 であること。0 でなければ、その行の内容を見て意図したものか確かめる。`<戻した時刻の ms>` は、手順 2 の時刻を epoch ミリ秒にした値(例: `jq -n '"2026-01-01T00:00:00Z" | fromdate * 1000'` が `1767225600000` を返す)
  - `pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "select (select count(*) from publishes where created_at > <戻した時刻の ms>) as publishes, (select count(*) from experiments where updated_at > <戻した時刻の ms>) as experiments, (select count(*) from changes where updated_at > <戻した時刻の ms>) as changes"`
- **人とアクセス権の一覧を比べる**。手順 4 と同じ形の一覧を戻した後のデータベースから取り、比べる。比べた結果も `deploy-backups/` に残し、凍結を外した後に見直せるようにする:

```bash
access_list wtt-control > "$PWD/deploy-backups/access-after.tsv" && test -s "$PWD/deploy-backups/access-after.tsv" && { diff "$PWD/deploy-backups/access-before.tsv" "$PWD/deploy-backups/access-after.tsv" > "$PWD/deploy-backups/access-diff.txt"; cat "$PWD/deploy-backups/access-diff.txt"; }   # 何も出なければ、人とアクセス権は戻す前と同じ
```

`<` で始まる行は戻すと消えたもの、`>` で始まる行は戻すと生き返ったもの。誰がいつ変えたものかは、手順 4 で控えた `audit-events-before.json`(戻した時点より後の操作の記録。`action` が操作、`actor_email` が操作した人、`target_label` が対象)で確かめられる。行の形ごとに次のように扱う:

| diff の行 | 意味 | すること | いつ |
|---|---|---|---|
| `>` の `member` だけ | 外した人が生き返った | 外したままにするなら、下の SQL で外す | 凍結中 |
| `>` の `invitation` だけ | 取り消した招待が戻った | 取り消したままにするなら、下の SQL で取り消す | 凍結中 |
| 同じ人・同じワークスペースの `member` が `<` と `>` の組 | ロールが戻った | 管理画面でロールを直す | 凍結を外した直後(手順 7) |
| `>` の `instance_admin` | 外したシステム管理者が戻った | 管理画面でシステム管理者から外し直す。その人の `member` の行(すべてのワークスペースのオーナー)は、外し直すと外したときの形に戻るので、別には扱わない | 凍結を外した直後(手順 7) |
| `<` の行だけ | 戻した時点より後に足したものが消えた | 必要なら招待・昇格し直す | 凍結を外した後(手順 7) |

- ワークスペースの ID とメールアドレスは、一覧の行の値をそのまま使う(メールアドレスは小文字にそろえてある)
- 外す(`<ID>`・`<メールアドレス>` を差し替える): `pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "delete from member where \"organizationId\" = '<ID>' and \"userId\" = (select id from \"user\" where lower(email) = '<メールアドレス>') and \"userId\" not in (select user_id from instance_admins)"`。システム管理者は条件で除いてあり、この SQL では外れない。システム管理者はすべてのワークスペースのオーナーなので、この SQL でオーナーが 1 人もいないワークスペースはできない
- 取り消す: `pnpm -C apps/control exec wrangler d1 execute wtt-control --remote --command "update invitation set status = 'canceled' where status = 'pending' and \"organizationId\" = '<ID>' and lower(email) = '<メールアドレス>'"`
- 誤って外した人を戻すために D1 を戻したときは、その人の `>` の行はそのままにする(外さない)。それ以外で迷ったら、外したままにする(後から招待し直せる)
- 直した後に、上の比べるブロックのファイル名の `access-after`・`access-diff` を `access-fixed`・`access-diff-fixed` に変えてもう一度流し(最初の比べた結果を残すため)、`>` の行が意図したものだけになったことを確かめる
- エージェントが行う場合: 比べた結果を、誰が・どのワークスペースで・何が戻ったかの言葉にして人に見せ、外したまま(取り消したまま)にするかを 1 回だけ聞いて、答えのとおりに上の SQL を流す。管理画面で直すもの(ロール・システム管理者)は、凍結を外した直後に、人とワークスペースを名指しして **【人に依頼】** で頼む。人とアクセス権の書き込みは管理画面のログインでしかできず、エージェントの API キーではできないため(鍵も手順 5 で失効している)

**未適用のマイグレーションを当てる**(凍結の中で、下の「画像の中身の確かめ」の前に必ず行う)。戻した時点が、今の control が前提にするデータベースの更新より前だと、戻したデータベースには新しい表・列が無い。手順 5 の 3 つのコマンドが `no such table` で止まらなくても(その 3 つの表は古くからある)、画像の一覧の列などが無いことがある。そのままでは下の道具と、凍結を外した後の control が動かない:

```bash
pnpm -C apps/control d1:migrate:remote   # 期待: 当てたマイグレーションの一覧か、"No migrations to apply"
```

期待と違うとき: エラーで止まる → 出力を `deploy-log.md` に残して作業を止め、人に報告する(凍結は入れたままにする)。

**画像の中身の確かめ**(R2 を使う導入だけ。`asset_public_base: none` の導入では飛ばす。道具も R2 の binding が無ければ「R2 を使っていない導入です」と出して何もせずに終わる)。D1 を戻すと、戻した時点より後に削除した画像の一覧の行(と、その画像を指す変更・公開した設定)は戻るが、R2 の画像のファイルは戻らない。公開の確かめは一覧に行があれば成功するので、そのままでは、ファイルの無い画像を指す設定を公開できてしまう。道具 `tools/asset-r2-check/` で一覧の行と R2 のファイルを比べ、ファイルの無い画像に削除の途中の印を付ける。印の付いた画像を指す公開は断られ、定期処理がその行を消す。凍結の中で、リポジトリ直下で行う:

(1) **トークンとアカウント ID**。道具は R2 のファイルの一覧を Cloudflare の API で読む(wrangler に一覧のコマンドが無いため)。API のトークンは環境変数 `CLOUDFLARE_API_TOKEN`、アカウント ID は `CLOUDFLARE_ACCOUNT_ID` から読む。トークンは、下の関数がサブシェルの中で `wrangler login` のトークンを入れる。値は画面にも会話にも出ず、関数の外のシェルにも残らない。`CLOUDFLARE_ACCOUNT_ID` は、0.4 で固定してあればその値を使い、無ければ道具が `apps/control/wrangler.jsonc` の `vars.CF_ACCOUNT_ID`(3.4)を読む:

```bash
r2check() ( [ -n "$CLOUDFLARE_API_TOKEN" ] || export CLOUDFLARE_API_TOKEN="$(pnpm -C apps/control exec wrangler auth token --json 2>/dev/null | jq -r .token)"; node tools/asset-r2-check/check.mjs "$@" )
[ -n "$CLOUDFLARE_ACCOUNT_ID" ] && echo account_id=present || grep -cE '"CF_ACCOUNT_ID": "[0-9a-f]{32}"' apps/control/wrangler.jsonc   # 期待: account_id=present か 1
```

`0` が出たら、アカウント ID がどちらにも無い。0.4 のとおり `CLOUDFLARE_ACCOUNT_ID` を設定してから先へ進む。

関数 `r2check` はシェルの中にだけある。別のシェルで続けるとき(エージェントの Bash のように、コマンドごとにシェルの状態を持ち越さないときも)は、下の (2)・(4) のコマンドの前に、この (1) のブロックを流し直す(同じ 1 回の実行の中に並べてもよい)。

(2) **見るだけで流す**(D1 に書かない)。出力は手順 8 で使うので `deploy-backups/` に控える。`r2check` が無いシェルでは、先に (1) を流す:

```bash
r2check --db wtt-control | tee "$PWD/deploy-backups/asset-r2-check.txt"
```

期待: 1 行目に確かめた画像の数と D1・バケットの名前、続いて「R2 から読んだキー: N 件(M ページ)」と「R2 に中身の無い画像: K 件」。K が 1 以上なら、画像ごとにサイトの ID・画像の ID・削除待ちか・配信中の設定でその画像を使っているサイトが出て、最後に「配信中の設定でこれらの画像を使っているサイト」が出る。道具は、一覧に無かった画像を 1 枚ずつ確かめ直し、在ったものは対象から外す(「確かめ直すと在った画像」の行)。

期待と違うとき:

- 「R2 の一覧を読めませんでした(HTTP 403 …)」(か 401)→ `wrangler login` のトークンでは R2 の一覧を読めない。下の「別のトークンを使うとき」
- 「CLOUDFLARE_API_TOKEN が設定されていません」→ `wrangler login` が切れている。0.4 のログインをやり直す
- 「D1 の assets に、画像の削除の印の列(deleted_at・purge_marked_at)がありません」→ 上の「未適用のマイグレーションを当てる」が済んでいない。当ててから (2) を流し直す

(3) **人が件数を照らす**。**【人に依頼】** 最初に流したときは、`--apply` の前に、出力の「R2 から読んだキー: N 件」が、R2 のダッシュボード(Storage & databases(ストレージとデータベース)→ R2 Object Storage(R2 オブジェクトストレージ)→ `wtt-assets`)に出るオブジェクトの数と合うかを人に見てもらう(オブジェクトの数の欄の表示の名前は未確認)。道具が API の応答を最後まで読めているかを確かめるため。道具が読むのは `sites/` で始まるキーだけなので、バケットにこの製品のほかのファイルを置いていなければ一致する。合わなければ `--apply` に進まず、出力を `deploy-log.md` に残して作業を止め、人に報告する

(4) **K が 1 以上なら、人に見せてから印を付ける**。エージェントは、出た画像と「配信中の設定でこれらの画像を使っているサイト」を人に見せてから流す。`r2check` が無いシェルでは、先に (1) を流す:

```bash
r2check --db wtt-control --apply   # 期待: 「印を付けた画像: K 件(対象 K 件)」。凍結が入っていなければ何も書かずに止まる
```

K が 0 なら、この段はここで終わる。

**別のトークンを使うとき**(`wrangler login` のトークンで 403 になったときだけ。0.5 の `deploy-secrets.env` と同じ流儀で、値を会話・コマンドに出さない):

- エージェントが `deploy-secrets.env` に `CLOUDFLARE_API_TOKEN=` の行を値は空で用意し、エディタで開く(開き方は 0.5 の「`deploy-secrets.env` の作り方」)。ファイルが無ければこの 1 行だけで作り、0.5 のファイルが残っていれば、中の値を消さずに行を末尾に足す:

```bash
[ -e deploy-secrets.env ] || (umask 077 && : > deploy-secrets.env); chmod 600 deploy-secrets.env
[ -z "$(tail -c1 deploy-secrets.env)" ] || echo >> deploy-secrets.env   # 末尾に改行が無ければ足す(足す行が前の値につながらないように)
grep -q '^CLOUDFLARE_API_TOKEN=' deploy-secrets.env || printf 'CLOUDFLARE_API_TOKEN=\n' >> deploy-secrets.env
```

- **【人に依頼】** API トークンを作り、値を `CLOUDFLARE_API_TOKEN=` の右に貼って保存してもらう。画面: My Profile(マイ プロフィール)→ API Tokens(API トークン)→ Create Token(トークンを作成する)→ Custom token(カスタム トークン)の Get started(始める)。Token name(トークン名)= `wtt-restore-<識別子>`(識別子は 0.5 の「Cloudflare の API トークンの名前」と同じ)。Permissions(権限)= Account(アカウント)→ Workers R2 Storage → Read(読み取り)と、Account(アカウント)→ D1 → Edit(編集)(Workers R2 Storage の日本語の表示は未確認)。D1 の編集も要るのは、道具の中で動く wrangler も、`CLOUDFLARE_API_TOKEN` があれば `wrangler login` より優先してそのトークンを使い、D1 を読み書きするため。Account Resources(アカウント リソース)= 導入先のアカウントだけ。期限 = 翌日(TTL の Select time range(時間範囲を選択)の終了日)
- 読み込んで、値を表示せずに確かめ、上の (2) から流し直す:

```bash
set -a; eval "$(tr -d '\r' < deploy-secrets.env)"; set +a
[ -n "$CLOUDFLARE_API_TOKEN" ] && echo cloudflare_api_token=present || echo cloudflare_api_token=missing   # 期待: present(missing なら人に記入を頼み直す)
```

- 終わったら、環境変数を消し、ファイルからは足した `CLOUDFLARE_API_TOKEN=` の行だけを消す(0.5 の値が残っていれば、それは消さない。ほかの行が無ければファイルごと消す)。環境変数を残したままにすると、この後の wrangler のコマンドもこのトークンを使い、D1 以外の操作(10.3 の `wrangler deploy` など)が権限のエラーになるため:

```bash
unset CLOUDFLARE_API_TOKEN
sed -i.bak '/^CLOUDFLARE_API_TOKEN=/d' deploy-secrets.env && rm -f deploy-secrets.env.bak   # .bak にもトークンが入るので、すぐ消す
[ -s deploy-secrets.env ] || rm deploy-secrets.env
```

7. **凍結を外し、すぐに管理画面で直す**。確認と直しが済んでから、6.6 の「外す」で凍結を外す。外した後の最初の作業として、手順 6 の表で「凍結を外した直後」の行(ロールを直す・システム管理者から外し直す)を管理画面で行う。続けて、「`<` の行だけ」のうち要るもの(招待・昇格し直す)を行う。全員がログインし直し、API キーを使う人とエージェントは鍵を発行し直す

8. **戻したあとの整合**(凍結を外した後):

- 公開し直す作業は凍結を外してから行う(凍結中は公開できない)
- **KV の公開済み config は D1 と一緒には戻らない**。戻した時点より後に公開していたサイトは、管理画面でそのサイトを開き公開し直す(config が D1 の内容から作り直される)。逆に「戻した時点より後に公開した内容を配り続けたい」場合は公開しない
- **設置タグの配信ファイルの記録も D1 と一緒には戻らない**。配信を管理する Worker は、D1 より新しい世代を配ったことを覚えているので、世代を進めずに公開し直すと依頼が「古い世代」として捨てられ、**訪問者には戻す前のタグが配られ続ける**(公開の結果の `staticDeploy` は `pending` になる)。**例外: 手順 6 の画像の中身の確かめで「配信中の設定でこれらの画像を使っているサイト」が出たときは、そのサイトを先に直す。** 凍結を外したら、下の全サイトの作り直しの前に、そのサイトだけ、ファイルの無い画像を指す変更の画像を選び直して(か、その変更を外して)公開し直す。作り直しは保存してある公開内容をそのまま配り直すので、先に作り直すと、ファイルの無い画像を指す内容がまた配られるため。この公開は、印の付いた画像を指す変更が残っていると断られる(失敗の理由 `asset_missing`。公開の確認の画面に、残っている画像とその変更の場所が一覧で出る)。原因の変更が配信中のエクスペリエンスにあってすぐに直せないときは、そのエクスペリエンスを一時停止してもよい(一時停止・終了は画像を確かめずに成功し、そのエクスペリエンスは配信から外れる。ただし、ほかの配信中のエクスペリエンスにファイルの無い画像を指す変更が残っていれば、それは配られる)。この公開の結果の `staticDeploy` は `pending` のままのことがあるが、続く全サイトの作り直しで配られる。それまで、そのサイトの「配信ファイルを作り直す」(サイトごとの作り直し)は押さない。直し終える(公開が成功する)まで、そのサイトのサイト設定も保存しない(サイト設定の保存も配信ファイルの更新を依頼するので、ファイルの無い画像を指す内容が配られることがある)。そのサイトを直し終えてから、次の全サイトの作り直しを行う。凍結を外したら、公開し直す前に(例外のサイトは上の公開の後に)、管理画面の左メニューの下の「設定」→「配信ファイル」(「システム」の見出しの下)で「公開中の全サイトの配信ファイルを作り直す」を押す(システム管理者が管理画面から行う。エージェントは、サイトごとの `POST /sites/<siteId>/static/redeploy` を公開中のサイトの数だけ呼ぶ)。この操作は、各サイトの世代を、配信を管理する Worker が覚えている世代より先に進めてから、今の公開内容で作り直す。凍結中は作り直せない(凍結を外してから行う)。データベースでは未公開か、データベースに無いのに配信ファイルが残っているサイト(初めての公開より前や、サイトを作る前の時点に戻した場合)も、この操作でファイルが消える(データベースでは未公開のサイトは、サイトごとの作り直しでも消える。データベースに無いサイトは、サイトごとの作り直しでは消せず、この操作でだけ消える)。配信ファイルの画面の「記録が食い違っているサイト」が「なし」になり、`curl -sS "https://<設置タグのホスト>/s/<siteId>.js" | head -c 200`(`<設置タグのホスト>` は 2.9 の (4))に今の公開内容が出ることを確かめる。

  control の定期処理は、この向きの食い違いを自動では直さない(戻した内容で上書きしてよいかは人が決めるため)。食い違いがあるかは、配信ファイルの画面の「記録が食い違っているサイト」か、`GET /static/status` の `mismatchSites` で確かめる。配信ファイルの画面は開いたときの状態を出す。システム管理者の画面の上部の帯は、画面を開き直したとき・タブを前に戻したときか、5 分ごとの取り直しのときに出る。サイトの画面の警告「このサイトの配信ファイルの記録が食い違っています」(と `GET /sites/<siteId>` の `staticMismatch`)は、定期処理がそのサイトに印を付けた後に出る。ただし定期処理が印を付けるのは、公開中のサイトで、配信を管理する Worker の記録が通常の更新の世代で先に進んでいるときだけ。それ以外の形の食い違い(データベースでは未公開のサイト・データベースに無いサイトなど)では、サイトの警告も `staticMismatch` も出ないことがある。また、同じ世代で中身が食い違うかの比較は、ID の順に先頭の 25 サイトまで(公開中の設定の合計が大きいときはそれより少ない)しか行わないので、その形の食い違いが多いと、画面の一覧と `mismatchSites` に出ないサイトが残りうる。D1 を戻した後は、一覧が「なし」でも上の「公開中の全サイトの配信ファイルを作り直す」を行う
- **R2 の画像のファイルは D1 と一緒には戻らない**。戻した時点より後にアップロードした画像は R2 に残るが、D1 の画像の一覧からは消える(実害は無い。気になれば R2 のダッシュボードで消す)。戻した時点より後に削除した画像は、D1 の一覧には戻るが、R2 のファイルは戻らない。手順 6 の「画像の中身の確かめ」で見つけて削除の途中の印を付け、配信中の設定がその画像を指すサイトは、上の配信ファイルの箇条の例外のとおり、画像を選び直して公開し直す
- **計測用のデータベース(`wtt-results`)の個票は、戻した時点より後に開始したテストの分が消される**。そのテストのエクスペリエンスの行は戻した `wtt-control` に無いので、個票は「対応するテストの無い記録」とみなされ、毎日 UTC 23 時台に動く Cron が、戻した後の最初の UTC 23 時台から順に消す(1 日に調べる件数に上限があるので、消し終わるまで数日かかることがある)。個票が要るときは、戻す前に `wtt-results` の export を取る(10.1 の `wtt-control` を `wtt-results` に読み替える)。消えたあとは、`wtt-results` の Time Travel の保持期間(10.1 のとおり)のうちなら 10.2 の手順で戻せるが、それを過ぎると取り戻せない。また、`wtt-results` を Time Travel で戻しても、`wtt-control` に対応する行が無ければ、また対応するテストの無い記録として消される。戻したら、次の UTC 23 時台より前に export を取る
- 確認: `curl -sS -o /dev/null -w '%{http_code}\n' "<control URL>/llms.txt"` が 200、管理画面にログインしてサイト一覧が期待どおり

### 10.3 手元バックアップから読み戻す

Time Travel の保持期間より前に戻すとき、または D1 を消してしまったとき。export の `.sql` は `CREATE TABLE` を含むので、**今の DB に上書きせず、空の DB を新しく作ってそこに読み込み、control の向き先を切り替える**(切り替える前に中身を確かめられる)。

今のデータベースが残っているなら、読み戻しの前に、今の `wtt-control` に 10.2 の手順 3・4 を行う(6.6 の凍結を入れる・非常口が開いていれば閉じる・人とアクセス権の一覧を `access-before.tsv` に控える)。凍結は、切り替えの前に入った書き込みが新しいデータベースに入らないようにするため。今のデータベースが無いときは一覧を控えられないので、切り替えの手順 4 では、読み戻した一覧を人に見せて確かめる。

次のコマンドも 10.1 と同じく**リポジトリ直下で**流し、控えのファイルは絶対パス(`$PWD/deploy-backups/…`)で渡す。

```bash
pnpm -C apps/control exec wrangler d1 create wtt-control-restore                              # 期待: database_id が出る
pnpm -C apps/control exec wrangler d1 execute wtt-control-restore --remote --file "$PWD/deploy-backups/<戻したいファイル>.sql" -y
pnpm -C apps/control exec wrangler d1 execute wtt-control-restore --remote --command "select count(*) as sites from sites; select count(*) as users from user" --json   # 期待: 元の件数
```

期待と違うとき: 読み込みが `table … already exists` で止まる → 新しい DB を使っていない。`d1 create` からやり直す。

切り替え:

1. `apps/control/wrangler.jsonc` の `d1_databases[0].database_id` を新しい id に書き換える(`database_name` も `wtt-control-restore` に)
2. `pnpm -C apps/control exec wrangler d1 migrations apply wtt-control-restore --remote`(export 時点より新しいマイグレーションがあれば当たる。無ければ `No migrations to apply`。`pnpm -C apps/control d1:migrate:remote` は `wtt-control` の名前で探すので、名前を変えた後は使えない)
3. `wtt-control-restore` に、凍結・全員のセッションの削除・すべての API キーの失効を流す(10.2 の手順 5 の、戻すコマンドの後ろの 3 つと同じ。理由も同じ)。control はまだ `wtt-control-restore` を向いていないので、凍結の後に待つ時間は要らない:

```bash
pnpm -C apps/control exec wrangler d1 execute wtt-control-restore --remote --command "<6.6 の「入れる」の SQL>" \
  && pnpm -C apps/control exec wrangler d1 execute wtt-control-restore --remote --command "delete from session" \
  && pnpm -C apps/control exec wrangler d1 execute wtt-control-restore --remote --command "insert or ignore into apikey_revocations (key_id, revoked_at, revoked_by) select id, CAST(strftime('%s','now') AS INTEGER) * 1000, null from apikey; update apikey set enabled = 0"
```

4. 10.2 の手順 6 の「人とアクセス権の一覧を比べる」と、表のうち「凍結中」の行を、`wtt-control-restore` に対して行う(`access_list wtt-control-restore` で `access-after.tsv` を取り、外す・取り消す SQL の `wtt-control` も `wtt-control-restore` に読み替える)。`ACCESS_SQL` と `access_list` が無いシェルでは、10.2 の手順 4 の 2 行を先に流す。書き込みが入っていないかの確認は要らない(control がまだ向いていないため)。続けて、10.2 の手順 6 の「画像の中身の確かめ」を、コマンドの `--db wtt-control` を `--db wtt-control-restore` に読み替えて行う(手順 3 で凍結を入れてあり、control はまだ向いていないので、凍結の後に待つ時間は要らない。関数 `r2check` が無いシェルでは、10.2 の手順 6 の (1) のブロックを先に流す)
5. `pnpm -C apps/control exec wrangler deploy`
6. 切り替えた後、確認が済んでから 6.6 の「外す」で外す(コマンドの `wtt-control` を `wtt-control-restore` に読み替える)。以後は 10.2 の手順 7(管理画面での直し・ログインと鍵の発行し直し)と手順 8(全サイトの配信ファイルの作り直し・公開し直し。手順 4 の後の画像の中身の確かめでサイトが出たときは、手順 8 の例外の順で、そのサイトの公開し直しを全サイトの作り直しより先に行う)。export を取った時点より後に開始したテストの個票は、10.2 の手順 8 のとおり `wtt-results` から消される(`wtt-results` は読み戻さないので、必要なら先に `wtt-results` の export を取る。`wtt-results` を Time Travel で戻しても、`wtt-control` に対応する行が無ければ、また対応するテストの無い記録として消される。戻したら、次の UTC 23 時台より前に export を取る)
7. 元の DB は問題が無いと分かってから `wrangler d1 delete wtt-control` で消す

### 10.4 撤去(導入全体を消す)

Cloudflare アカウントから本ツールをすべて取り除く。**取り消せない**ので、必要なら先に 10.1 の export を取る。順序は「訪問者に見える側から」= 設置サイトのタグ → admin → control → edge → データ → ゾーンのルール → 外部の資格情報(edge は、edge の Durable Object を参照する control の後に消す)。

1. **【人が行う】設置サイトからタグを外す**(GTM のタグを一時停止して公開、または `<script src=".../s/<siteId>.js">` を削除)。先に Worker を消すと、タグが残ったページで設置タグのファイルが 404 / 522 になる(ページ自体は壊れない: 読み込みに失敗しても元のページが出るだけ)
2. Worker を 5 つ消す。Route・Custom Domain・Durable Objects(Visitor Profile の全データ)は Worker と一緒に消える。`wtt-deployer` を消すと設置タグのファイルの作り直しが止まるので、`wtt-static` より後に消す:

```bash
pnpm -C apps/admin exec wrangler delete --config dist/server/wrangler.json    # wtt-admin(dist が無ければ先に pnpm -C apps/admin build。または --config を付けず wrangler delete wtt-admin)
pnpm -C apps/control exec wrangler delete                     # wtt-control。secret(BETTER_AUTH_SECRET など)も一緒に消える。deploy 用の Worker と edge の Durable Object への binding もこれで外れる
pnpm -C apps/edge exec wrangler delete                        # wtt-edge。Route と DO(結果の記録の予算を含む)と secret(RESULTS_VISITOR_KEY)を含む
pnpm -C apps/deployer exec wrangler delete wtt-static         # 配信専用の Worker。設置タグのファイルと Route も消える(`wrangler deploy` では作っていない Worker なので、名前を明示する)
pnpm -C apps/deployer exec wrangler delete                    # wtt-deployer。secret(CF_DEPLOY_TOKEN)と Durable Objects も一緒に消える
```

それぞれ `y` で確認する。期待: `Successfully deleted <name>`。DO を持つ edge で `--force` を求められたら、付けて再実行する(edge の Durable Object を参照する control は先に消してある)。

`custom-domain` の構成では、edge の Custom Domain を消した後に、`<edge のホスト>` の DNS レコードが残っていないことを確かめる。API で確かめるなら 2.3 のホストの空きの確認の 1(`CF_TOKEN` が期限切れなら使えない)で `n` が 0。**【人に依頼】** ダッシュボードで確かめるなら、対象ゾーンの DNS → Records(レコード)に `<edge のホスト>` の行が無いこと。残っていれば、そのレコードを消してもらう。

3. データを消す:

```bash
pnpm -C apps/control exec wrangler d1 delete wtt-control                                  # D1(Time Travel の履歴ごと消える)
pnpm -C apps/edge exec wrangler d1 delete wtt-results                                     # 計測用のデータベース(個票。Time Travel の履歴ごと消える)
pnpm -C apps/control exec wrangler kv namespace delete --namespace-id <apps/edge/wrangler.jsonc の kv_namespaces[0].id>   # KV
pnpm -C apps/control exec wrangler r2 bucket delete wtt-assets                            # R2(R2 を使っていた構成のみ)
```

期待と違うとき: `r2 bucket delete` が `bucket is not empty` で失敗する → 中身を先に消す。**【人に依頼】** ダッシュボードの Storage & databases(ストレージとデータベース)→ R2 Object Storage(R2 オブジェクトストレージ)→ `wtt-assets` → Settings(設定)タブの Danger Zone(危険ゾーン)→ Empty Bucket(バケットを空にする)。R2 のカスタムドメインを接続していた場合は、同じタブの Custom Domains(カスタム ドメイン)で接続を外す。

4. ゾーンに置いたルールを消す(ゾーンのある構成(`edge_address` が `route` か `custom-domain`)のみ)。2.6 / 2.7 の `$H` / `$ZID` と同じ準備で:

```bash
# Cache Rule: 2.6 の確認コマンドで id を引き、本ツールの式(/s/ と /v1/ を含む)のルールだけ消す
curl -sS -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZID/rulesets/$RID/rules/<rule id>" -H "$H" | jq '{success, errors}'
# WAF Rate Limiting Rule: 2.7 の確認コマンドで id を引き、同じように消す(phase は http_ratelimit)
```

期待: `"success": true`。ゾーンに他のルールがある場合、ruleset 自体は消さない(entrypoint を DELETE すると他のルールも消える)。ダッシュボードで消すなら、対象ゾーンの Caching → Cache Rules / Security(セキュリティ)→ Security rules(セキュリティ ルール)の該当行。

`custom-domain` の構成で、別のドメインのゾーンとアカウントを残すときは、Custom Domain のために発行された証明書が残っていれば片づける。この証明書は Custom Domain を消しても残る。ただし、ゾーンの既定の証明書(Universal SSL)が `<edge のホスト>` を含むとき(例 `*.example.net` が `ab.example.net` を含む)は、別の証明書が発行されず、片づけるものが無いことがある。**【人に依頼】** ダッシュボードの対象ゾーンの SSL/TLS → Edge Certificates(日本語の表示は未確認)で `<edge のホスト>` だけを対象にした証明書を探し、あれば、そのゾーンのほかのホストで使っていないことを確かめてから消してもらう。

5. 外部の資格情報を片づける(**【人に依頼】**):

- Google Cloud の OAuth クライアント `wtt-control-<識別子>`(0.5)を削除する。プロジェクト `wtt-auth` をほかの導入と共有していなければ、プロジェクトごと消してよい
- Cloudflare の API トークンのうち残っているものを失効する: 配信ファイルのデプロイ用 `wtt-deploy-<識別子>` と使用状況の表示用 `wtt-usage-<識別子>`(識別子は 0.5)。ゾーンの設定用 `wtt-setup-<識別子>` と稼働確認用は期限切れなら何もしなくてよい
  - **失効する前に、名前だけで決めず、撤去する導入のトークンかを確かめる。** API トークンはユーザーに属するので、ほかの導入(別のアカウントに入れた導入や試しの導入)のトークンも同じ一覧に並ぶ(0.5)。名前は人が付けるので、重なったり、手順と違う名前になったりする。トークンを開き、Account Resources(アカウント リソース)が撤去するアカウントだけであることと、作成日がその導入を入れた日(`deploy-log.md` の日付)と合うことを確かめる
  - どちらかが合わない、または確かめられないトークンは失効しない。失効は取り消せず、まだ使っている導入のデプロイ用のトークンを失効すると、その導入では公開や設定の保存をしても設置タグのファイルが作り直されなくなる(使用状況の表示用なら、管理画面の使用状況が取れなくなる)
- Cloudflare Access のアプリケーション(4.5 / 7.3)を削除する
- GTM のタグ・トリガー・変数を削除する
- 手元では `deploy-secrets.env` と `.env.agent`(5.1。API キーは control と一緒に無効になっている)を消し、`deploy-backups/` は保管方針に従って扱う

6. 確認:

```bash
pnpm -C apps/control exec wrangler d1 list --json | jq '[.[] | select(.name | startswith("wtt-"))] | length'   # 期待: 0
pnpm -C apps/control exec wrangler kv namespace list | jq '[.[] | select(.title | endswith("wtt-config"))] | length'   # 期待: 0
curl -sS -o /dev/null -w '%{http_code}\n' "https://<設置タグのホスト>/s/<siteId>.js"   # 期待: route は設置サイト自身の応答(404 など)。custom-domain は名前を引けずに失敗するか、ゾーンのほかのレコードの先の応答。200 の JS が返るなら `wtt-static` の Route が残っている
```

`<設置タグのホスト>` は 2.9 の (4) のとおり。`custom-domain` では DNS レコードが無くなるので、最後の `curl` が名前を引けずに失敗する(`Could not resolve host`)のが期待。ゾーンにワイルドカードのレコード(`*.example.net` など)があると名前は引けて、そのレコードの先のサーバーの応答が返る。その場合も、200 の JS でなければ消えている。`workers-dev` では最後の `curl` は行わない。workers.dev を無効にした後にどんな応答が返るかを、Cloudflare は保証していないため。

Free プランの料金はリソースを消した時点で止まる(Workers Paid にしていた場合、プランの解約はダッシュボードの Compute(コンピュート)→ Workers plans(Workers のプラン)から)。
