import { sql, type RawBuilder } from "kysely";
import type { AuditCategory, AuditVia } from "@wtt/core";
import type { SiteRow } from "./db";

/**
 * B129(spec §6・§4.1・§10.2): 操作の記録(表 audit_events)を読む部品。経路は routes/audit-events.ts。
 *
 * - 新しい順(`at desc, id desc`)。1 回 100 件まで。続きはカーソル(`<at>.<id>` を base64url にした文字列)で、`(at, id) < (?, ?)` の
 *   行値の比較で読む(同じ at の行が並んでも抜け・重なりが無い)。1 回に読む記録は limit + 1 行(続きがあるかの 1 行)まで
 * - **使う索引は INDEXED BY で固定する**(Q18・Q27)。統計(sqlite_stat1)が入っても、偏ったデータで別の索引に切り替わらないように。
 *   部分索引(`*_access_at`・`*_pw_at`)の条件は literal で書く(`category = 'access'`・`via in ('password', 'break_glass')`)。
 *   bind の値では部分索引が使えない(INDEXED BY が「使えない」で失敗する)。EXPLAIN QUERY PLAN と rows_read は test/audit-read.test.ts
 * - **変更履歴は世代の一致で引く**(Q14。時刻の比較は使わない): 認可したサイトの workspace_id・site_id・experiment_id・
 *   エクスペリエンスの今の世代(記録の文の中の副問い合わせで読む。往復を増やさない)・サイトの今の世代(loadSite が読んだ行の値)
 * - 操作した人の今の有無(人が消えていればメールを出さない)は `"user"` との LEFT JOIN で同じ文で読む(1 行あたり読む行 + 1)。
 *   導入全体の記録はワークスペースの今の名前も同じく organization との LEFT JOIN(1 行あたり + 1)
 * - **メールアドレスの出し分け**(spec §6.1・Q5b・Review Focus 2): 実効ロール(鍵の上限を当てた後)が管理者未満の見え方では、
 *   メールアドレスを出さない。入りうる所は次の 3 つ(記録を書く所を足すときは、ここに当てはまるかを見る)
 *   1. actor_email(操作した人の控え)→ `actor.email` を null。名前が空なら、メールの @ より前を名前にする
 *   2. target_label(対象の種類が user・invitation の行は宛先のメール)→ @ より前だけにする
 *   3. detail の文字列(今は api_key.revoke_member の `owner`)→ メールアドレスの形の文字列を null にする(鍵の名前を問わず効く)
 * - **API キーには招待の ID を出さない**(spec §6.4): 対象が invitation の行の target.id を null(招待の一覧が鍵に id・url を隠すのと同じ理由)。
 *   detail には招待の ID・受諾 URL を書いていない(書く所を足すときは、ここで落とす)
 */

export const AUDIT_PAGE_MAX = 100;
const DAY_MS = 86_400_000;
/** since の既定(30 日前)と、丸める限り(365 日前。保持の期間) */
export const AUDIT_DEFAULT_SINCE_DAYS = 30;
export const AUDIT_MAX_SINCE_DAYS = 365;

export type AuditCursor = { at: number; id: number };

const toBase64Url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function encodeAuditCursor(c: AuditCursor): string {
  return toBase64Url(`${c.at}.${c.id}`);
}

/** 読めないカーソルは null(呼び出し元が 422 validation_failed にする) */
export function decodeAuditCursor(s: string): AuditCursor | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) return null;
  let text: string;
  try {
    text = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const m = /^(\d{1,16})\.(\d{1,16})$/.exec(text);
  if (!m) return null;
  const at = Number(m[1]);
  const id = Number(m[2]);
  return Number.isSafeInteger(at) && Number.isSafeInteger(id) ? { at, id } : null;
}

/** 範囲(since は 365 日前に丸める。until は省略 = 今) */
export function auditRange(q: { since?: number; until?: number }, now = Date.now()): { since: number; until: number } {
  const floor = now - AUDIT_MAX_SINCE_DAYS * DAY_MS;
  return { since: Math.max(q.since ?? now - AUDIT_DEFAULT_SINCE_DAYS * DAY_MS, floor), until: q.until ?? now };
}

/** 一覧の範囲。workspace = ワークスペースの記録 / instance = 導入全体の記録(workspaceId: 省略 = すべて、null = 導入全体の行だけ) */
export type AuditListScope = { kind: "workspace"; workspaceId: string } | { kind: "instance"; workspaceId?: string | null };
export type AuditPage = { cursor: AuditCursor | null; limit: number };
export type AuditListFilter = AuditPage & { since: number; until: number; category?: AuditCategory; elevated?: boolean };

