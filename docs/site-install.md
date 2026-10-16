# サイト導入ガイド

対象サイトにタグを入れ、エクスペリエンスの結果が GA4 に届くようにするまでの手順。[デプロイガイド](deploy.md)を終えている(edge / control が動き、管理画面にログインできる)前提で書く。エクスペリエンスの作り方は[運用ガイド](operations.md)、結果の見方は[分析ガイド](analytics.md)にある。

読者は、GTM と GA4 を業務で触っているがこのツールは初めての運用者を想定している。

## この文書の使い方

**第 1 部(1〜6 節)は全員が上から順に進める。** 第 2 部は条件に当てはまるときだけ、第 3 部は調べたいときに読む。

### 最短手順

「同意管理(CMP)を入れていない / CSP を出していない / Mode A」のサイトなら、次の 5 つで設置が終わる。

- [ ] デプロイガイドを 5 節のスモークまで終える
- [ ] 管理画面でサイトを作る(または確認する)— [2 節](#2-サイトを作る)
- [ ] viewport の meta の直後にタグを 1 本置く — [3 節](#3-タグを置く)
- [ ] GA4 にカスタムディメンションを 3 件登録し、GTM に変数・トリガー・タグを作る — [4 節](#4-ga4-と-gtm-をつなぐ)(GTM 部分は JSON のインポートで短縮できる)
- [ ] エクスペリエンスを 1 つ開始し、4 点を確認する — [5 節](#5-設置後の確認)

うまくいかないときは [6 節](#6-うまくいかないとき)。

### 第 2 部が要るのはこういうとき

| 当てはまること | 読む節 |
|---|---|
| サイトに Cookie の同意バナー(CMP)がある、または EU 向けで同意を得てから動かしたい | [7. consent の配線](#7-consent-の配線cmp-を使うサイト) |
| Safari の訪問者にも長く同じパターンを出したい / サイトの既存の会員 ID などで訪問者を識別したい | [8. Mode C と Mode B](#8-mode-c-と-mode-b) |
| 「前に料金ページを見た人」「目標を達成した人」など、訪問履歴で出し分けたい | [9. 履歴条件と Visitor Profile](#9-履歴条件と-visitor-profile) |
| HTML / CSS / JavaScript の書き換え(コードの変更)を使う、またはサイトが CSP を出している | [10. コードの変更と CSP](#10-コードの変更と-csp) |
| 日本国内向けのサイトで、外部送信ポリシーを公表している | [14. 外部送信規律への対応](#14-外部送信規律への対応) |

### 表記と例

この文書では、次の例の値を使う。自分の値に読み替える。

| 表記 | 意味 | 例 |
|---|---|---|
| `<ページのホスト>` | エクスペリエンスを出すページ自身のホスト名 | `www.example.com` |
| `<設置ホスト>` | タグ(`/s/<siteId>.js`)を配っているホスト名。デプロイガイドの `install_host` | `www.example.com` |
| `<siteId>` | 管理画面で作ったサイトの ID | `site_example` |

デプロイガイドの既定の構成(設置サイトのゾーンに Workers Route を張る)では、`<設置ホスト>` と `<ページのホスト>` は同じになる。設置タグを別のホスト(Custom Domain の例 `ab.example.com`、または `*.workers.dev` の `wtt-static.<アカウントのサブドメイン>.workers.dev`)で配っている場合は両者が異なる。以下の `<設置ホスト>` は、設置タグを配っているそのホストに読み替える。

用語(サイト・エクスペリエンス・パターン・目標・公開など)は[運用ガイド 1 節](operations.md#1-用語の要約)にまとめてある。

---

## 第 1 部 設置の手順

## 1. 前提

- [デプロイガイド](deploy.md)を 5 節まで終えている: edge と control が動き、管理画面にログインでき、スモーク(サイトを作ってエクスペリエンスを開始 → 終了)が通っている
- `<設置ホスト>` で設置タグを配る配信専用の Worker と edge の Route が効いている(既定の構成では `<設置ホスト>/s/*` が配信専用の Worker、`<設置ホスト>/v1/*` が edge。[デプロイガイド 2.3](deploy.md#23-route-を書く)・[2.9](deploy.md#29-設置タグの配信配信専用の-worker-とデプロイ専用の-worker))。`*.workers.dev` で公開する構成では `<設置ホスト>` = `wtt-static.<アカウントのサブドメイン>.workers.dev`(Route は無い。制約は[導入構成の選び方 2 節](install-patterns.md#2-edge-の置き方問い-1))
- サイトに GTM コンテナが入っており、GA4 にデータを送っている(GA4 の Google タグが GTM 内で動いている)。確かめるときは、ページの HTML を取得して探すのではなく、ブラウザの DevTools → Network でページを開き、`gtm.js` と `g/collect` への通信があることを見る(GTM を JavaScript で後から挿入するサイトでは、HTML に GTM のスニペットが無い)
- GA4 の次の 2 つを控えてある
  - **測定 ID**(`G-` で始まる)— GA4 → 管理 → データストリーム
  - **数値のプロパティ ID**(`<GA4 プロパティ ID>`)— GA4 → 管理 → プロパティの設定 → プロパティの詳細。4 節の API 手順と分析で使う

## 2. サイトを作る

デプロイガイド 5 節のスモークで作ったサイトをそのまま使うなら、ここは設定の確認だけでよい。

管理画面でワークスペースを開き、サイト一覧の右上の「新しいサイト」で作る。作成画面の項目は 5 つ。

| 項目 | 入れるもの |
|---|---|
| `名前` | 管理用の表示名。自由 |
| `ドメイン(ホスト名)` | `<ページのホスト>`(例 `www.example.com`)。`https://` やパスは付けない。小文字 |
| `サイト ID(任意)` | 空欄なら自動で決まる。自分で決めるなら英数字・`_`・`-` の 64 字以内(例 `site_example`)。タグの URL(`/s/<siteId>.js`)になり、**作成後は変更できない** |
| `導入の形` | **迷ったら `A: JS Cookie(タグ 1 本)`**。もう一方の `B: サーバー発行 Cookie` は Safari 対策の選択肢で、後から移せる([8 節](#8-mode-c-と-mode-b)) |
| `同意の扱い`(設定のキーは `consentMode`) | **CMP が無ければ「同意を待たずに動かす」(既定。`implicit`)のまま**。同意を得るまで何も動かしたくない場合だけ「訪問者が同意するまで動かさない」(`required`)([7 節](#7-consent-の配線cmp-を使うサイト)) |

作ったら、左メニューの「設定」→「一般」で **`受け付けるサイトのアドレス(Origin)`**(設定のキーは `allowedOrigins`)を確認する。`ドメイン(ホスト名)` から `https://<ドメイン>` が自動で入っている。同じタグを複数のホストのページに置く場合(例 `example.com` と `www.example.com`)は、1 行に 1 つずつ全部を書く。末尾のスラッシュやパスは付けない。ここに無い origin のページからの要求は拒否される(403)。この値はページの origin から決まるので、edge の位置にかかわらず既定値のままでよい。

ほかの設定項目はすべて既定のままでよい。一覧と意味は [11 節](#11-サイト設定項目の全一覧)。分析用の外部 ID(GA4 プロパティ ID / BigQuery データセット)は、分析を始めるときに[分析ガイド 2 節 (d)](analytics.md#d-サイトに外部-id-を設定する)で設定する。

## 3. タグを置く

サイトの全ページの **viewport の meta(`<meta name="viewport" …>`)の直後**に、次の 1 行を置く。GTM のスニペットより前にする。

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://<設置ホスト>/s/<siteId>.js"></script>
<!-- ここから下に GTM などの既存タグ -->
```

画面の幅の条件は、タグが viewport の meta より後にあるときだけ正しい幅を読める。meta より前にあると幅は不明として扱い、画面の幅の条件を使うエクスペリエンスはそのページで配信されない(viewport の meta が無いページでも、画面の幅の条件を使うエクスペリエンスは配信されない)。

この 1 行は、管理画面の「設定」→「導入タグ」からもコピーできる(そのサイトの `<siteId>` が入った状態でコピーボタンが出る)。

守ること:

- **`async` / `defer` / `type="module"` を付けない。** 同期で読み込むことで、変更を当てる対象を描画前に一瞬隠し(prehide)、元の表示が見えてから切り替わる「チラつき」を防いでいる
- **GTM のカスタム HTML タグで入れない。JS で後から挿入もしない。** どちらも読み込みが遅れて上の条件を満たさず、元の表示が見えてから切り替わる。CSP の nonce も引き継げない。導入の確認だけなら GTM 経由でも動く(割り当て・Cookie・`ab_exposure` の push は行われる)が、チラつきが出るので、本番のエクスペリエンスを始める前に `<head>` に直接書く形へ移す
- **サイトが CSP の nonce を使っているなら、タグにも同じ nonce を付ける**(`<script nonce="..." src="...">`)。詳しくは [10 節](#10-コードの変更と-csp)

確認: ブラウザで `https://<設置ホスト>/s/<siteId>.js` を開き、JavaScript が表示されること。設置タグを別オリジン(`*.workers.dev` / Custom Domain)で配っているときは、404 が配信専用の Worker の応答(本文 `not found`)になる。サイトの 404 ページ(HTML)が出るのは Route 構成だけ。

- `not found` という短い文字列だけが出る → そのサイトがまだ一度も公開されていない(デプロイガイドのスモークで開始 → 終了していれば公開済み)か、公開の後の配信ファイルの更新が済んでいない(管理画面のサイトの上部に警告が出る。[運用ガイド 4 節](operations.md#4-公開の反映))か、サイト ID の綴り違い。この状態でもサイトは元の表示のまま動く
- サイトの 404 ページ(HTML)が出る → 配信専用の Worker の Route が効いていない。[デプロイガイド 2.9](deploy.md#29-設置タグの配信配信専用の-worker-とデプロイ専用の-worker) の確認を見直す

**SPA の注意**: 画面遷移を `pushState` で行うサイトでは、遷移しても条件の再評価は行われない。新しい評価が走るのはページの再読み込みを伴う遷移だけ([運用ガイド 8 節](operations.md#8-既知の制約))。

## 4. GA4 と GTM をつなぐ

タグはエクスペリエンスの結果を GTM の `dataLayer` に入れるだけで、GA4 へは送らない。GA4 に届けるには、GA4 側の登録(4.1)と GTM 側の配線(4.2)の両方が要る。

- **4.2 の GTM 部分は、用意した JSON をインポートすれば短縮できる(4.3)。** 手で作る場合と中身は同じ
- 以下は既定の名前(`ab_exposure` / `ab_experiment_id` など)を前提にしている。「設定」→「外部計測の名前」(節の見出しは「外部計測の名前(dataLayer の名札)」)で名前を変えた場合は読み替える([12 節](#12-datalayer-の契約と命名の規則))
- GTM のスニペットで dataLayer の名前を変えているサイト(`gtm.js` の URL に `l=` が付く)は、同じ節の `dataLayer の変数名` を同じ名前にする。違うままだと、タグは既定の `dataLayer` に入れ、GTM はそれを読まない([12 節](#datalayer-の変数名))

### 4.1 GA4 にカスタムディメンションを登録する

**GA4 で結果を見るなら必須。** GA4 は、登録していないイベントパラメータをレポートの次元として使わせない。未登録のままだと探索レポートでパターン別に分けられず、GA4 Data API も 400(`Field customEvent:ab_variant_id is not a valid dimension`)を返す。**登録前に届いたイベントは遡って次元にならない**ので、エクスペリエンスを始める前に済ませる。

登録するのは次の 3 件(範囲はすべて **イベント**)。

| イベント パラメータ | ディメンション名(例) |
|---|---|
| `ab_experiment_id` | `AB experiment_id` |
| `ab_variant_id` | `AB variant_id` |
| `ab_goal_id` | `AB goal_id` |

**手動**: GA4 → 管理 → データの表示 → **カスタム定義** → 「カスタム ディメンションを作成」。ディメンション名は自由、範囲 = **イベント**、イベント パラメータ = 上の表の値。3 回繰り返す(プロパティあたりの上限は 50 件)。

`ab_experiment_name` / `ab_variant_name` / `ab_goal_name` も GTM から GA4 に送られるが、登録しない限りレポートの次元にはならない(DebugView と BigQuery では見える)。名前でも分けたい場合は同じ手順で追加する。

**API で登録する場合**(GA Admin API v1beta `customDimensions.create`。スコープ `https://www.googleapis.com/auth/analytics.edit` が要り、gcloud の通常のユーザートークンには含まれないので ADC でログインし直す):

```bash
gcloud auth application-default login --scopes=https://www.googleapis.com/auth/analytics.edit,https://www.googleapis.com/auth/cloud-platform
T=$(gcloud auth application-default print-access-token)
PID=<GA4 プロパティ ID>   # 数値のプロパティ ID(G-… の測定 ID ではない)
for p in ab_experiment_id ab_variant_id ab_goal_id; do
  curl -sS -X POST "https://analyticsadmin.googleapis.com/v1beta/properties/$PID/customDimensions" \
    -H "Authorization: Bearer $T" -H 'content-type: application/json' \
    -d "{\"parameterName\":\"$p\",\"displayName\":\"AB ${p#ab_}\",\"scope\":\"EVENT\"}" | jq -c '{name, parameterName, error: .error.message}'
done
# 確認: 登録済みの一覧
curl -sS "https://analyticsadmin.googleapis.com/v1beta/properties/$PID/customDimensions" -H "Authorization: Bearer $T" | jq -c '[.customDimensions[]? | .parameterName]'
```

`analytics.edit` などのスコープが既定の gcloud クライアントで拒否されることがある。その場合は独自の OAuth クライアント ID を作って `--client-id-file` で渡すか、サービスアカウントで実行する(Google の ADC トラブルシュート https://docs.cloud.google.com/docs/authentication/troubleshoot-adc#access_blocked_when_using_scopes)。

### 4.2 GTM に変数・トリガー・タグを作る

使っている GTM コンテナに次の 10 件を作る。名前は例なので変えてよい。

**変数: データレイヤーの変数 6 件**(「データレイヤーのバージョン」はすべて **バージョン 2**)

| 変数名 | データレイヤーの変数名 |
|---|---|
| `DLV - ab_experiment_id` | `ab_experiment_id` |
| `DLV - ab_experiment_name` | `ab_experiment_name` |
| `DLV - ab_variant_id` | `ab_variant_id` |
| `DLV - ab_variant_name` | `ab_variant_name` |
| `DLV - ab_goal_id` | `ab_goal_id` |
| `DLV - ab_goal_name` | `ab_goal_name` |

**トリガー: カスタム イベント 2 件**

| トリガー名 | イベント名 |
|---|---|
| `CE - ab_exposure` | `ab_exposure` |
| `CE - ab_conversion` | `ab_conversion` |

**タグ: Google アナリティクス: GA4 イベント 2 件**(測定 ID はサイトの GA4 の `G-…`)

| タグ名 | イベント名 | イベント パラメータ | トリガー |
|---|---|---|---|
| `GA4 - ab_exposure` | `ab_exposure` | `ab_experiment_id` = `{{DLV - ab_experiment_id}}`、`ab_variant_id` = `{{DLV - ab_variant_id}}`、`ab_experiment_name` = `{{DLV - ab_experiment_name}}`、`ab_variant_name` = `{{DLV - ab_variant_name}}` | `CE - ab_exposure` |
| `GA4 - ab_conversion` | `ab_conversion` | `ab_goal_id` = `{{DLV - ab_goal_id}}`、`ab_goal_name` = `{{DLV - ab_goal_name}}` | `CE - ab_conversion` |

作ったら GTM の**プレビュー**で対象ページを開き、エクスペリエンスが動いているページで `ab_exposure` のタグが発火することを確かめてから**公開**する(エクスペリエンスの開始は [5 節](#5-設置後の確認)の手順で行う)。

### 4.3 ショートカット: JSON をインポートする

4.2 の 10 件と、測定 ID を入れる定数 1 件をまとめた JSON を [`integrations/gtm/wtt-gtm-container.json`](../integrations/gtm/wtt-gtm-container.json) に用意してある。GitHub の画面なら「Download raw file」でダウンロードできる。

**使えない場合**: サイトの「外部計測の名前」を既定から変えた / 4.2 の変数・タグを既に手で作った(同じ名前の項目が重複する)。そのときは 4.2 の手順で作る。

1. GTM → 管理 → **コンテナをインポート**
2. ファイルに JSON を選び、ワークスペースは **新規** を選ぶ(作業中の既存ワークスペースに混ぜない)
3. インポート オプションは **統合(Merge)** を選び、その下で **競合するタグ、トリガー、変数の名前を変更する(Rename)** を選ぶ

   > **「上書き(Overwrite)」は選ばない。** ワークスペースの中身が JSON の 11 件だけに置き換わり、そのまま公開すると既存の GA4 設定や他のタグがすべて消える。

4. 確認画面で、追加が **タグ 2・トリガー 2・変数 7** であること、変更・削除が 0 件であることを見てから確定する
5. 変数 **`C - GA4 Measurement ID`**(定数)を開き、値 `G-XXXXXXXXXX` をサイトの測定 ID に書き換える
6. 4.2 の最後と同じくプレビューで発火を確かめてから**公開**する

JSON に含まれないもの: 4.1 の GA4 カスタムディメンション(GA4 側の登録なので別途必要)、`ab_extra` 配下の追加パラメータ([12 節](#12-datalayer-の契約と命名の規則)。使う場合は変数とパラメータを自分で足す)、GA4 の Google タグ(サイトで既に動いているものを使う。入れると計測が二重になる)。

## 5. 設置後の確認

エクスペリエンスを 1 つ作って開始する(作り方は[運用ガイド 2 節](operations.md#2-エクスペリエンスのライフサイクル)。開始すると自動で公開され、訪問者に届くまで 1 分ほどかかる)。**通常の Chrome で**対象ページを開き、次の 4 点を見る。自動化ブラウザや headless ブラウザの訪問は GA4 に記録されないので使わない([分析ガイド 8 節](analytics.md#8-よくある詰まり))。

1. **エクスペリエンスが適用されている**: パターンの変更がページに見える。割当を引き直して、別のパターンも出ることを確かめる。引き直し方は Mode で違う:
   - **Mode A**: DevTools → Application → Cookies で `_ab_vid` を削除して再読み込みする
   - **Mode C**: 参照している既存 Cookie の値が違う別のテスト利用者(または別のブラウザプロファイル)で開く。**本番の認証 Cookie を削除・改変しない**
   - **Mode B**: DevTools → Application → Cookies で正本 Cookie を削除する(HttpOnly なので `document.cookie` からは消せない)
2. **Cookie が発行されている**: DevTools → Application → Cookies に `_ab_vid` がある(サイト設定の `正本 Cookie 名` を変えていればその名前)
3. **`dataLayer` に `ab_exposure` が入っている**: DevTools の Console で `dataLayer`(サイト設定の `dataLayer の変数名` を変えていればその名前)と入力して展開する。`ab_exposure` が **エクスペリエンスごとに 1 件**(二重に出ていない)で、`ab_experiment_id` / `ab_variant_id` が期待どおり。目標を踏んだら `ab_conversion` も同様に見る
4. **GA4 に届いている**: GTM のプレビューを有効にした状態でページを開き、GA4 → 管理 → **DebugView** に `ab_exposure` / `ab_conversion` が現れ、4.1 のパラメータが付いている

コードの変更(HTML / CSS / JavaScript)を含むエクスペリエンスでは、あわせて Console に CSP 違反が出ていないことを確認する([10 節](#10-コードの変更と-csp))。開始直後に見るべきこと全体(両群の確認、SRM の兆候)は[運用ガイド 5 節](operations.md#5-開始直後のチェック)。

## 6. うまくいかないとき

設置で詰まりやすい症状。エクスペリエンスの中身(URL 条件・配信条件・公開)が原因のものは[運用ガイド 10 節](operations.md#10-トラブルシュート)にある。

runtime は失敗を `console.debug`(`wtt: …` で始まる)に出す。Chrome の Console はこれを既定で隠すので、ログレベルの「詳細(Verbose)」を有効にしてから見る。

| 症状 | 確認すること | 対処 |
|---|---|---|
| タグの URL が `not found` | そのサイトを一度でも公開したか / サイト ID の綴り | エクスペリエンスを開始する(自動で公開される)。反映は 1 分ほど |
| タグの URL でサイトの 404 ページが出る | 配信専用の Worker の Route | [デプロイガイド 2.9](deploy.md#29-設置タグの配信配信専用の-worker-とデプロイ専用の-worker) |
| `_ab_vid` が作られない | タグが読み込まれているか(DevTools → Network で `<siteId>.js` が 200)/ `consentMode` が `required` で同意待ちになっていないか / `window.__ab` に `denied` を置いていないか | [7 節](#7-consent-の配線cmp-を使うサイト)。Mode B の Cookie は HttpOnly なので Application → Cookies で見る |
| Network で `/v1/sites/<siteId>/decision` が 403(この通信は[履歴条件](#9-履歴条件と-visitor-profile)を使うサイトでだけ起きる) | ページの origin が `allowedOrigins` に完全一致しているか(`https://`・ポート・`www` の有無) | [2 節](#2-サイトを作る)の `allowedOrigins` に追加する |
| Network で `/v1/sites/<siteId>/decision` が 404 | `<設置ホスト>/v1/*` の Route | [デプロイガイド 2.3](deploy.md#23-route-を書く) |
| 元の表示が一瞬見えてから切り替わる(チラつく) | タグに `async` / `defer` が付いていないか / GTM 経由で入れていないか / CSS の変更か(CSS の変更は prehide しない) | [3 節](#3-タグを置く)のとおり viewport の meta の直後に同期で置く |
| Console に `wtt: decision timeout` | 応答がサイト設定の `decisionTimeoutMs` を超えた。その読み込みではエクスペリエンスを出さない(元の表示のまま) | 通信環境を変えて再確認する。常に起きるなら `decisionTimeoutMs` を上げる([11 節](#11-サイト設定項目の全一覧)) |
| `dataLayer` に `ab_exposure` はあるが DebugView に無い | GTM のトリガーのイベント名の綴り / GTM を公開したか / 測定 ID / DebugView の対象端末 / Brave などで GTM が遮断されていないか | 4.2 を見直し、GTM プレビューでタグの発火を追う |
| GA4 レポートでパターン別に分けられない | 4.1 の登録 | 登録する。登録前のデータは遡って分けられない |

---

## 第 2 部 条件によって要る設定

## 7. consent の配線(CMP を使うサイト)

**同意管理(CMP)を入れていないサイトは、この節の作業は要らない。** 既定の `consentMode: "implicit"` では、何も書かなくても同意ありとして動く。

**CMP があるサイトでは、訪問者の同意の撤回を伝える配線(`AB.consent(false)`)が必須。** タグは同じページ内での変化しか観測できず、前のページで拒否された事実を知る手段が無いため、サイト側からの呼び出しが撤回を伝える唯一の経路になる。

配線は 2 か所:

- **ページ読み込み時の状態**: タグより前に `window.__ab = { consent: "granted" | "denied" | "pending" };` を置き、CMP が保存している判定を写す
- **訪問者が同意・拒否したとき**: `AB.consent(true)` / `AB.consent(false)` を呼ぶ。CMP の変更コールバックに繋ぐ

```html
<script>
  // CMP の保存済みの判定を、タグより前に写す
  window.__ab = { consent: cmpHasConsent() ? "granted" : "denied" };
</script>
<script src="https://<設置ホスト>/s/<siteId>.js"></script>
<script>
  // CMP の変更コールバックから毎回呼ぶ(撤回を伝える唯一の経路)
  cmpOnChange(function (granted) { window.AB && window.AB.consent(granted); });
</script>
```

`cmpHasConsent` / `cmpOnChange` は、使っている CMP の API に置き換える。

### `consentMode` による違い

| | `implicit`(既定) | `required` |
|---|---|---|
| `window.__ab` が無い | すぐ動く | 同意待ち(何もしない) |
| `consent: "pending"` | 無視してすぐ動く | 同意待ち |
| `consent: "granted"` | 動く | 動く |
| `consent: "denied"` | **動かない** | 動かない |

- 「動かない」「同意待ち」の間は、Cookie の発行・decision / event の送信・prehide をすべて行わない(元の表示のまま)。`AB.track()` も何も送らない
- EU 等で、同意を得るまで一切動かしたくないサイトは `required` を選ぶ

### 撤回したときに起きること

- **Mode A**: `document.cookie` から正本 Cookie と UUID Cookie(有効時)を削除する
- **Mode B**: 正本 Cookie は HttpOnly で edge が持っているので、`AB.consent(false)` が `/__ab/decision` に撤回を 1 回送り、edge が Cookie を消す。**呼ばれなければ Cookie は消えない**
- 撤回後に再び `AB.consent(true)` が呼ばれると、**新しい ID で**やり直す(前の ID は復元しない)。**Mode C は例外**で、サイトの既存 Cookie から作る ID なので同じ ID に戻る([8 節](#8-mode-c-と-mode-b))
- 適用済みの変更は、撤回しても元に戻らない
- **サーバー側の履歴の削除**: `AB.consent(false)` のときに `/v1/sites/<siteId>/event` へ削除要求(`{ "type": "forget" }`)を 1 回送り、[9 節](#9-履歴条件と-visitor-profile)の Visitor Profile(目標達成・閲覧回数・保存済みの割当)を即時に消す。**いま公開中の設定が履歴条件を使っていなくても送る**(以前の設定で作られた Profile が残っていることがあるため。Profile を一度も使っていないサイトでは、消すものが無いまま 1 要求が返るだけ)。サイト設定 `撤回時に Profile を削除(forgetOnRevoke)` を off にすると送らず、`retentionDays` の経過で消える(誤操作の拒否で履歴を失いたくない場合向け)。Mode B は対象外(Cookie の削除だけで、履歴は `retentionDays` で消える)。削除は確実ではなく、撤回直後のページ遷移や通信断で届かなかった分は `retentionDays` で消える

## 8. Mode C と Mode B

Mode は「訪問者 ID を何で持つか」の違い。**迷ったら Mode A**(タグ 1 本で完結し、実サイトで検証済み)。Mode B も実サイトで検証済み。Mode C は E2E テストでは検証済みだが、実サイトでは未検証。

| Mode | 訪問者 ID の持ち方 | Safari での寿命 | 必要な作業 | 検証 |
|---|---|---|---|---|
| **A: JS Cookie** | タグが JavaScript で Cookie を書く(毎ページビューで延長) | **7 日間サイトを訪れないと消える**([13 節](#13-ブラウザの制約)) | タグ 1 本 | 実サイトで検証済み |
| **C: BYOID**(`訪問者 ID の取得元` = `cookie:<名>`) | サイトの既存 Cookie(会員 ID など)から作る。ツールは発行しない | 元の Cookie に依存。サイトが JavaScript で書いた Cookie なら A と同じ | タグ 1 本 + サイト設定 | E2E 検証済み(`fixtures/e2e-byoid.json`)・実サイト未検証 |
| **B: サーバー発行 Cookie**(旧称 D-lite) | サイトと同じゾーンの Workers Route を通して、edge が HTTP の `Set-Cookie`(HttpOnly)で発行する | 7 日ルールの対象外(同じゾーンの Route からの `Set-Cookie` が Safari で 7 日を超えて残ることを実機で確認済み) | タグ 1 本 + `/__ab/*` の Route。サイトが Cloudflare のゾーン配下にあることが前提 | E2E 検証済み(`fixtures/demo-dlite.json`)・実サイトで検証済み |

A から B へは後から移せるが、Cookie の発行元が変わるので訪問者 ID は作り直しになる(全訪問者の割当がリセットされる)。

### Mode C(BYOID)

サイトが既に持っている Cookie を訪問者 ID に使う。

1. サイト設定の `訪問者 ID の取得元` を `cookie` にし、`参照する Cookie 名` にサイトの既存 Cookie の名前を入れる(JavaScript から読める Cookie に限る。HttpOnly は不可)
2. 保存して、対象ページの Console で `document.cookie` にその Cookie があることを確かめる

- 値はブラウザ内で `SHA-256(site_salt + 値)` に変換してから送る(base64url 43 文字)。生の値は送らず、保存もしない
- 値が取れない訪問者は Mode A の匿名 ID で動く。ページ読み込み後に値が現れても、そのページでは切り替えない(次のページから)
- **同意を撤回しても ID は変わらない。** ツールが消せるのは自分が発行した Cookie だけで、参照先の Cookie はサイトのもの。再び同意すると同じ ID に戻り、撤回前の履歴に再びつながる(サーバー側の履歴の削除は `撤回時に Profile を削除(forgetOnRevoke)` が担う。[7 節](#7-consent-の配線cmp-を使うサイト))
- **`参照する Cookie 名` は `正本 Cookie 名` / `UUID Cookie 名` / 削除待ちの旧 Cookie 名と同じにできない**(保存時に 422)。同じだと、値が取れなかったときに自分で書いた匿名 ID を次のページで参照先として読み、同じ訪問者の ID が変わってしまうため
- **メールアドレスなど個人データに由来する値は使わない。** `site_salt` はタグの中に入る公開値なので、この変換は「生の値を保存しない」ための措置で匿名化ではない。値の種類が少ないもの(低エントロピー)は逆算され得る
- Mode B とは併用できない(Mode B では `訪問者 ID の取得元` は `ab` 固定)

**Mode C を選んだ場合の注意事項**

- **Mode C でも、匿名の Cookie(`_ab_vid`。`正本 Cookie 名` の Cookie)を置く。** 識別(割当・履歴)には使わず、「初回の訪問からの経過」の条件に使う発行時刻のためだけに置く。サーバーへの判定の要求にはこの ID を含めず、時刻だけを送る
- **「初回の訪問からの経過」はブラウザ単位**で、ログインした人を端末をまたいで数えるものではない(別の端末・別のブラウザでは、その端末で最初に訪れた時点から数え直す)

### Mode B(サーバー発行 Cookie)

サイトが Cloudflare のゾーン配下にあるときの Safari 対策。サイト本体のサーバーの改修は要らない。

1. サイト設定の `導入の形` を `B: サーバー発行 Cookie(同じゾーンの Workers Route。サイトが Cloudflare 配下のとき)` にし、`hosts` に `<ページのホスト>` を 1 行に 1 つ書く(小文字。日本語ドメインは punycode)
2. `<ページのホスト>/__ab/*` の Route を追加して edge を再デプロイする(デプロイガイドの `dlite_hosts`。[2.3](deploy.md#23-route-を書く))
3. 疎通を確認する:

```bash
curl -si -X POST "https://<ページのホスト>/__ab/decision" -H 'content-type: application/json' \
  -d '{"v":1,"url":"https://<ページのホスト>/","referrer":"","device":"desktop"}' | grep -i set-cookie
```

`set-cookie:` の行が出れば通っている。

`hosts`・Route・疎通確認の URL は、すべて `<ページのホスト>` に揃える。タグは Mode B の decision / event を `/__ab/…` の相対 URL で送るので、タグを別のホストから配っていても `/__ab/*` はページのホスト側に要る。

- タグは `/__ab/decision` に訪問者 ID を含めずに送り、edge が `Set-Cookie`(HttpOnly)で正本 Cookie を発行する。ID は JavaScript から読めない
- 同意の撤回で Cookie が消えるのは、`AB.consent(false)` が呼ばれたときだけ([7 節](#7-consent-の配線cmp-を使うサイト))。ページ読み込み時点で `denied` の場合は通信そのものを行わないため、既に発行された Cookie は残る(Cookie 自体の有効期限は 1 年)。`retentionDays` が決めるのはサーバー側の Visitor Profile の寿命で、Cookie ではない
- `撤回時に Profile を削除(forgetOnRevoke)` は Mode B では効かない

## 9. 履歴条件と Visitor Profile

次のどれかを使うサイトは、訪問者ごとの履歴をサーバー側(Durable Object `VisitorProfile`)に持つ。この状態を `needsProfile` と呼び、管理画面の公開の結果と公開履歴に `needsProfile=true` と出る。

- 配信条件の閲覧したページの条件(このページを見たことがある・N 回以上見た・最後に見たのが N 日以内)/ 目標の条件(目標を達成したことがある)。オーディエンスに含めた場合も同じ
- エクスペリエンスの `persistAssignment: true`(一度出したパターンを出し続ける)

**必要な設置作業**: `<設置ホスト>/v1/*` の Route。デプロイガイドの既定の構成では 2.3 で張ってあるので、追加の作業は無い。タグは decision / event の URL を自分の読み込み元から組み立てる(`https://<設置ホスト>/v1/sites/<siteId>/decision`)ため、この Route が無いとサイト本体に届いて 404 になる。

保存するのは閲覧回数・目標達成回数・保存済みの割当だけで、生のイベントや個人情報は保存しない。最終訪問から `retentionDays`(既定 90 日)で自動的に消える。**`retentionDays` を変えると、その後に訪問した訪問者から新しい日数が効く**(保持期限は訪問のたびに「その時点の設定」で置き直される)。変更より前の最終訪問から一度も戻ってこない訪問者の Profile は、変更前の日数で消える。短くした場合に休眠中の Profile まで即時に短くする手段は無いので、保持の方針を説明するときはこの挙動を含める。

- **数えるのはルールを公開した後の閲覧だけ。** 閲覧したページの条件は公開時に設定に焼き込まれ、それより前の訪問は数えない
- **今見ているページも「見たことがある」に含む。** 条件のページの初回訪問で、同じページの `visited` が真になる
- **目標の数え方**: PAGEVIEW = URL 条件に一致するページの読み込みごと、CLICK = セレクタに一致する要素のクリックごと(子要素のクリックや、描画し直された要素にも効く)、CUSTOM = `AB.track("<goalId>")` の呼び出しごと。重複は除かない(GTM のクリックトリガーと同じ)。このサイトでは `ab_conversion` の `dataLayer` への push に加えてサーバーにも送る(目標だけを使うサイトでは `needsProfile` にならず、`dataLayer` にだけ出る)
- **コスト**: このサイトでは、ページビューごとに decision 1 リクエスト + Durable Object 1 リクエスト、一致した目標 1 つごとに event 1 + Durable Object 1、訪問者ごとに削除用の alarm 1 が発生する。PAGEVIEW 目標は読み込みごとに発火するので、URL 条件が広いと Durable Object のリクエストが倍増する。Cloudflare の Free プランの上限を超えると decision が失敗し、エクスペリエンスは出なくなる(サイトは元の表示のまま動く)

`/v1/sites/*` と `/__ab/*` は認証が無く(Origin の検証だけ)、でたらめな訪問者 ID を送られると Profile が量産され得る。守りは Cloudflare 側に置く: ゾーンの WAF Rate Limiting Rule と使用量の監視([デプロイガイド 2.7](deploy.md#27-waf-rate-limiting-rule推奨) にしきい値の指針と、社内ネットワークなど多人数が 1 つの IP を共有する場合の注意がある)。

## 10. コードの変更と CSP

コードの変更は、運用者が書いた HTML / CSS / JavaScript を訪問者のブラウザで動かす。GTM のカスタム HTML と同じ信頼レベルで、下書きは編集者以上が作れ、本番に出すには管理者以上の公開を必ず経由する。中身の無害化(サニタイズ)はしない。

### 何がどう動くか

| type | 動き | 1 ページでの回数 | Exposure が出る条件 |
|---|---|---|---|
| HTML | `position`(`replace` = 要素そのものを置換 / `before` / `after` / `append`)で挿入する。`runScripts: true` のときだけ中の `<script>` を作り直して実行する(inline / `src` 両対応)。`false` なら `<script>` は実行されずに残る(JSON-LD などデータ用途向け) | DOM 挿入は要素ごと、`<script>` の実行はページ読み込みごとに 1 回 | DOM 挿入が成功したとき(中の `<script>` の成否は問わない) |
| CSS | 変更ごとに `<style data-ab-experiment data-ab-variant data-ab-change>` を `<head>` の末尾に 1 回入れる。prehide の対象外(チラつくことがある)。後から読み込まれるサイトの CSS に同じ詳細度で負けることがある — 効かないときは詳細度を上げるか `!important` を使う | 1 回 | 入れたとき(対照群・処理群とも起動直後) |
| CUSTOM_JS | `function(element, ctx) { …書いたコード… }` を、セレクタに**最初に一致した要素**を `element`(と `this`)にして実行する。`ctx = { experimentId, variantId, changeId }`。目標の送信は `window.AB.track(goalId)`、割当の参照は `window.AB.getAssignments()` | ページ読み込みごとに 1 回。SPA の再描画では再実行しない | 関数が登録され、例外なく終わったとき |

- ページ全体に効かせる CUSTOM_JS はセレクタを `body` にする
- 例外が出た変更だけを飛ばし、他は続ける(Console の詳細レベルに `wtt: custom js failed` と出る)。構文エラーも同じ扱い。同じ ID の変更が別のエクスペリエンス / パターンにあっても互いに干渉しない
- React / Vue が管理している要素を HTML で置き換えると、再描画で元に戻ることがある
- 同意の撤回で、適用済みの変更は元に戻らない
- **IMAGE の変更の `src` は R2 の公開ドメインの下に限る**(保存時に検証する)。CSP を出しているサイトは `img-src` にそのドメインを足す。R2 を使わない導入では IMAGE の変更は使えず、既存画像の差し替えは ATTRIBUTE の `src` で行う

### CSP を出しているサイトでの条件

タグは `new Function` / `eval` を使わない。CUSTOM_JS と HTML 内の `<script>` は `<script>` 要素を作って DOM に入れる方式で、**設置タグの nonce を、作る `<script>` / `<style>`(prehide を含む)に引き継ぐ**。nonce は `document.currentScript` から読むので、設置タグは同期の `<script src>` でなければならない([3 節](#3-タグを置く))。

| サイトの CSP | 必要な設定 |
|---|---|
| CSP なし | 何もしない |
| nonce 方式(`script-src 'nonce-…'`。`'strict-dynamic'` の有無は問わない) | **設置タグに nonce を付ける**だけ。`style-src` を絞っているなら同じ nonce 方式にする(prehide と CSS の変更の `<style>` に引き継ぐ) |
| allowlist 方式(ホストの列挙だけで nonce なし) | 作る inline の `<script>` / `<style>` が通らない。`'unsafe-inline'` を足せば通るが推奨しない — nonce 方式への移行を勧める(他社ツールや GTM も同じ案内をしている) |
| Trusted Types の強制(`require-trusted-types-for 'script'`) | **非対応**。HTML(`innerHTML` による挿入そのものが拒否される。`<script>` の有無を問わない)と CUSTOM_JS は動かない。TEXT / IMAGE / HIDE / ATTRIBUTE / CSS は動く(`<style>` の `textContent` は Trusted Types の対象外)。失敗はその変更だけに閉じる |

**設置タグや edge が設置サイトと別オリジンの構成**(`*.workers.dev` や別ドメインで公開している)では、`connect-src` に edge のホストを足す(decision / event の送信先)。設置タグの `script-src` には、設置タグを配るホスト(配信専用の Worker)を allowlist 方式のサイトだけ足す(nonce 方式なら設置タグの nonce で通る)。同一オリジンの構成(設置サイトのゾーンの Route)では不要。

**プレビューを設置タグ経由で開くときの追加の読み込み**: 設置したページでプレビューを開く(URL の末尾に `#__ab_preview=<experimentId>:<variantId>` を付けて開く)と、タグが設置タグと同じオリジンから `/s/preview/<hash>.js` を 1 本追加で読む。この `<script>` にも設置タグの nonce を付けるので、上の表のとおり設置タグに nonce を付けていれば CSP の設定を足す必要はない(allowlist 方式のサイトでは、設置タグと同じホストがすでに許可されていれば通る)。読み込めなかったときは、プレビューを適用せずに元の表示のままにする。通常の訪問者の読み込みでは、このファイルは読まない。

**ブロックされたときの挙動は type で違う**: CUSTOM_JS は関数が登録されないので「適用失敗」(処理群の Exposure は出ず、再試行もしない)。HTML は DOM 挿入が成功すれば Exposure が出る(中の `<script>` だけが止まる)。CSS は `<style>` が `style-src` で拒否されても要素は DOM に入るので Exposure は出る(スタイルは効かない)。

**CUSTOM_JS だけのパターンがブロックされると、処理群だけ Exposure が出ず、対照群は出るので、比較の母数が片側に偏る(SRM)。** 同じ偏りは、Trusted Types 下の HTML の変更や、`html` / `head` / `body` を対象にした `position: replace`(仕様上スキップされる)でも起きる。**コードの変更を含むエクスペリエンスは、開始直後に必ず対象ページを Chrome で開き、Console に CSP 違反が無いことと、両群で `ab_exposure` が出ることを確認し、違反があればすぐ一時停止する**([運用ガイド 5 節](operations.md#5-開始直後のチェック))。

補足: `script-src-elem` があればそちらが優先される。複数の CSP ヘッダがある場合はすべてを満たす必要がある。`'strict-dynamic'` は Safari 15.4 以降。HTML 内の外部 `src` スクリプトは、`'strict-dynamic'` なら動的な追加として許可されるが、allowlist 方式ではそのホストの許可が要る。

公開前の下書きを実際のページで見る手順(プレビュー)は[運用ガイド 3 節](operations.md#3-下書きプレビュー)。

---

## 第 3 部 リファレンス

## 11. サイト設定項目の全一覧

管理画面のサイト作成 / サイト設定画面の項目。**サイト ID は作成後に変更できない**(タグの URL と保存先のキーになる)。設定画面は左メニューの「設定」から開き、項目は節(サブメニュー)に分かれている。「作成時のみ」はサイト作成フォームだけにあり、設定画面には出ない。

| 項目(管理画面の表示) | 節 | 内容 |
|---|---|---|
| `名前` | 一般 | 管理用の表示名 |
| `サイト ID(任意)` | 作成時のみ | タグの URL(`/s/<サイト ID>.js`)になる。空欄なら自動で決まる。既存のタグを引き継ぐ場合はその ID を指定する。**作成後は変更できない** |
| `ドメイン(ホスト名)` | 一般 | サイトのホスト名。`受け付けるサイトのアドレス(Origin)` の初期値(`https://<ドメイン>`)になる |
| `hosts` | 訪問者 ID | Mode B のときだけ表示。1 行 1 ホスト名(小文字。日本語ドメインは punycode)。edge が `/__ab/*` への要求のホストからサイトを引くために使う |
| `受け付けるサイトのアドレス(Origin。1 行に 1 つ。https://host[:port] の形)` | 一般 | 設定のキーは `allowedOrigins`。1 行 1 origin。**完全形 `https://host[:port]`** で、末尾スラッシュもパスも付けない。Mode A の decision / event はここに一致する Origin だけを受け付ける。空だと全部拒否する(403) |
| `導入の形` | 訪問者 ID | `A: JS Cookie(タグ 1 本)` または `B: サーバー発行 Cookie(同じゾーンの Workers Route。サイトが Cloudflare 配下のとき)`。[8 節](#8-mode-c-と-mode-b) |
| `訪問者 ID の取得元` | 訪問者 ID | `ab`(ツールが発行する匿名 ID = Mode A)または `cookie:<名>`(サイトの既存 Cookie を使う = Mode C / BYOID)。Mode B では `ab` 固定 |
| `参照する Cookie 名` | 訪問者 ID | Mode C のとき。値は `SHA-256(site_salt + 値)` に変換してから送る。メールアドレスなど値の種類が少ないものは逆算され得るので使わない |
| `正本 Cookie 名` | 訪問者 ID | 既定 `_ab_vid`。**変えると全訪問者の ID が作り直され、割当がリセットされる**。旧名は `retentionDays` の間、削除対象として記録され、その間は再利用できない |
| `UUID Cookie(外部ツール連携用の別名。出力専用)` | 訪問者 ID | 有効にすると、正本の ID から導出した UUIDv4 を別の Cookie(`UUID Cookie 名`、既定 `_ab_uuid`)にも書く。導出した UUID から正本の ID には戻せず、ID の発行時刻も含まない。BYOID(Mode C)の訪問者にも出す。Mode C では割当に使う ID(BYOID のハッシュ。BYOID の Cookie が無ければ匿名 ID)から導出するので、ログインの前後で `_ab_uuid` の値が変わる。ツール自身はこの Cookie を読まない |
| `タイムゾーン` | 一般 | 既定 `Asia/Tokyo`。IANA の名前(`America/New_York` など)。エクスペリエンスの配信条件の曜日・時間帯の判定に使う(訪問者の端末のタイムゾーンではなくサイトのタイムゾーン)。変えたら次の公開から効く |
| `同意の扱い` | 一般 | 設定のキーは `consentMode`。`同意を待たずに動かす`(既定。`implicit`)または `訪問者が同意するまで動かさない`(`required`)。[7 節](#7-consent-の配線cmp-を使うサイト) |
| `decisionTimeoutMs(300〜3000)` | 一般 | decision の応答を待つ時間。超えるとその読み込みではエクスペリエンスを出さない(元の表示のまま) |
| `retentionDays(Profile と旧 Cookie 名の保持日数)` | 一般 | 既定 90(1〜3650)。最終訪問からこの日数で Visitor Profile を自動削除する。変更は次に訪問した訪問者から効く(休眠中の Profile は変更前の日数で消える。[9 節](#9-履歴条件と-visitor-profile)) |
| `撤回時に Profile を削除(forgetOnRevoke)` | 一般 | 既定 on。同意の撤回時にサーバー側の履歴をすぐ消す([7 節](#7-consent-の配線cmp-を使うサイト))。off にすると `retentionDays` まで残す |
| `外部計測の名前(dataLayer の名札)` | 外部計測の名前 | `dataLayer の変数名`(既定 `dataLayer`) / `extra の名前空間キー` / `露出のイベント名` / `露出: experimentId キー` / `露出: experimentName キー` / `露出: variantId キー` / `露出: variantName キー` / `コンバージョンのイベント名` / `コンバージョン: goalId キー` / `コンバージョン: goalName キー` の 10 項目。既定のままで使える([12 節](#12-datalayer-の契約と命名の規則)) |
| `ga4PropertyId(数値の GA4 プロパティ ID。G- で始まる測定 ID ではありません)` | 外部 ID | 管理者以上。分析レシピ(`analytics-recipe`)がプロパティ ID を埋めるのに使う。空 = 未設定(レシピはプレースホルダのまま)。[分析ガイド 2 節 (d)](analytics.md#d-サイトに外部-id-を設定する) |
| `bigqueryDataset(<GCP プロジェクト ID>.<データセット名>)` | 外部 ID | 同上。ドット区切りで `<GCP プロジェクト ID>.<BQ データセット>`(データセット名だけは不可) |

分析用の外部 ID 2 項目は、API なら `PATCH /sites/<siteId>` でも設定できる。

## 12. dataLayer の契約と命名の規則

タグが GTM / GA4 の `dataLayer` に入れる形は次の 2 種類。名前(イベント名・キー名・名前空間キー。以下「名札」)は**サイト単位**で、値の上書きと追加の key-value は**エクスペリエンス / パターン単位**で設定できる。何も設定しなければ下の既定の名前で動く。

**Exposure(訪問者にパターンを出したとき。エクスペリエンスごとに 1 回、2 回に分けて push)**

```js
dataLayer.push({ ab_extra: null });   // 1 回目: 名前空間を消すだけ。event を含まないので GTM のトリガーは発火しない
dataLayer.push({ event: "ab_exposure",
  ab_experiment_id: "exp_hero", ab_experiment_name: "Hero copy",
  ab_variant_id: "vB", ab_variant_name: "New hero",
  ab_extra: { test_group: "pricing_q3" } });   // extra が無いパターンでは null
```

**Conversion(`AB.track("goalId")` / 目標の検知)**

```js
dataLayer.push({ event: "ab_conversion", ab_goal_id: "g_cta", ab_goal_name: "CTA click", ab_extra: null });
```

- GTM の data layer は push を**マージ**し、省略したキーは同じページ内で前の値を保つ。追加の key-value を `ab_extra` の下にまとめて毎回 `null` で消すのは、前のエクスペリエンスの追加キーが次の Exposure / Conversion に残らないようにするため
- GTM 側では、データレイヤーの変数(**バージョン 2**)で `ab_extra.test_group` のようにドット区切りで取り出す
- 分析は `ab_exposure` でセグメントを作り、`ab_conversion` を比べる。Exposure の後に残る標準キーの値が他のイベントから見えることは許容している(消すのはイベントの push の直前だけ)

### サイト単位・エクスペリエンス単位の名前

サイト単位の名札はサイト設定の `外部計測の名前(dataLayer の名札)` の 10 項目([11 節](#11-サイト設定項目の全一覧))。エクスペリエンス / パターン単位では、エクスペリエンス名・パターン名の**値**と、`extra` の追加 key-value を上書きできる。

- エクスペリエンス名はエクスペリエンス側の `experimentName`、パターン名はパターン側の `variantName` で上書きする(無ければそれぞれの `name`)
- レベルをまたぐ上書き(エクスペリエンス側で `variantName`、パターン側で `experimentName`)は受け付けない — 全パターンが同じ名前になったり、パターンごとにエクスペリエンス名が変わったりして、GA4 のセグメントが壊れるため
- `experimentId` / `variantId` / イベント名は上書きできない
- `extra` はキーごとにパターンの値がエクスペリエンスの値に優先する

### dataLayer の変数名

タグが push する配列の名前(既定 `dataLayer`)。GTM のスニペットで dataLayer の名前を変えているサイトだけ、スニペットの 4 番目の引数(既定のスニペットで `'dataLayer'` と書かれている所。`gtm.js` の URL の `l=` の値)と同じ名前にする。最後の引数はコンテナ ID(`GTM-XXXX`)なので、取り違えない。push する中身は上の形のままで、入れる配列だけが変わる。

- 使える名前は JavaScript の変数名として書けるもの: 英字・`_`・`$` で始まり、英数字と `_` と `$` だけの 64 字以内。`AB` と `__ab` はタグ自身が使うので指定できない
- その名前の配列が無ければタグが作る(GTM が後から読み込まれても処理される)。配列ではない値(`push` を持たない値)が既にある場合は、上書きせず push をやめる。エクスペリエンスの表示は続く
- 送り先は GTM と gtag.js の dataLayer だけを想定している。Adobe Client Data Layer(`adobeDataLayer`)や Tealium の `utag_data` は、push の扱いが違うため対象外

**名札を変えるときの注意**: 稼働中のエクスペリエンスがある状態でサイト単位の名札を変えると、GTM 側(カスタム イベント トリガー / データレイヤーの変数 / GA4 イベントタグのパラメータ)を同時に直さない限り、その時点から計測が途切れる。名札はエクスペリエンスの切れ目で変え、GTM の変更と同じタイミングで公開する。名札を変えたサイトでは [4.3](#43-ショートカット-json-をインポートする) の JSON は使えない。

### 検証規則(保存時と公開時。GA4 の実際の制限に合わせている)

- 名前は `^[A-Za-z][A-Za-z0-9_]{0,39}$`。`_` / `firebase_` / `ga_` / `google_` / `gtag.` で始まる名前は不可
- イベント名はさらに、`query_id` で始まるものと、GA4 の予約・自動収集イベント名(`page_view` / `click` / `session_start` など)が不可。Exposure と Conversion のイベント名は互いに別にする
- サイト単位の 7 つのキー名は互いに別にし、`event` は使えない
- 値(`extra` の値と、`experimentName` / `variantName` などの上書き値)は文字列 1〜100 字。1 エクスペリエンス × パターンの `extra` は 20 キーまで
- エクスペリエンス / パターン / 目標の `name` が 100 字を超えると GA4 側で値が捨てられる(管理画面は保存時に拒否する)
- `extra` はパターンごとに複製されて配信用の設定に焼き込まれるので、エクスペリエンス単位の `extra` は 512KB のサイズ上限に対してパターンの数だけ効く(超えると公開が `config_too_large` で失敗する)

拒否する GA4 の予約・自動収集イベント名のリストは GA4 のヘルプの写しで、**GA4 側で後から増えたものには追随しない**。受け付けてしまった予約名のイベントは GA4 が記録せずに捨てる(DebugView で確認できる)。エクスペリエンスは止まらず、影響は名前を変えた運用者の計測の欠落に限られる。

## 13. ブラウザの制約

訪問者 ID は Cookie に持つため、ブラウザごとの Cookie の寿命が、同じ訪問者に同じパターンを出し続けられるかを左右する。

| ブラウザ | JavaScript で書いた Cookie(Mode A / Mode C) | HTTP `Set-Cookie`(Mode B) |
|---|---|---|
| Safari | 「**7 日間サイト操作なし**」で消える(JavaScript で書いた Cookie / localStorage / IndexedDB が対象)。一律 7 日の上限は 2020 年に廃止された。トラッカーと判定されたドメインからのリンク装飾付きの流入では 24 時間 | 真の first-party なら寿命の上限なし。ただし CNAME cloaking や、応答 IP の上位 16 ビットがページと異なる場合(Safari 16.4 以降)は 7 日 |
| Brave | 2025-08 の v1.83 で JavaScript の Cookie の 7 日上限を撤廃し、HTTP と同じ**最大 180 日**に揃えた。Safari 型の「操作なし N 日で削除」は無い。ただし **Shields の既定設定で GTM / GA4 のスクリプトが遮断される**ため、Brave の訪問者にはエクスペリエンスは出て Cookie も残るが、`ab_exposure` / `ab_conversion` は GA4 に届かない(`dataLayer` への push は行われる)。Brave の訪問者は分析の母数・分子から欠ける前提で読む | 最大 180 日(GA4 の計測は既定で不可) |
| Chrome / Edge | first-party Cookie の寿命の制限なし(一般仕様の 400 日上限のみ) | 同左 |
| Firefox | first-party Cookie の寿命の制限なし。ETP のストレージ分離は third-party が対象 | 同左 |

出典(Brave): [brave-browser issue #48063](https://github.com/brave/brave-browser/issues/48063) / [brave-core PR #30479](https://github.com/brave/brave-core/pull/30479)。

**Safari 対策**は Mode B(サーバー発行 Cookie。[8 節](#8-mode-c-と-mode-b))。同じゾーンの Workers Route から HTTP `Set-Cookie`(HttpOnly)で発行するので、「7 日間サイト操作なし」の対象にならない。サイトが Cloudflare のゾーン配下に無い場合は Mode A のまま運用することになる。定期的に再訪する訪問者が中心のサイトなら 7 日の間隔に収まるが、月 1 回程度しか来ない訪問者が中心のサイトでは、Safari のシェアの分だけ「初回扱い」(割当のリセット = 別のパターンを引き直す)が増える。

プライベートブラウズ / シークレットウィンドウでは、訪問をまたいで識別できない。その場合はセッション内だけの A/B テストとして動く(エラーにはしない)。

## 14. 外部送信規律への対応

**日本国内向けのサイトが対象。** それ以外のサイトは読み飛ばしてよい。

日本の電気通信事業法の「外部送信規律」は、利用者の端末から**外部へ情報を送信させる**仕組みについて、通知・公表などを求める制度。このツールを設置したページはブラウザから Worker へ情報を送るので、**対象になり得る。該当するかの判断と公表はサイト運営者が行う。**

以下は、運営者が自サイトの「外部送信ポリシー」などに記載するための情報の一覧。

| 送信先 | 送信される情報 | 利用目的 | Cookie |
|---|---|---|---|
| 運営者自身の Cloudflare アカウント上で動く Worker(`<設置ホスト>` の Route)。第三者への送信ではない | **decision**(エクスペリエンスの割当の要求): `v`(設定のバージョン)、`url`(閲覧中のページの URL。クエリ・フラグメントを含む)、`referrer`(参照元の URL)、`device`(`desktop` / `mobile` / `tablet` の判定結果)、`viewport`(ブラウザの表示領域の幅・高さ)、`browser`(ブラウザの判定結果)、`os`(OS の判定結果)、`firstVisitAt`(初回の訪問時刻。匿名の ID の発行時刻から読み取る)、`visitorId`(Mode A。ツールが発行した匿名の ID。ID の先頭に発行時刻(初回の訪問日時)を含む) | A/B テストの割当(どのパターンを出すか)の決定 | `_ab_vid`(`正本 Cookie 名`。ツールが発行する匿名の識別子。値の先頭に発行時刻(初回の訪問日時)を含む。Mode C でも、初回の訪問の時刻を持つためだけに置く)、`UUID Cookie` を有効にしている場合はその Cookie(正本から導出した UUID) |
| 同上 | **event**(目標の達成・同意の撤回): `type`(`goal` / `forget`)、`goalId`(達成した目標の識別子。`type` が `goal` のとき)、`visitorId`(Mode A) | A/B テストの効果測定(Conversion の計上)、および同意撤回時のサーバー側の履歴の削除 | 同上 |

- **明示的な拒否(`denied`)の間は、`consentMode` に関係なく Cookie も送信も発生しない。** `window.__ab` の事前状態が `denied` の場合と、`AB.consent(false)` で撤回された後がこれにあたる。`pending`(同意も拒否もまだ)で止まるのは `consentMode: "required"` のサイトだけで、**既定の `consentMode: "implicit"` では `pending` を無視してすぐに動き、上の表の送信を行う**。同意を得てから送信を始める形にするには `required` を選ぶ([7 節](#7-consent-の配線cmp-を使うサイト))
- **ツールは氏名・メールアドレスなどの入力項目を持たない。** 訪問者 ID はツールが発行する乱数、または Mode C ではサイトの既存 ID を `SHA-256(site_salt + 値)` に変換した値([8 節](#8-mode-c-と-mode-b)。変換元が個人データの場合の扱いは同節を参照)
- **ただし `url`(閲覧中のページの URL)と `referrer` は加工せずにそのまま送る。** URL のクエリやフラグメントに個人情報(メールアドレス、氏名、会員 ID など)が含まれるページに設置すると、それも送信内容に含まれる。設置するページの URL 設計を確認し、含まれ得るなら公表用の情報一覧にその旨を書く
- **Mode C** でも匿名の Cookie(`_ab_vid`)を置く。識別には使わず、判定の要求にはこの ID を含めず初回の訪問時刻(`firstVisitAt`)だけを送る([8 節](#8-mode-c-と-mode-b))
- **Mode B** では、HTTP `Set-Cookie` で発行した HttpOnly Cookie が `/__ab/*` への要求に自動的に付く(`visitorId` は本文に含めない。この Cookie の値にも発行時刻(初回の訪問日時)が含まれる)
- **プレビューを設置タグ経由で開いたときだけ**、設置タグと同じオリジンからスクリプト 1 本(`/s/preview/<hash>.js`)を追加で読む(設置タグの nonce 付き)。これは読み込みだけで、訪問者の情報を送らない。通常の訪問者は読まない
- **GA4 / GTM への送信はこのツールの送信ではない。** タグはサイトの `dataLayer` に push するだけで、そこから先は GTM のタグが送る。GA4 / GTM は運営者の外部送信ポリシーに既に書かれているはずの送信先で、このツールが増やすのはイベント名とパラメータ([12 節](#12-datalayer-の契約と命名の規則))だけ

制度の詳細は総務省のページを参照: https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/gaibusoushin_kiritsu_00001.html
