import type { Context } from "hono";
import type { AppEnv } from "./app";
import { ApiError, siteIdTaken } from "./errors";
import { canViewWorkspace } from "./roles";

// B155(G26): 削除したサイトの ID(retired_site_ids。記録は migrations/0021 のトリガー)。
// 作成では別のワークスペースの退役の ID を断る。最後の砦は D1 のトリガー reject_retired_site_id_on_insert(Q10)で、ここは 409 の文を決める側

export type SiteIdState = { live: boolean; retiredWorkspaceId: string | null; retiredWorkspaceExists: boolean };

/** 作成の確かめの 1 文(1 往復)。同じ ID のサイトがあるか・退役の行の元のワークスペース・そのワークスペースが残っているか */
export async function readSiteIdState(d1: D1Database, id: string): Promise<SiteIdState> {
  const row = await d1
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM sites WHERE id = ?1) AS live,
       r.workspace_id AS retiredWorkspaceId,
       EXISTS (SELECT 1 FROM organization o WHERE o.id = r.workspace_id) AS retiredWorkspaceExists
       FROM (SELECT 1) LEFT JOIN retired_site_ids r ON r.id = ?1`,
    )
    .bind(id)
    .first<{ live: number; retiredWorkspaceId: string | null; retiredWorkspaceExists: number }>();
  // FROM (SELECT 1) なので行は必ず 1 つ。EXISTS は 0 / 1 の数で返る
  return { live: row?.live === 1, retiredWorkspaceId: row?.retiredWorkspaceId ?? null, retiredWorkspaceExists: row?.retiredWorkspaceExists === 1 };
}

/**
 * システム管理者の取り直し(元のワークスペースが消えた退役の ID)のときだけ、作成の batch の先頭(INSERT の前)に置く。
 * fromWorkspaceId = 確かめで読んだ元のワークスペース。確かめの後に退役の行が変わっていれば 0 行で、続く INSERT をトリガーが断る(Q10)
 */
export function reassignRetiredStatement(d1: D1Database, id: string, toWorkspaceId: string, fromWorkspaceId: string): D1PreparedStatement {
  return d1.prepare("UPDATE retired_site_ids SET workspace_id = ?2 WHERE id = ?1 AND workspace_id = ?3").bind(id, toWorkspaceId, fromWorkspaceId);
}

/**
 * batch の例外が、トリガーの RAISE(ABORT, 'retired_site_id')(migrations/0021 の reject_retired_site_id_on_insert)によるものか。
 * D1 の binding の文は `D1_ERROR: retired_site_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`(テストで固定)。
 * 表の名前 retired_site_ids(末尾 s)には当たらないよう語の境界で見る
 */
export const isRetiredSiteIdAbort = (e: unknown): boolean => /\bretired_site_id\b/.test(String(e));

/**
 * 退役の ID に当たったときの 409(Q7)。kind = "elsewhere"(元のワークスペースが残る)で、作る人がそのワークスペースを見られるときだけ reason と詳しい文。
 * それ以外(見られない人・"admin_only" のすべて)は今あるサイトと同じ本文(過去の利用も元のワークスペースの存否も明かさない)。
 * 見られるかの確かめ(0〜1 往復)は "elsewhere" のときだけ
 */
export async function retiredSiteIdTaken(c: Context<AppEnv>, id: string, retiredWorkspaceId: string, kind: "elsewhere" | "admin_only"): Promise<ApiError> {
  if (kind === "elsewhere" && (await canViewWorkspace(c, retiredWorkspaceId)))
    return new ApiError(409, "site_id_taken", {
      id,
      reason: "retired_elsewhere",
      message: "このサイト ID は、別のワークスペースで削除したサイトが使っていたため使えません",
      hint: "別の ID を指定してください。削除したサイトを作り直すときは、そのサイトがあったワークスペースで作成してください",
    });
  return siteIdTaken(id);
}