/** 一覧の 1 行(読む列)。workspace_name は導入全体の記録だけ */
export type AuditReadRow = {
  id: number;
  at: number;
  category: AuditCategory;
  action: string;
  workspace_id: string | null;
  site_id: string | null;
  experiment_id: string | null;
  via: AuditVia;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  /** 操作した人の user の行が今もあるか(1 / 0) */
  actor_exists: number;
  api_key_id: string | null;
  api_key_name: string | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  detail_json: string;
  workspace_name?: string | null;
};

const READ_COLUMNS = sql`a.id, a.at, a.category, a.action, a.workspace_id, a.site_id, a.experiment_id, a.via,
  a.actor_user_id, a.actor_email, a.actor_name, (u.id is not null) as actor_exists, a.api_key_id, a.api_key_name,
  a.target_type, a.target_id, a.target_label, a.detail_json`;
const ACTOR_JOIN = sql`left join "user" u on u.id = a.actor_user_id`;
const ORDER = sql`order by a.at desc, a.id desc`;
const cursorCondition = (cursor: AuditCursor | null) => (cursor ? sql` and (a.at, a.id) < (${cursor.at}, ${cursor.id})` : sql``);

/** 部分索引の条件(literal。索引の WHERE と同じ字面で書く) */
const ACCESS_ONLY = sql.raw(`a.category = 'access'`);
const ELEVATED_ONLY = sql.raw(`a.via in ('password', 'break_glass')`);

/**
 * 絞り込みに使う索引(spec §10.2 の見込み。Q18・Q27)。ワークスペースを決める(ワークスペースの記録・導入全体の workspaceId 指定)ときは ws_* を、
 * パスワード・非常口だけは *_pw_at、人とアクセス権は *_access_at、それ以外(サイト・エクスペリエンスを含む)は ws_at・at(category は残りの絞り込み)
 */
export function auditListIndex(scope: AuditListScope, f: Pick<AuditListFilter, "category" | "elevated">): string {
  const ws = scope.kind === "workspace" || scope.workspaceId !== undefined;
  const kind = f.elevated ? "pw_" : f.category === "access" ? "access_" : "";
  return `audit_events_${ws ? "ws_" : ""}${kind}at`;
}

/** ワークスペースの記録・導入全体の記録の 1 文(1 往復)。返すのは limit + 1 行まで */
export function auditListQuery(scope: AuditListScope, f: AuditListFilter): RawBuilder<AuditReadRow> {
  const index = auditListIndex(scope, f);
  const wid = scope.workspaceId;
  const conditions = [sql`a.at >= ${f.since}`, sql`a.at <= ${f.until}`];
  if (wid !== undefined) conditions.unshift(wid === null ? sql`a.workspace_id is null` : sql`a.workspace_id = ${wid}`);
  if (f.elevated) conditions.push(ELEVATED_ONLY);
  if (f.category === "access") conditions.push(ACCESS_ONLY);
  else if (f.category === "content") conditions.push(sql.raw(`a.category = 'content'`));
  const instance = scope.kind === "instance";
  return sql<AuditReadRow>`select ${READ_COLUMNS}${instance ? sql`, o.name as workspace_name` : sql``}
    from audit_events as a indexed by ${sql.raw(index)}
    ${ACTOR_JOIN}${instance ? sql` left join organization o on o.id = a.workspace_id` : sql``}
    where ${sql.join(conditions, sql` and `)}${cursorCondition(f.cursor)}
    ${ORDER} limit ${f.limit + 1}`;
}

/**
 * 変更履歴の 1 文(1 往復)。エクスペリエンスの今の世代は副問い合わせで読む(作った人の照会と並べて投げられるように。行が無ければ null で 0 行)。
 * site = loadSite が認可したサイト(workspace_id と今の世代)
 */
export function auditHistoryQuery(site: Pick<SiteRow, "id" | "workspace_id" | "generation">, experimentId: string, page: AuditPage): RawBuilder<AuditReadRow> {
  return sql<AuditReadRow>`select ${READ_COLUMNS}
    from audit_events as a indexed by audit_events_exp_at
    ${ACTOR_JOIN}
    where a.site_id = ${site.id} and a.experiment_id = ${experimentId}
      and a.experiment_generation = (select generation from experiments where site_id = ${site.id} and id = ${experimentId})
      and a.workspace_id = ${site.workspace_id} and a.site_generation = ${site.generation}${cursorCondition(page.cursor)}
    ${ORDER} limit ${page.limit + 1}`;
}

