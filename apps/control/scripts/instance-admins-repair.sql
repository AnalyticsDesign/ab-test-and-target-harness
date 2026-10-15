-- システム管理者の不変条件を直す(冪等)。更新の後、control を deploy してから 1 回流す
-- 内容は migrations の instance_admins の (e) と同じ 2 文。変えるときは両方を直す
UPDATE member SET role = 'owner'
WHERE "userId" IN (SELECT user_id FROM instance_admins) AND role != 'owner';
INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
SELECT lower(hex(randomblob(16))), o.id, a.user_id, 'owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM organization o CROSS JOIN instance_admins a
WHERE NOT EXISTS (SELECT 1 FROM member m WHERE m."organizationId" = o.id AND m."userId" = a.user_id);
