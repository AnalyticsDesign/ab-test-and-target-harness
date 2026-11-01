-- B155(G26): 削除したサイトの ID。別のワークスペースが同じ ID でサイトを作るのを断る(ページに残った設置タグの乗っ取りを防ぐ)。
-- 同じワークスペースの作り直しは通す。元のワークスペースが消えていればシステム管理者だけが作れる(control が判定する)。
-- FK を付けない: sites に付けるとサイトの削除で、organization に付けるとワークスペースの削除で行が消えるため。
-- 行は消さない(期限なし。タグは何年もページに残りうる)。同じ ID を同じワークスペースで作り直して再び消したら、上書きする。
-- 足すだけの変更。control より前に流す(新しい control はこの表を読む)
CREATE TABLE retired_site_ids (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  retired_at INTEGER NOT NULL
);
-- 削除の記録はトリガーで積む(Q9)。本当の削除(サイトの削除・ワークスペースの削除の FK の CASCADE)はどれも先に static_removing の token を
-- 付けてから消す。作成の途中で行を消して戻す所は、ふつう static_removing が null の行を消すので積まない(途中で別の削除が token を付けていれば積む。安全側)。
-- migration の後なら、古い control の削除も記録される(入れ替えの間の取りこぼしが無い)
CREATE TRIGGER retire_site_id_on_delete AFTER DELETE ON sites
WHEN OLD.static_removing IS NOT NULL
BEGIN
  INSERT INTO retired_site_ids (id, workspace_id, retired_at)
  VALUES (OLD.id, OLD.workspace_id, CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, retired_at = excluded.retired_at;
END;
-- 別のワークスペースの退役の ID には入れない(Q10)。古い control の作成(退役の表を見ない)も含め、どの経路の INSERT も断る。
-- システム管理者の取り直しは、control が同じ batch の中で先に退役の行を作る先のワークスペースに付け替えてから入れる
CREATE TRIGGER reject_retired_site_id_on_insert BEFORE INSERT ON sites
WHEN EXISTS (SELECT 1 FROM retired_site_ids r WHERE r.id = NEW.id AND r.workspace_id <> NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'retired_site_id');
END;