/** 作った人・最後に変えた人の行(D4)。エクスペリエンスが無ければ 0 行(呼び出し元が 404) */
export type ExperimentPeopleRow = {
  created_by: string;
  created_name: string | null;
  created_email: string | null;
  updated_by: string;
  updated_name: string | null;
  updated_email: string | null;
};
export function experimentPeopleQuery(siteId: string, experimentId: string): RawBuilder<ExperimentPeopleRow> {
  return sql<ExperimentPeopleRow>`select e.created_by, cu.name as created_name, cu.email as created_email,
      e.updated_by, uu.name as updated_name, uu.email as updated_email
    from experiments e left join "user" cu on cu.id = e.created_by left join "user" uu on uu.id = e.updated_by
    where e.site_id = ${siteId} and e.id = ${experimentId}`;
}

/** 応答の見え方。showEmail = 実効ロールが管理者以上(導入全体の記録はシステム管理者)/ hideInvitationIds = API キーからの呼び出し */
export type AuditView = { showEmail: boolean; hideInvitationIds: boolean };

const localPart = (email: string | null): string | null => (email ? (email.split("@")[0] ?? null) : null);
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+$/;
/**
 * 名前。空なら(記録の控え・今の user の行のどちらでも)メールの @ より前。
 * 管理者未満の見え方(showEmail が偽)で、名前そのものがメールアドレスの形なら @ より前だけにする(名前にメールアドレスを入れた人)
 */
const nameOf = (name: string | null, email: string | null, view: Pick<AuditView, "showEmail">): string | null => {
  if (!name || name.trim() === "") return localPart(email);
  return withoutEmail(name, view);
};
/** 管理者未満の見え方で、メールアドレスの形の名前(人の名前・API キーの名前)を @ より前だけにする */
const withoutEmail = (name: string, view: Pick<AuditView, "showEmail">): string =>
  !view.showEmail && EMAIL_LIKE.test(name.trim()) ? (localPart(name.trim()) ?? name) : name;

/** 人(作った人・最後に変えた人)。消えていれば email も name も null(控えが無い) */
export function personJson(userId: string, name: string | null, email: string | null, view: Pick<AuditView, "showEmail">): { userId: string; name: string | null; email: string | null } {
  if (email === null) return { userId, name: null, email: null };
  return { userId, name: nameOf(name, email, view), email: view.showEmail ? email : null };
}

function maskDetail(v: unknown): unknown {
  if (typeof v === "string") return EMAIL_LIKE.test(v) ? null : v;
  if (Array.isArray(v)) return v.map(maskDetail);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDetail(x)]));
  return v;
}

function parseDetail(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 1 行を応答の形にする(spec §6.4) */
export function toAuditEventJson(r: AuditReadRow, view: AuditView) {
  const emailTarget = r.target_type === "user" || r.target_type === "invitation";
  const detail = parseDetail(r.detail_json);
  return {
    id: String(r.id),
    at: r.at,
    category: r.category,
    action: r.action,
    workspaceId: r.workspace_id,
    siteId: r.site_id,
    experimentId: r.experiment_id,
    via: r.via,
    actor:
      r.actor_user_id === null
        ? null
        : {
            userId: r.actor_user_id,
            // 人が消えていればメールを出さない(名前は控え)
            email: view.showEmail && r.actor_exists ? r.actor_email : null,
            name: nameOf(r.actor_name, r.actor_email, view),
          },
    // 鍵の名前にメールアドレスを入れた人(B129 final review): 人の名前と同じく、管理者未満には @ より前だけ
    apiKey: r.api_key_id === null ? null : { id: r.api_key_id, name: r.api_key_name === null ? null : withoutEmail(r.api_key_name, view) },
    target:
      r.target_type === null
        ? null
        : {
            type: r.target_type,
            id: view.hideInvitationIds && r.target_type === "invitation" ? null : r.target_id,
            label: !view.showEmail && emailTarget ? localPart(r.target_label) : r.target_label,
          },
    detail: view.showEmail ? detail : (maskDetail(detail) as Record<string, unknown>),
    ...(r.workspace_name !== undefined ? { workspaceName: r.workspace_name } : {}),
  };
}

/** 1 ページの応答(limit + 1 行を読んだ結果から、limit 件と続きのカーソル) */
export function auditPageJson(rows: readonly AuditReadRow[], limit: number, view: AuditView) {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { events: page.map((r) => toAuditEventJson(r, view)), nextCursor: rows.length > limit && last ? encodeAuditCursor({ at: last.at, id: last.id }) : null };
}
