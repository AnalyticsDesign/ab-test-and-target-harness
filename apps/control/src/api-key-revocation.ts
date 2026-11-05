import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import { sqlStatement } from "./db";

/**
 * backlog B156(security_triage_v2 の G16): メンバーから外す・システム管理者から外すときに、その人の鍵を同じ batch で失効させる文。
 * 決定 55 (6)(要求のたびに持ち主がいま範囲を使えるかを見る)だけだと、外している間は 401 でも、同じ人をメンバーに戻すと外す前の鍵が
 * 生き返る(外している間は管理者の「メンバーの API キー」の一覧にも出ず、失効もできない)。(6) の判定は残し、外すときの失効を足す。
 *
 * 失効の形は決定 55 (8) どおり: 正の表 apikey_revocations への挿入(既に失効済みの鍵は重ねない)+ apikey.enabled = 0。
 *
 * metadata の読み方は roles.ts の parseKeyMetadata と同じにする: 保存はふつう JSON のオブジェクト(Better Auth 1.4.21 が書く形。
 * テストで確かめた)だが、古い形の二重に JSON 化された文字列(JSON の文字列の中にオブジェクトの JSON)も 1 段ほどいて読む。
 * **読めない metadata の鍵(壊れた JSON・ほどいても JSON でない文字列)は失効の対象にしない**: どのワークスペースの鍵かが分からず、
 * 決定 55 (5) により範囲の読めない鍵は元から 401(使えない)なので、外す・戻すで使えるようにはならない。
 * SQLite の json_* は壊れた JSON でエラーを投げ、batch ごと(= メンバーを外す文ごと)失敗させるので、json_valid を CASE で先に見る
 * (CASE は条件を順に評価して、当たった枝だけを評価する)
 *
 * B129: 文は Kysely の `sql` で組む(条件の断片 `revocableKeys`・guard を、記録の文と共有するため)
 */

/** metadata の列を、範囲を読める JSON(二重なら 1 段ほどいたもの)に写す式。読めなければ NULL */
export const readableKeyMetadata = (col: Expression<unknown>): RawBuilder<string | null> => sql`case
  when not json_valid(${col}) then null
  when json_type(${col}) = 'text' then case when json_valid(json_extract(${col}, '$')) then json_extract(${col}, '$') end
  else ${col}
end`;

/**
 * B129: 鍵の範囲のワークスペースの ID(scope = workspace の鍵の workspaceId)。フルの鍵・読めない metadata は NULL。
 * 自分の鍵の失効の記録(`api_key.revoke`)の workspace_id を、記録の文の中で metadata から読む
 */
export const keyWorkspaceId = (col: Expression<unknown>): RawBuilder<string | null> => {
  const m = readableKeyMetadata(col);
  return sql`case when json_extract(${m}, '$.scope') = 'workspace' then json_extract(${m}, '$.workspaceId') end`;
};

export type RevokeKeysTarget =
  /** その人の、このワークスペースの鍵(metadata の scope = workspace かつ workspaceId = このワークスペース) */
  | { kind: "workspace"; workspaceId: string }
  /** その人のフルの鍵(scope = full。上限の有無に関わらない) */
  | { kind: "full" }
  /**
   * その人の、もうメンバーでないワークスペースの鍵(scope = workspace で、workspaceId のワークスペースにその人の Member 行が無い)。
   * システム管理者から外す batch で、Member 行を消す文の後に置く(元のロールに戻るワークスペースは行が残るので対象にならない)
   */
  | { kind: "workspaces_left" };

/**
 * 失効の対象の鍵(「どの鍵か」: その人の・範囲が target に当たる・まだ失効していない鍵)の `id` の 1 列を返す SELECT。
 * 失効の文と、B129 の記録(`member.remove` の `revokedKeys`。Q19)が同じ断片を使う(数えた本数と失効した本数をずらさない)。
 * 「外す処理が実際に行われた」印(guard)は含めない
 */
export function revocableKeys(userId: string, target: RevokeKeysTarget): RawBuilder<{ id: string }> {
  const scopeMatch =
    target.kind === "workspace"
      ? sql`json_extract(k.m, '$.scope') = 'workspace' and json_extract(k.m, '$.workspaceId') = ${target.workspaceId}`
      : target.kind === "workspaces_left"
        ? sql`json_extract(k.m, '$.scope') = 'workspace'
           and not exists (select 1 from member mm where mm."organizationId" = json_extract(k.m, '$.workspaceId') and mm."userId" = ${userId})`
        : sql`json_extract(k.m, '$.scope') = 'full'`;
  return sql`select k.id as id from (select a.id as id, ${readableKeyMetadata(sql.ref("a.metadata"))} as m from apikey a where a.userId = ${userId}) k
    where k.m is not null and ${scopeMatch}
      and not exists (select 1 from apikey_revocations r where r.key_id = k.id)`;
}

/**
 * 失効の 2 文(挿入 → enabled = 0)。batch の中で、外す文と同じトランザクションに入れる。
 * `guard` は「外す処理が実際に行われた」ときだけ真になる条件(Kysely の `sql` の式)。
 * 外す文が 0 行(409 の分岐)のときに鍵を失効させないため
 */
export function revokeKeysStatements(
  DB: D1Database,
  args: { userId: string; target: RevokeKeysTarget; revokedBy: string | null; now: number; guard: Expression<SqlBool> },
): D1PreparedStatement[] {
  const { userId, target, revokedBy, now, guard } = args;
  return [
    sqlStatement(
      DB,
      sql`insert into apikey_revocations (key_id, revoked_at, revoked_by)
        select v.id, ${now}, ${revokedBy} from (${revocableKeys(userId, target)}) v
        where ${guard}`,
    ),
    // 失効の表にあるその人の鍵は enabled = 0 にそろえる(Better Auth 側の判定にも効かせる。boolean = 整数の保存形式)
    DB.prepare(`update apikey set enabled = 0 where userId = ?1 and coalesce(enabled, 1) != 0 and id in (select key_id from apikey_revocations)`).bind(userId),
  ];
}
