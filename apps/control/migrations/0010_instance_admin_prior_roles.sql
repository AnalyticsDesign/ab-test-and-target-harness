-- B46(決定 53 (15)): システム管理者に昇格した人の、昇格前のワークスペースとロール。
-- 外すとき、ここにあるワークスペースは元のロールに戻し、無いワークスペースからは外す(src/instance-admins.ts)。
-- ワークスペース・ユーザーの削除で一緒に消える
CREATE TABLE instance_admin_prior_roles (
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organization("id") ON DELETE CASCADE,
  role TEXT NOT NULL,
  -- epoch ミリ秒。記録を書いた昇格の instance_admins.created_at と同じ値。違えば古い記録 = コードだけの巻き戻しを挟んだ昇格の残り = 記録なしとして扱う
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, organization_id)
);
