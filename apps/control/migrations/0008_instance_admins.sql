-- 決定 53(B36): システム管理者(instance admin)。この導入(Cloudflare アカウント上の 1 デプロイ)全体を見渡す管理者。
-- 不変条件 = ここに居る人は、すべてのワークスペース(organization)に role = 'owner' の Member 行をちょうど 1 行持つ
-- (作成・昇格・降格の SQL は src/instance-admins.ts、ほかの書き込みは各文の条件で保つ)

-- (a)(b) 同じワークスペースに同じ人の行が 2 つ以上あれば Role の高い 1 行を残し、以後は UNIQUE 索引で禁じる
DELETE FROM member WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY "organizationId", "userId"
      ORDER BY CASE role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC, "createdAt", id
    ) AS rn
    FROM member
  ) WHERE rn > 1
);
CREATE UNIQUE INDEX member_organization_user_unique ON member ("organizationId", "userId");

-- (c)
CREATE TABLE instance_admins (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  granted_by TEXT,
  created_at INTEGER NOT NULL
);

-- (d) 既存の導入: 最初に作られたワークスペースの OWNER 全員を登録する(新しい導入では organization が空なので何も入らず、/setup が登録する)
INSERT INTO instance_admins (user_id, granted_by, created_at)
SELECT DISTINCT m."userId", NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM member m
WHERE m.role = 'owner'
  AND m."organizationId" = (SELECT id FROM organization ORDER BY "createdAt", id LIMIT 1);

-- (e) 不変条件を作る(scripts/instance-admins-repair.sql と同じ 2 文。変えるときは両方を直す)
UPDATE member SET role = 'owner'
WHERE "userId" IN (SELECT user_id FROM instance_admins) AND role != 'owner';
INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
SELECT lower(hex(randomblob(16))), o.id, a.user_id, 'owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM organization o CROSS JOIN instance_admins a
WHERE NOT EXISTS (SELECT 1 FROM member m WHERE m."organizationId" = o.id AND m."userId" = a.user_id);
