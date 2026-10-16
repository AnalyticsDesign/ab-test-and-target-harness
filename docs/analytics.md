# 分析ガイド

実験の結果を読むための手引き。イベントは GTM の `dataLayer` 経由で GA4 に届き、そこから **GA4 の探索レポート(方式 A)** か **BigQuery エクスポート(方式 B)** で集計する。ツール本体は数値を持たず、集計しない([運用ガイド](operations.md)の管理画面にも Variant 別 CVR は出ない)。

設置とタグの配線は[サイト導入ガイド](site-install.md)が前提。

## 1. 何が測れるか

runtime が送るイベントは 2 種類だけ(既定名。名札は Site 単位で変更できる → [サイト導入ガイド 12 節](site-install.md#12-datalayer-の契約と命名の規則))。

| イベント | いつ | 主なパラメータ |
|---|---|---|
| `ab_exposure` | 訪問者に Variant が適用されたとき(Experiment ごとに 1 ページ 1 回) | `ab_experiment_id` / `ab_experiment_name` / `ab_variant_id` / `ab_variant_name` |
| `ab_conversion` | Goal を達成したとき(`AB.track()` / Goal の検知) | `ab_goal_id` / `ab_goal_name` |

**パーソナライズの `ab_exposure`**: 種別がパーソナライズのエクスペリエンスも、テストと同じく変更を表示したページの読み込みごとに `ab_exposure` を送る(「誰が変更を見たか」を GA4 で切り出せるようにするため)。条件に合う訪問者全員に表示するので、テストより回数が増える。GA4 の標準プロパティの BigQuery への日次エクスポートは 1 日 100 万イベントまでなので、量が気になるサイトは GTM のトリガーで `ab_experiment_id` を除外する。パターンは 1 つなので、比較と SRM の確認は意味を持たない(`analytics-recipe` の `notes` にも出る)。

**`ab_conversion` には Experiment / Variant が付かない**。コンバージョンは「どの実験のせいで起きたか」を runtime が決められないため、あえて付けていない。したがって Variant 別 CVR は、次のように **2 つの集合を突き合わせて**出す。

- 母数 = 「Variant `a` の `ab_exposure` を持つ訪問者の集合」の人数
- 分子 = その集合のうち、対象 Goal の `ab_conversion` を持つ人数

この突き合わせを、方式 A ではセグメントで、方式 B では SQL の JOIN でやる。方式 A は「露出より後の conversion だけ数える」といった時間条件を書けないので、**厳密な数字が要るなら方式 B**([5 節](#5-方式-b-bigquery))を使う。

**統計判定(有意差・必要サンプル数・逐次検定)は範囲外**(Phase 2)。この文書が出すのは母数・分子・比率までで、差が本物かどうかの判断は読み手の側でやる。

## 2. 前提の設定

### (a) イベントスコープのカスタムディメンション 3 件(必須)

GA4 はプロパティに登録していないイベントパラメータをレポートの次元として受け付けない。`ab_experiment_id` / `ab_variant_id` / `ab_goal_id`(名札を変えた Site はその名前)を **イベントスコープのカスタムディメンション**として登録する。手順(管理画面 / GA Admin API の両方)は[サイト導入ガイド 4 節](site-install.md#4-ga4-と-gtm-をつなぐ)にある。

**登録前に届いたイベントは遡って次元にならない**。設置と同時に済ませること。

### (b) データ保持期間を 14 か月に変更

GA4 → 管理 → データの収集と修正 → **データ保持** → イベントデータの保持 = **14 か月**。

既定は 2 か月で、それより古い期間は探索レポート(方式 A)で参照できなくなる。BigQuery にエクスポート済みのデータはこの設定の影響を受けないが、方式 A を使うなら先に伸ばしておく。

### (c) BigQuery のリンク(方式 B を使うなら)

GA4 → 管理 → **BigQuery のリンク** → リンクを作成 → GCP プロジェクトを選び、**日次**エクスポートを有効にする。

- データセット名は `analytics_<GA4 プロパティ ID>` が自動で作られる
- **初回のテーブルは翌日以降**に着地する。リンクした当日は `events_YYYYMMDD` が 1 つも無い
- 日次エクスポートのテーブルは `events_YYYYMMDD` のみ。当日ぶんの `events_intraday_YYYYMMDD`(ストリーミングエクスポートを別に有効にした場合)は、この文書の SQL の走査対象ではない

### (d) サイトに外部 ID を設定する

サイトに `ga4PropertyId` と `bigqueryDataset` を入れておくと、[3 節](#3-レシピの取得)の `analytics-recipe` がプロパティ ID とデータセット名を埋めた状態で返る。**未設定のときは `{{GA4_PROPERTY_ID}}` / `{{BQ_DATASET}}` というプレースホルダのまま返る**(自分で置換すれば動く)。

管理画面では **「設定」→「外部 ID」**(管理者以上)で設定する。API から設定する場合は `PATCH /sites/<siteId>`(**管理者以上**、API キー):

```bash
curl -sS -X PATCH "<control URL>/sites/<siteId>" \
  -H "Authorization: Bearer $AB_API_KEY" -H 'content-type: application/json' \
  -d '{"ga4PropertyId":"<GA4 プロパティ ID>","bigqueryDataset":"<GCP プロジェクト ID>.analytics_<GA4 プロパティ ID>"}'
```

- `ga4PropertyId` は**数値のプロパティ ID**(`G-` で始まる測定 ID ではない。GA4 → 管理 → プロパティ設定)
- `bigqueryDataset` は `<GCP プロジェクト ID>.<データセット名>` の形(ドット区切り。データセット単体では受け付けない)
- 解除するには `null` を送る

## 3. レシピの取得

```bash
curl -sS "<control URL>/sites/<siteId>/experiments/<experimentId>/analytics-recipe" \
  -H "Authorization: Bearer $AB_API_KEY"
```

- **閲覧者以上**。API キーの作り方は[エージェント向けガイド](agent-guide.md)を参照
- 返るのは **クエリであって数値ではない**。control は GA4 にも BigQuery にも接続しない
- 期間は Experiment の `started_at`〜`stopped_at`(未停止なら現在時刻)。一時停止 / 再開では `started_at` は動かない。未開始の Experiment は作成日が起点になる(まだデータは無い)
- 中身は `ga4.exposureByVariant` / `ga4.conversionsByGoal`([6 節](#6-ga4-data-api-の-2-本))、`bigquery.visitorCvrSql` / `sessionCvrSql` / `mixedExposureCountSql`([5 節](#5-方式-b-bigquery))、`goals`、`notes`

> **この API の応答が正**である。以下に載せる SQL とリクエストは `apps/control/src/recipe.ts` が組み立てるものの**写し**で、命名設定・期間・外部 ID を実際の値で埋めたものは API 応答にしか無い。手で書き写さず、応答をそのまま実行すること。

エージェント向けの同じ説明は[エージェントガイドのレシピ 3](agent-guide.md#レシピ-3-結果を読む)にある。

## 4. 方式 A: GA4 探索レポート

BigQuery を使わずに、GA4 の探索レポートだけで Variant 別の母数と分子を見る。厳密さは方式 B に劣る(下の「制約」)が、リンクの翌日を待たずに当日から見られる。

### セグメントを 2 つ作る

GA4 → **探索** → **空白**(自由形式)を開く。

1. 「セグメント」の **+** → **ユーザーセグメント**
2. 条件: イベント **`ab_exposure`** を選び、**パラメータで絞り込み**(同一イベント上の AND 条件)
   - `ab_experiment_id` **完全一致** `<experimentId>`
   - **AND** `ab_variant_id` **完全一致** `a`
3. 名前を `Variant a` にして保存
4. 同じ手順で `Variant b`(イベント `ab_exposure` かつ `ab_experiment_id` = `<experimentId>` かつ `ab_variant_id` = `b`)を作る

条件は**イベントセグメント**ではなく**ユーザーセグメント**にする。conversion には Variant が付かないので、「露出したユーザー」という集合を作ってからその人たちの別イベントを数える必要がある。

Variant が 3 つ以上ある実験では、Variant の数だけセグメントを作る(1 つの探索に置けるセグメント数には上限があるので、足りなければ画面で確認して探索を分ける)。

### 表を 2 つに分ける

**同じ表からは母数と分子を同時に読めない**。探索のフィルタは表示中のデータを AND で絞り込むので、`ab_conversion` に絞った表には `ab_exposure` の行が残らない。タブを分ける。

| | 母数表(タブ 1) | 分子表(タブ 2) |
|---|---|---|
| セグメント | `Variant a` / `Variant b` | `Variant a` / `Variant b` |
| ディメンション | イベント名 | イベント名 |
| 指標 | 総ユーザー数、イベント数 | 総ユーザー数、イベント数 |
| フィルタ | 無し | イベント名 = `ab_conversion` **かつ** `ab_goal_id` = `<goalId>` |
| 読む値 | 行 `ab_exposure` の **総ユーザー数** | 行 `ab_conversion` の **総ユーザー数** |

日付範囲は実験期間(`analytics-recipe` の `period`)に合わせる。

### 読み方

- 各セグメントの `ab_exposure` の総ユーザー数 = **母数**
- 各セグメントの `ab_conversion`(対象 Goal)の総ユーザー数 = **分子**
- CVR = 分子 ÷ 母数

### 制約(方式 B と数字がずれる理由)

- **サンプリングとしきい値**: 探索レポートはデータ量が多いとサンプリングされ、ユーザー数が少ないとしきい値でゼロに丸められることがある(カードの上部にアイコンが出る)
- **混在露出を除外できない**: 両方の Variant に露出したユーザーは**両方のセグメントに入る**。方式 B は初回露出の片方だけに帰属させる
- **露出前の conversion を除外できない**: セグメントは「期間内に露出したユーザー」を集めるだけで、その conversion が露出の前か後かを問わない
- **期間の粒度が日単位**: 実験の開始・停止が日の途中なら、その日の対象外の時刻のイベントも入る。方式 B は `event_timestamp`(UTC マイクロ秒)で切る

## 5. 方式 B: BigQuery

GA4 export を SQL で集計する。露出より後の conversion だけを数え、混在露出を初回に帰属させ、期間を時刻で切る — 方式 A の制約はここで解ける。

`analytics-recipe` の `bigquery` に 3 本入っている。

| キー | 単位 | 出す列 |
|---|---|---|
| `visitorCvrSql` | 訪問者(`user_pseudo_id`) | `variant_id` / `goal_id` / `visitors` / `converters` / `cvr` |
| `sessionCvrSql` | セッション(`user_pseudo_id` + `ga_session_id`) | `variant_id` / `goal_id` / `sessions` / `converting_sessions` / `cvr` |
| `mixedExposureCountSql` | — | `mixed_visitors` / `mixed_sessions` / `visitors` / `sessions` |

### 実行

```bash
SID=<siteId>; EID=<experimentId>
curl -sS "<control URL>/sites/$SID/experiments/$EID/analytics-recipe" \
  -H "Authorization: Bearer $AB_API_KEY" | jq -r '.bigquery.visitorCvrSql' > recipe.sql
bq query --use_legacy_sql=false --format=prettyjson < recipe.sql
```

`sessionCvrSql` / `mixedExposureCountSql` も同じ要領で取り出して流す。`bq` が無ければ BigQuery コンソールのクエリエディタに貼っても同じ。

課金せずに構文だけ確かめるなら `--dry_run` を付ける(走査バイト数が返るだけでクエリは実行されない)。

```bash
bq query --use_legacy_sql=false --dry_run < recipe.sql
```

**当日ぶんの日次テーブルはまだ存在しない**。`events_YYYYMMDD` は翌日に着地し、ストリーミングエクスポートを有効にしていなければ `events_intraday_YYYYMMDD` も無い(有効にしてあっても、この文書の SQL は `events_intraday_*` を走査しない → [8 節](#8-よくある詰まり))。

### 訪問者単位の CVR(`visitorCvrSql`)

以下は `apps/control/src/recipe.ts` が組み立てる形の写し(既定の名札の場合)。`<BQ データセット>` は `<GCP プロジェクト ID>.analytics_<GA4 プロパティ ID>`、`_TABLE_SUFFIX` の 2 つは `<開始日>` の前日と `<終了日>` の翌日(`YYYYMMDD`)、`event_timestamp` の 2 つは開始・終了時刻の UTC マイクロ秒。**正は API 応答**。応答の SQL に `{{BQ_DATASET}}` が残っているときは Site に外部 ID が未設定なので、[2 節 (d)](#d-サイトに外部-id-を設定する)で設定する(自分で置換してもよい)。

```sql
-- 訪問者単位のパターン別 CVR
-- 単位 = user_pseudo_id。最初の exposure より後の conversion だけを数える。
-- 複数パターンに露出した訪問者は**除外せず**、期間内の初回露出のパターンに帰属させる(intention-to-treat)
WITH exposure AS (
  SELECT
    user_pseudo_id,
    (SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = 'ab_experiment_id') AS experiment_id,
    (SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = 'ab_variant_id') AS variant_id,
    TIMESTAMP_MICROS(event_timestamp) AS exposed_at,
    -- 同一 timestamp の露出から「初回」を決めるための GA4 export の順序列
    batch_page_id,
    batch_ordering_id,
    batch_event_index
  FROM `<BQ データセット>.events_*`
  WHERE _TABLE_SUFFIX BETWEEN '<開始日の前日 YYYYMMDD>' AND '<終了日の翌日 YYYYMMDD>'
    AND event_timestamp BETWEEN <開始時刻 µs> AND <終了時刻 µs>
    AND event_name = 'ab_exposure'
),
assigned AS (
  -- 初回露出の 1 行だけを採る = 帰属するパターンと、その後の conversion を数える起点。
  -- GA4 は同じリクエストで送った複数イベントに同じ event_timestamp を付けることがあるので、batch 内の順序列で並びを固定する
  -- (順序列も等しい場合は不定。NULL は末尾に置く)
  SELECT user_pseudo_id, variant_id, exposed_at
  FROM (
    SELECT
      user_pseudo_id,
      variant_id,
      exposed_at,
      ROW_NUMBER() OVER (PARTITION BY user_pseudo_id ORDER BY exposed_at, batch_page_id NULLS LAST, batch_ordering_id NULLS LAST, batch_event_index NULLS LAST) AS rn
    FROM exposure
    WHERE experiment_id = '<experimentId>' AND variant_id IS NOT NULL
  )
  WHERE rn = 1
),
conversion AS (
  SELECT
    user_pseudo_id,
    (SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = 'ab_goal_id') AS goal_id,
    TIMESTAMP_MICROS(event_timestamp) AS converted_at
  FROM `<BQ データセット>.events_*`
  WHERE _TABLE_SUFFIX BETWEEN '<開始日の前日 YYYYMMDD>' AND '<終了日の翌日 YYYYMMDD>'
    AND event_timestamp BETWEEN <開始時刻 µs> AND <終了時刻 µs>
    AND event_name = 'ab_conversion'
)
SELECT
  a.variant_id,
  g AS goal_id,
  COUNT(DISTINCT a.user_pseudo_id) AS visitors,
  COUNT(DISTINCT c.user_pseudo_id) AS converters,
  SAFE_DIVIDE(COUNT(DISTINCT c.user_pseudo_id), COUNT(DISTINCT a.user_pseudo_id)) AS cvr
FROM assigned a
CROSS JOIN UNNEST(ARRAY<STRING>['<goalId>']) AS g
LEFT JOIN conversion c
  ON c.user_pseudo_id = a.user_pseudo_id AND c.goal_id = g AND c.converted_at >= a.exposed_at
GROUP BY a.variant_id, g
ORDER BY a.variant_id, g
```

実行結果の形(実データの例):

```json
[{"converters":"0","cvr":"0.0","goal_id":"<goalId>","variant_id":"b","visitors":"1"}]
```

`ARRAY<STRING>[…]` にはその Site の Goal が**すべて**並ぶ(Variant × Goal で 1 行出る)。

### セッション単位の CVR(`sessionCvrSql`)

単位が `CONCAT(user_pseudo_id, '.', ga_session_id)` になるほかは同じ構造。露出したセッション内の、露出より後の conversion だけを数える。セッション内で複数 Variant に露出した場合も、そのセッションの初回露出の Variant に帰属させる。

```sql
-- セッション単位のパターン別 CVR(訪問者単位の併記)
-- 単位 = user_pseudo_id + ga_session_id。露出したセッション内の、露出より後の conversion だけを数える。
-- セッション内で複数パターンに露出した場合も除外せず、そのセッションの初回露出のパターンに帰属させる
WITH exposure AS (
  SELECT
    CONCAT(user_pseudo_id, '.', CAST((SELECT ep.value.int_value FROM UNNEST(event_params) ep WHERE ep.key = 'ga_session_id') AS STRING)) AS session_id,
    (SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = 'ab_experiment_id') AS experiment_id,
    (SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = 'ab_variant_id') AS variant_id,
    TIMESTAMP_MICROS(event_timestamp) AS exposed_at,
    -- 同一 timestamp の露出から「初回」を決めるための GA4 export の順序列
    batch_page_id,
    batch_ordering_id,
    batch_event_index
  FROM `<BQ データセット>.events_*`
  WHERE _TABLE_SUFFIX BETWEEN '<開始日の前日 YYYYMMDD>' AND '<終了日の翌日 YYYYMMDD>'
    AND event_timestamp BETWEEN <開始時刻 µs> AND <終了時刻 µs>
    AND event_name = 'ab_exposure'
),
assigned AS (
  -- セッション内の初回露出の 1 行だけを採る。同じ event_timestamp の露出は batch 内の順序列で並べる
  -- (順序列も等しい場合は不定。NULL は末尾)
  SELECT session_id, variant_id, exposed_at
  FROM (
    SELECT
      session_id,
      variant_id,
      exposed_at,
      ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY exposed_at, batch_page_id NULLS LAST, batch_ordering_id NULLS LAST, batch_event_index NULLS LAST) AS rn
    FROM exposure
    WHERE experiment_id = '<experimentId>' AND variant_id IS NOT NULL
  )
  WHERE rn = 1
),
conversion AS (
  SELECT
    CONCAT(user_pseudo_id, '.', CAST((SELECT ep.value.int_value FROM UNNEST(event_params) ep WHERE ep.key = 'ga_session_id') AS STRING)) AS session_id,
    (SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = 'ab_goal_id') AS goal_id,
    TIMESTAMP_MICROS(event_timestamp) AS converted_at
  FROM `<BQ データセット>.events_*`
  WHERE _TABLE_SUFFIX BETWEEN '<開始日の前日 YYYYMMDD>' AND '<終了日の翌日 YYYYMMDD>'
    AND event_timestamp BETWEEN <開始時刻 µs> AND <終了時刻 µs>
    AND event_name = 'ab_conversion'
)
SELECT
  a.variant_id,
  g AS goal_id,
  COUNT(DISTINCT a.session_id) AS sessions,
  COUNT(DISTINCT c.session_id) AS converting_sessions,
  SAFE_DIVIDE(COUNT(DISTINCT c.session_id), COUNT(DISTINCT a.session_id)) AS cvr
FROM assigned a
CROSS JOIN UNNEST(ARRAY<STRING>['<goalId>']) AS g
LEFT JOIN conversion c
  ON c.session_id = a.session_id AND c.goal_id = g AND c.converted_at >= a.exposed_at
GROUP BY a.variant_id, g
ORDER BY a.variant_id, g
```

実行結果の形(実データの例):

```json
[{"converting_sessions":"0","cvr":"0.0","goal_id":"<goalId>","sessions":"1","variant_id":"b"}]
```

### 混在露出の規模(`mixedExposureCountSql`)

CVR の 2 本は混在を母数に残すので、どれだけ混ざっているかはこれで確認する。

```sql
-- 複数パターンに露出した訪問者数 / セッション数
-- CVR の 2 本は初回露出に帰属させて母数に残すので、混在がどれだけあるかはここで確認する
WITH exposure AS (
  SELECT
    user_pseudo_id,
    CONCAT(user_pseudo_id, '.', CAST((SELECT ep.value.int_value FROM UNNEST(event_params) ep WHERE ep.key = 'ga_session_id') AS STRING)) AS session_id,
    (SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = 'ab_experiment_id') AS experiment_id,
    (SELECT ep.value.string_value FROM UNNEST(event_params) ep WHERE ep.key = 'ab_variant_id') AS variant_id
  FROM `<BQ データセット>.events_*`
  WHERE _TABLE_SUFFIX BETWEEN '<開始日の前日 YYYYMMDD>' AND '<終了日の翌日 YYYYMMDD>'
    AND event_timestamp BETWEEN <開始時刻 µs> AND <終了時刻 µs>
    AND event_name = 'ab_exposure'
),
scoped AS (
  SELECT * FROM exposure WHERE experiment_id = '<experimentId>' AND variant_id IS NOT NULL
)
SELECT
  (SELECT COUNT(*) FROM (SELECT user_pseudo_id FROM scoped GROUP BY user_pseudo_id HAVING COUNT(DISTINCT variant_id) > 1)) AS mixed_visitors,
  (SELECT COUNT(*) FROM (SELECT session_id FROM scoped GROUP BY session_id HAVING COUNT(DISTINCT variant_id) > 1)) AS mixed_sessions,
  (SELECT COUNT(DISTINCT user_pseudo_id) FROM scoped) AS visitors,
  (SELECT COUNT(DISTINCT session_id) FROM scoped) AS sessions
```

実行結果の形(実データの例):

```json
[{"mixed_sessions":"0","mixed_visitors":"0","sessions":"1","visitors":"1"}]
```

### 帰属の規則(`notes` の写し + 走査範囲の補足)

`analytics-recipe` の `notes` に入る注記。結果を人に報告するときはこれも併せて伝える(走査範囲を前後 1 日に広げている理由の項目だけは `notes` に無い補足)。

- 複数パターンに露出した訪問者 / セッションは、期間内の**初回露出のパターンに帰属**させる(intention-to-treat)。母数から除外はしない
- 混在の規模(複数パターンに露出した訪問者数 / セッション数)は `mixedExposureCountSql` で確認する
- 同じ `event_timestamp` の露出は GA4 export の batch 内順序列(`batch_page_id` / `batch_ordering_id` / `batch_event_index`)で並べて初回を決める。**順序列も等しい場合は不定**
- `_TABLE_SUFFIX` の走査範囲は `events_YYYYMMDD` のみで、当日ぶんの `events_intraday_YYYYMMDD` は含まない。配信中のエクスペリエンスでは**当日ぶんのイベントが日次エクスポートが着地するまで反映されない**
- (補足。`notes` には入らない)走査範囲を実験期間の UTC 日付の**前後 1 日**に広げているのは、GA4 export の日次テーブルの日付がプロパティのタイムゾーンで付き UTC と最大 1 日ずれるため。**採否は `event_timestamp` の条件**で決めるので、広げた分の期間外イベントは数えない
- Site に Goal が 1 つも無いと `visitorCvrSql` / `sessionCvrSql` は **0 行**を返す(`CROSS JOIN UNNEST` の配列が空になり、露出の母数すら出ない)。この場合は `notes` にその旨が追加される

## 6. GA4 Data API の 2 本

`analytics-recipe` の `ga4` には、そのまま送れる runReport リクエストが 2 本入る。`url` に `body` をそのまま POST する(プロパティは URL に入っているので、足すのは認証ヘッダだけ)。

| キー | 何が出るか | dimensions | metrics | dimensionFilter |
|---|---|---|---|---|
| `exposureByVariant` | Variant 別の露出 = **配分どおりか(SRM)の確認** | `customEvent:ab_variant_id` | `totalUsers` / `sessions` | `eventName` = `ab_exposure` **かつ** `customEvent:ab_experiment_id` = `<experimentId>` |
| `conversionsByGoal` | **Goal ごとの発生数**(Variant では割れない) | `customEvent:ab_goal_id` | `eventCount` / `totalUsers` | `eventName` = `ab_conversion` |

`conversionsByGoal` を Experiment で絞れないのは、conversion の payload に experiment / variant が入らないため([1 節](#1-何が測れるか))。Variant 別 CVR は方式 B か方式 A で出す。どちらも `dateRanges` は実験期間、`keepEmptyRows` は `false`。

### トークンと実行

アクセストークンは ADC(Application Default Credentials)で取る。

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform
T=$(gcloud auth application-default print-access-token)
```

Google Cloud 外のスコープ(`analytics.readonly` / `analytics.edit`)は既定の gcloud クライアントで拒否されることがある。その場合は独自の OAuth クライアント ID を作って `--client-id-file` で渡すか、サービスアカウントで実行する(Google の ADC トラブルシュート https://docs.cloud.google.com/docs/authentication/troubleshoot-adc#access_blocked_when_using_scopes)。

```bash
R=$(curl -sS "<control URL>/sites/<siteId>/experiments/<experimentId>/analytics-recipe" \
  -H "Authorization: Bearer $AB_API_KEY")
curl -sS -X POST "$(echo "$R" | jq -r '.ga4.exposureByVariant.url')" \
  -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d "$(echo "$R" | jq -c '.ga4.exposureByVariant.body')"
```

`exposureByVariant` を `conversionsByGoal` に替えればもう 1 本も同じ。ログインしたアカウントに対象 GA4 プロパティの閲覧権限が要る。

応答は `rows[].dimensionValues` / `metricValues` の並びで返る(実データの例。`metricValues` は `metricHeaders` の順 = `totalUsers` / `sessions`)。

```json
{
  "dimensionHeaders": [{ "name": "customEvent:ab_variant_id" }],
  "metricHeaders": [
    { "name": "totalUsers", "type": "TYPE_INTEGER" },
    { "name": "sessions", "type": "TYPE_INTEGER" }
  ],
  "rows": [
    { "dimensionValues": [{ "value": "a" }], "metricValues": [{ "value": "3" }, { "value": "3" }] },
    { "dimensionValues": [{ "value": "b" }], "metricValues": [{ "value": "2" }, { "value": "2" }] }
  ],
  "rowCount": 2
}
```

Conversion が 0 件の期間では `conversionsByGoal` の応答に **`rows` キー自体が無い**(空配列ではない)。`rowCount` も出ず、返るのは `dimensionHeaders` / `metricHeaders` / `metadata` だけになる。

## 7. 結果の読み方

- **分子 ≤ 母数**。方式 B でこれが破れることはない。方式 A で分子 > 母数に見えたら、母数側がしきい値やサンプリングで丸められている(分子表と母数表は同じセグメント・同じ日付範囲なので、分子に数えられるユーザーは本来必ず母数にも現れる)
- **`cvr` = `converters` ÷ `visitors`**(セッション単位なら `converting_sessions` ÷ `sessions`)。`SAFE_DIVIDE` なので母数 0 では `NULL`
- **混在露出の割合** = `mixed_visitors` ÷ `visitors`。これが大きいほど「Variant a の効果」という読み方が薄まる。数 % を超えるなら、実験の URL 条件や Targeting が訪問者を跨いで揺れていないか疑う
- **SRM(配分と露出比の乖離)**: `exposureByVariant` の `totalUsers` の比を設定した重みと見比べる。50:50 のはずが 55:45 のように離れていれば、割当か計測のどこかが壊れている疑い(目視でよい。検定は Phase 2)
- **期間外・露出前の除外は方式 B だけ**。方式 A の数字と方式 B の数字は原理的に一致しない。**片方に揃えて報告する**
- **統計判定は自分で**。この文書のクエリは記述統計まで

## 8. よくある詰まり

| 症状 | 原因 | 対処 |
|---|---|---|
| `runReport` が 400 `Field customEvent:… is not a valid dimension` | カスタムディメンションが未登録 | [2 節 (a)](#2-前提の設定)。登録前のイベントは遡って次元にならないので、登録後のデータで見直す |
| 探索のセグメント条件にパラメータが出てこない | 同上(未登録)、または登録直後 | 登録してから届いたイベントだけが対象。反映に時間がかかる |
| 自動化ブラウザ(headless)からのテスト訪問が GA4 に出ない | Playwright / Puppeteer の headless Chromium は UA が `HeadlessChrome` で、GA4 の既知ボット除外(無効化できない)で落ちる | DebugView・リアルタイム・レポート・BigQuery のどれにも出ない(`/g/collect` 自体は送られているので送信側では気づけない)。動作確認は通常の Chrome で行うか、`browser.newContext({ userAgent: <通常の Chrome の UA> })` のように UA を通常のものにする |
| BigQuery にデータセットが無い | リンク直後で初回エクスポート待ち | [2 節 (c)](#2-前提の設定)。テーブルは翌日以降 |
| `bq ls` が Not found | 同上 | 最初の日次テーブルはリンク作成の翌日に作られる。それまではデータセットごと見えない |
| `conversionsByGoal` の応答に `rows` が無い | その期間の Conversion が 0 件(空配列ではなくキーごと無い) | GTM の `CE - ab_conversion` トリガーと Goal の URL 条件を確認([サイト導入ガイド 4 節](site-install.md#4-ga4-と-gtm-をつなぐ)) |
| SQL が 0 行 | Goal が 1 つも無い / 期間に露出が無い / 実験が未開始 | `mixedExposureCountSql` は Goal 無しでも動くので、まずこれで露出の有無を切り分ける |
| GA4 に行が 0 | GTM の配線ミス、期間のずれ | [サイト導入ガイド 4 節](site-install.md#4-ga4-と-gtm-をつなぐ)の GTM 配線を確認し、GA4 の **DebugView** で `ab_exposure` / `ab_conversion` とパラメータが届いているか見る |
| リアルタイムに出ない | 反映遅れ | Realtime は数分、通常のレポートと探索は数時間から翌日。届いているかの確認は DebugView が速い |
| 当日ぶんが BigQuery に無い | 日次エクスポートは翌日着地 | 実行中の実験を当日中に見るなら方式 A。`events_intraday_*` はストリーミングエクスポートを有効にした場合だけ存在し、レシピの SQL は走査しない |
| 数字が方式 A と方式 B で合わない | 仕様どおり | [4 節の制約](#4-方式-a-ga4-探索レポート)。報告はどちらか一方に揃える |
