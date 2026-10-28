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
 */

/** metadata の列を、範囲を読める JSON(二重なら 1 段ほどいたもの)に写す式。読めなければ NULL */
const readableMetadata = (col: string) => `case
  when not json_valid(${col}) then null
  when json_type(${col}) = 'text' then case when json_valid(json_extract(${col}, '$')) then json_extract(${col}, '$') end
  else ${col}
end`;

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
 * 失効の 2 文(挿入 → enabled = 0)。batch の中で、外す文と同じトランザクションに入れる。
 * `guard` は「外す処理が実際に行われた」ときだけ真になる SQL の条件(?1 = 対象の user ID、kind = workspace では ?4 = ワークスペース ID を使える)。
 * 外す文が 0 行(409 の分岐)のときに鍵を失効させないため
 */
export function revokeKeysStatements(
  DB: D1Database,
  args: { userId: string; target: RevokeKeysTarget; revokedBy: string | null; now: number; guard: string },
): D1PreparedStatement[] {
  const { userId, target, revokedBy, now, guard } = args;
  const scopeMatch =
    target.kind === "workspace"
      ? `json_extract(k.m, '$.scope') = 'workspace' and json_extract(k.m, '$.workspaceId') = ?4`
      : target.kind === "workspaces_left"
        ? `json_extract(k.m, '$.scope') = 'workspace'
           and not exists (select 1 from member mm where mm."organizationId" = json_extract(k.m, '$.workspaceId') and mm."userId" = ?1)`
        : `json_extract(k.m, '$.scope') = 'full'`;
  const insert = DB.prepare(
    `insert into apikey_revocations (key_id, revoked_at, revoked_by)
     select k.id, ?2, ?3 from (select a.id as id, ${readableMetadata("a.metadata")} as m from apikey a where a.userId = ?1) k
     where k.m is not null and ${scopeMatch}
       and not exists (select 1 from apikey_revocations r where r.key_id = k.id)
       and ${guard}`,
  );
  return [
    target.kind === "workspace" ? insert.bind(userId, now, revokedBy, target.workspaceId) : insert.bind(userId, now, revokedBy),
    // 失効の表にあるその人の鍵は enabled = 0 にそろえる(Better Auth 側の判定にも効かせる。boolean = 整数の保存形式)
    DB.prepare(`update apikey set enabled = 0 where userId = ?1 and coalesce(enabled, 1) != 0 and id in (select key_id from apikey_revocations)`).bind(userId),
  ];
}
