-- B148: タグを置くドメインの一覧(domains_json)。[{ value, verdict, checkedAt, triedAt }] の JSON。
-- 一覧が正で、今の 3 列(domain・allowed_origins_json・hosts_json)は control が保存のたびに一覧から導いて書く(KV の設定の記録・edge・runtime は 3 列の形のまま読む)。
-- 移行の規則(P7): 一覧は hosts と allowedOrigins のホスト(と開発用の Origin)だけで作る。並びは hosts → allowedOrigins、重複は先に出た行を残す。
-- domain はその中にあるときだけ先頭に置き、無ければ一覧の最初の行が代表になる。hosts と allowedOrigins が両方とも空のサイトだけ domain 1 行にする。
-- 判定: hosts にあった行は Mode B なら edge、Mode A なら unknown。https でポートの無い Origin は unknown、http・ポート付きの Origin は dev(Origin の形のまま持つ)。
-- 50 行を超えるサイトも全行を残す(P9)。3 列は同じマイグレーションで一覧から書き直す(apps/control/src/domains.ts の deriveDomainColumns と同じ規則)。
-- sites の UPDATE と site_hosts の DELETE だけ(0021 のトリガーは sites の INSERT・DELETE にだけ付いている)。control より前に流す
ALTER TABLE sites ADD COLUMN domains_json TEXT NOT NULL DEFAULT '[]';

-- P11: 両方とも空で共有がオンのサイトは、一覧が domain 1 行になり共有の範囲が広がるので、共有をオフにして B139 の移行(Cron の衝突の検査)に任せる。
-- 利用者がオフにしたサイト(オフ・印 0)は条件に当たらない(共有オンだけを見る)
UPDATE sites SET share_subdomains = 0, share_migration_pending = 1
WHERE share_subdomains = 1 AND json_array_length(hosts_json) = 0 AND json_array_length(allowed_origins_json) = 0;

-- 一覧を作る
UPDATE sites SET domains_json = CASE
  WHEN json_array_length(hosts_json) = 0 AND json_array_length(allowed_origins_json) = 0
    THEN json_array(json_object('value', domain, 'verdict', 'unknown', 'checkedAt', NULL, 'triedAt', NULL))
  ELSE (
    SELECT json_group_array(json_object('value', c.value, 'verdict', c.verdict, 'checkedAt', NULL, 'triedAt', NULL))
    FROM (
      SELECT d.value, d.verdict
      FROM (
        -- 同じ値は並びの早い行だけを残す
        SELECT u.value, u.verdict, u.sort, row_number() OVER (PARTITION BY u.value ORDER BY u.sort) AS nth
        FROM (
          -- hosts(添字の順)
          SELECT lower(h.value) AS value, CASE WHEN sites.mode = 'B' THEN 'edge' ELSE 'unknown' END AS verdict, h.key AS sort
          FROM json_each(sites.hosts_json) AS h
          UNION ALL
          -- allowedOrigins(hosts の後)。https でポートが無ければホスト名、http かポート付きなら開発用の Origin
          SELECT CASE WHEN o.dev THEN o.origin ELSE o.rest END, CASE WHEN o.dev THEN 'dev' ELSE 'unknown' END, 1000000 + o.sort
          FROM (
            SELECT e.key AS sort
              , lower(e.value) AS origin
              , substr(lower(e.value), instr(e.value, '://') + 3) AS rest
              , (lower(e.value) LIKE 'http://%' OR instr(substr(e.value, instr(e.value, '://') + 3), ':') > 0) AS dev
            FROM json_each(sites.allowed_origins_json) AS e
          ) AS o
        ) AS u
      ) AS d
      WHERE d.nth = 1
      -- domain と同じ値の行を先頭に(開発用の行は Origin の形なので当たらない)
      ORDER BY CASE WHEN d.value = sites.domain THEN -1 ELSE d.sort END
    ) AS c
  )
END;

-- 3 列を一覧から書き直す(deriveDomainColumns と同じ規則)。
-- domain = 先頭行のホスト名(開発用の行は Origin からホスト名を取る) / allowedOrigins = 全行の Origin / hosts = Mode B の edge の行だけ(Mode A は空)
UPDATE sites SET
  domain = (
    SELECT CASE
      WHEN f.verdict <> 'dev' THEN f.value
      WHEN f.rest LIKE '[%' THEN substr(f.rest, 1, instr(f.rest, ']'))
      WHEN instr(f.rest, ':') > 0 THEN substr(f.rest, 1, instr(f.rest, ':') - 1)
      ELSE f.rest
    END
    FROM (
      SELECT json_extract(j.value, '$.value') AS value
        , json_extract(j.value, '$.verdict') AS verdict
        , substr(json_extract(j.value, '$.value'), instr(json_extract(j.value, '$.value'), '://') + 3) AS rest
      FROM json_each(sites.domains_json) AS j
      WHERE j.key = 0
    ) AS f
  )
  , allowed_origins_json = (
    SELECT json_group_array(CASE WHEN json_extract(j.value, '$.verdict') = 'dev' THEN json_extract(j.value, '$.value') ELSE 'https://' || json_extract(j.value, '$.value') END)
    FROM (SELECT value FROM json_each(sites.domains_json) ORDER BY key) AS j
  )
  , hosts_json = CASE
    WHEN mode = 'B' THEN (
      SELECT json_group_array(json_extract(j.value, '$.value'))
      FROM (SELECT value FROM json_each(sites.domains_json) WHERE json_extract(value, '$.verdict') = 'edge' ORDER BY key) AS j
    )
    ELSE '[]'
  END;

-- Mode A のサイトに残っていた hosts は上で空になったので、ホストの持ち主の行も手放す(別のサイトが取れるように)。
-- KV のホストのキーは残る(edge はそのホストで Mode A の設定を読み 404 を返す。キーが無いときと同じ動き。別のサイトが取れば上書きされる)
DELETE FROM site_hosts WHERE site_id IN (SELECT id FROM sites WHERE mode = 'A');
