import type { Context } from "hono";
import { isExpression, sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import { AUDIT_ACTION_CATEGORY, type AuditAction, type AuditTargetType, type AuditVia } from "@wtt/core";
import type { AppEnv, SessionUser } from "./app";
import { asLoginMethod, type LoginMethod } from "./auth";
import { sqlCompiler as compiler } from "./db";

/**
 * B129(spec §3・§5): 管理の操作の記録(表 audit_events)を書く部品。読む API は別(plan Task 8)。
 *
 * 書き方は 3 つ(spec §3.1・§5.3):
 * - **batch**: `auditStatement` の 1 文を、操作が使う `env.DB.batch([...])` に積む(往復は増えない。記録が書けなければ操作ごと失敗)
 * - **前**: `writeAuditBefore`。操作の前に 1 文を実行し、失敗はそのまま投げる(操作を始めない = 500)
 * - **後**: `writeAuditAfter`(要求の文脈 c がある)/ `writeAuditAfterDb`(c が無い: 招待の受諾・Better Auth のフック)。
 *   組み立てを関数で受け取り、組み立てから INSERT までを 1 つの try で囲み、失敗は console.error だけ(操作は成功のまま返す。Q20)
 *
 * 操作した人(AuditActor)は、要求では `auditActor(c)`(requireSession が既に読んだ値だけ。追加の照会なし)、c が無い経路では
 * `actorFromUser(user, via)`、Cron は `systemActor`、非常用トークンは `breakGlassActor`。
 */

/** detail の上限(UTF-8 のバイト数。D8)。超えたら `{"truncated":true}` に置き換える */
export const AUDIT_DETAIL_MAX_BYTES = 2048;
/** 名前・対象の控え・detail の文字列の上限(文字数。D8) */
export const AUDIT_TEXT_MAX_CHARS = 200;
const TRUNCATED_DETAIL = '{"truncated":true}';

export type AuditActor = {
  via: AuditVia;
  /** NULL = 非常用トークン・Cron(操作した人なし) */
  userId: string | null;
  /** 以下は記録を書いた時点の控え */
  email: string | null;
  name: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
};

/** 操作した人が利用者のとき(セッション・API キー)。公開の published_by のように利用者の ID を要る所が受ける */
export type UserActor = AuditActor & { userId: string };

/** detail の値(Worker で作る値)。JSON にできるものだけ */
export type AuditJson = string | number | boolean | null | readonly AuditJson[] | { readonly [key: string]: AuditJson };
/** SQL の式(Kysely の `sql` の断片)。記録の文の中で評価する(前の値・件数など) */
export type AuditSql = Expression<unknown>;
/**
 * detail(spec §3.2)。鍵ごとに、値(AuditJson)か SQL の式(AuditSql)のどちらかを置ける。undefined の鍵は書かない(JSON.stringify と同じ)。
 * 決め方と組み合わせ方は auditStatement のコメント
 */
export type AuditDetail = { readonly [key: string]: AuditJson | AuditSql | undefined };

type AuditEventBase = {
  action: AuditAction;
  /**
   * NULL = 導入全体(システム管理者・使用状況の設定・非常口・ログイン)。spec §3.1 の `workspace_id` の列。
   * 記録の文の中で読むときは SQL の式(例: 鍵の失効は targetFrom が返す `t.workspace_id`。route が値を持たず、読むと往復が増えるため)
   */
  workspaceId?: string | null | AuditSql;
  siteId?: string | null;
  /** experiment.* だけ */
  experimentId?: string | null;
  /** 鍵ごとの detail か、detail 全体を作る SQL の式(更新の記録の changedFieldsDetail。JSON のオブジェクトを返す式) */
  detail?: AuditDetail | AuditSql;
  /**
   * 世代(Q14・Q29)。値を渡す口 = 作成(insert と同じ値を渡す)。渡さなければ、siteId があれば `sites`、siteId と experimentId があれば
   * `experiments` の今の行から記録の文の中で読む(更新・削除の前に置く記録)。行が無ければ NULL
   */
  generation?: { site?: string; experiment?: string };
};
/**
 * 対象は値で渡す(target の id・label)か、SQL で読む(targetFrom。target は type だけ)のどちらか。
 * targetFrom は `target_id`・`target_label` の 2 列(とほかに detail・guard が読む列)を返す SELECT で、記録の文の FROM に `t` として入る
 */
export type AuditEvent = AuditEventBase &
  (
    | { target?: { type: AuditTargetType; id?: string | null; label?: string | null }; targetFrom?: undefined }
    | { target: { type: AuditTargetType; id?: undefined; label?: undefined }; targetFrom: AuditSql }
  );

export type AuditStatementOpts = {
  /** 記録を書く条件(spec §5.2)。既定は真。targetFrom があれば `t.<列>` を読める */
  guard?: Expression<SqlBool>;
  /** 記録の at(epoch ミリ秒)。操作の文と同じ値を共有する(guard・失効の印 `revoked_at = ?now`) */
  now?: number;
};

const EMPTY_ACTOR = { userId: null, email: null, name: null, apiKeyId: null, apiKeyName: null } as const;
/** Cron(`break_glass.sweep` など) */
export const systemActor: AuditActor = { via: "system", ...EMPTY_ACTOR };
/** 非常用トークンの操作(`break_glass.reset_link`)。操作した人なし */
export const breakGlassActor: AuditActor = { via: "break_glass", ...EMPTY_ACTOR };

/** セッションの loginMethod から経路を決める。NULL・想定外の値は unknown */
const viaOfLoginMethod = (m: unknown): "google" | "password" | "unknown" => asLoginMethod(m) ?? "unknown";

/**
 * 要求の文脈から操作した人を作る(spec §5.1)。requireSession が設定した user・loginMethod・apiKey だけを使う(D1 を読まない)。
 * API キーの要求は経路 api_key と鍵の ID・名前、セッションはセッションを作った経路(印が無ければ unknown)
 */
export function auditActor(c: Pick<Context<AppEnv>, "get">): UserActor {
  const user = c.get("user");
  const key = c.get("apiKey");
  const base = { userId: user.id, email: user.email, name: capText(user.name) };
  if (key) return { via: "api_key", ...base, apiKeyId: key.id, apiKeyName: capText(key.name) };
  return { via: viaOfLoginMethod(c.get("loginMethod")), ...base, apiKeyId: null, apiKeyName: null };
}

/**
 * c に依存しない形で操作した人を作る(招待の受諾・初期設定・Better Auth のフック)。via は `setup`(初期設定)か、
 * セッションの loginMethod の値(google / password。NULL・想定外の値は unknown)
 */
export function actorFromUser(user: SessionUser, via: "setup" | LoginMethod | null | undefined): AuditActor {
  return { via: via === "setup" ? "setup" : viaOfLoginMethod(via), userId: user.id, email: user.email, name: capText(user.name), apiKeyId: null, apiKeyName: null };
}

/**
 * 記録の 1 文(`INSERT … SELECT … WHERE <guard>`)を返す。batch に積むか、writeAuditBefore / writeAuditAfter* が実行する。
 *
 * **文の形**(Task 3 以降はこの形に従う):
 * ```sql
 * insert into audit_events (…)
 * select …, substr(target_label, 1, 200), case when length(cast(detail_json as blob)) > 2048 then '{"truncated":true}' else detail_json end
 * from (select ?at, ?category, …, <site_generation>, <experiment_generation>, …, <target_id>, <target_label>, <detail> as detail_json
 *       from (<targetFrom>) as t            -- targetFrom があるときだけ
 *       where <guard> limit 1)
 * limit 1
 * ```
 *   外側の `limit 1` は、SQLite が内側の select を外側へ展開(flatten)しないためのもの(内側と外側の両方に LIMIT があると展開しない)。
 *   展開されると、外側の CASE の `length(…)` と `else detail_json` の 2 か所で detail の式(json_object とその中の副問い合わせ)が
 *   2 回評価される。展開しなければ内側は co-routine になり、detail は 1 回だけ評価される(テスト detail_is_evaluated_once)
 * - **SQL の断片は Kysely の `sql` で書く**(targetFrom・detail の SQL の値・guard)。値は `${…}` で埋め、bind は文の字面の順で付く
 *   (Kysely が並べる。呼び出し元は `?1` などの番号を振らない。spec §5.1 の「bind の順」は番号を手で振る書き方の決まりで、
 *   この文では呼び出し元が気にしなくてよい)。操作の文(`?1` の番号付きの生の SQL のままでよい)とは別の文なので、番号は干渉しない
 * - **targetFrom**: 対象の控えを D1 から読む SELECT。`target_id`・`target_label` の 2 列を必ず返し、detail・guard が読む列を足してよい
 *   (例: ロールの変更は `m.role as role` を返して `detail: { from: sql\`t.role\` }`・`guard: sql\`t.role != ${to}\``)。
 *   **0 行なら記録しない**(対象が無い = 操作も 0 行のはずの分岐で、guard の一部として働く)。複数行でも `limit 1` で 1 行にするが、
 *   主キーで 1 行に絞ること。target の type は値で渡す
 * - **detail**: 鍵ごとに値か SQL の式。すべて値なら Worker で JSON にする(文字列は 200 文字で切る)。SQL の式が 1 つでもあれば
 *   `json_object('k', json(?), 'k2', <式>, …)` を作る(値は JSON にして `json(?)` で埋める。鍵の順は書いた順)。
 *   SQL の式の結果は text → JSON の文字列、整数 → 数、NULL → null。JSON の配列・オブジェクトを入れるときは式を `json(…)` で包む
 *   (副問い合わせを越えると JSON の印が消え、文字列として入るため)。
 *   SQL の式は BLOB を返さないこと(json_object が BLOB を受け付けずに失敗し、記録の文ごと = batch ごと失敗する)。前の値は記録の文を操作の文の**前**に置いて同じ文で読む
 *   (例: `{ from: sql\`(select status from experiments where site_id = ${sid} and id = ${eid})\` }`)。
 *   件数は `sql\`(select count(*) from …)\``。名前など長くなりうる文字列を SQL で読むときは `substr(…, 1, 200)` で包む
 * - **大きさの上限**(D8): detail は全体の UTF-8 のバイト数が 2,048 を超えたら `{"truncated":true}`(外側の select の CASE で、値の detail にも
 *   SQL の detail にも同じく当たる。外側の `limit 1` で、式は内側で 1 回だけ評価する)。`target_label` は外側の `substr(…, 1, 200)`、
 *   actor の名前・API キーの名前・値の detail の文字列は Worker で 200 文字で切る。メールアドレス(actor_email)は切らない
 * - **更新の記録**(site.update・experiment.update・goal.update・audience.update・usage.settings_change): 値が変わった欄だけを記録する
 *   (B129 final review = R64)。detail 全体を changedFieldsDetail の SQL の式で渡す(欄ごとに auditChanged で今の行と比べる)
 * - **guard**(spec §5.2): 「操作が実際に行われた」ときだけ真になる条件。操作の文と同じ条件(記録を前に置く)か、この要求が書いた印
 *   (記録を後に置く)。`changes()` は使わない。既定は真(無条件)
 * - **category** は action から決める(`AUDIT_ACTION_CATEGORY`。呼び出し元は渡さない)
 * - **世代**は AuditEvent.generation のコメント。値を渡すか、渡さなければ記録の文の中で `sites`・`experiments` から読む
 */
export function auditStatement(DB: D1Database, actor: AuditActor, event: AuditEvent, opts: AuditStatementOpts = {}): D1PreparedStatement {
  const compiled = auditStatementQuery(actor, event, opts);
  return DB.prepare(compiled.sql).bind(...compiled.parameters);
}

/** auditStatement の SQL と bind(テストが EXPLAIN で評価の回数を見るために export する。本番のコードは auditStatement を使う) */
export function auditStatementQuery(actor: AuditActor, event: AuditEvent, opts: AuditStatementOpts = {}): { sql: string; parameters: readonly unknown[] } {
  const at = opts.now ?? Date.now();
  const siteId = event.siteId ?? null;
  const experimentId = event.experimentId ?? null;
  const siteGeneration =
    event.generation?.site !== undefined
      ? sql`${event.generation.site}`
      : siteId !== null
        ? sql`(select generation from sites where id = ${siteId})`
        : sql`null`;
  const experimentGeneration =
    event.generation?.experiment !== undefined
      ? sql`${event.generation.experiment}`
      : siteId !== null && experimentId !== null
        ? sql`(select generation from experiments where site_id = ${siteId} and id = ${experimentId})`
        : sql`null`;
  const targetId = event.targetFrom ? sql`t.target_id` : sql`${event.target?.id ?? null}`;
  const targetLabel = event.targetFrom ? sql`t.target_label` : sql`${capText(event.target?.label ?? null)}`;
  const from = event.targetFrom ? sql` from (${event.targetFrom}) as t` : sql``;
  const guard = opts.guard ?? sql<SqlBool>`1`;
  const inner = sql`select
      ${at} as at, ${AUDIT_ACTION_CATEGORY[event.action]} as category, ${event.action} as action,
      ${event.workspaceId ?? null} as workspace_id, ${siteId} as site_id, ${experimentId} as experiment_id,
      ${siteGeneration} as site_generation, ${experimentGeneration} as experiment_generation,
      ${actor.via} as via, ${actor.userId} as actor_user_id, ${actor.email} as actor_email, ${capText(actor.name)} as actor_name,
      ${actor.apiKeyId} as api_key_id, ${capText(actor.apiKeyName)} as api_key_name,
      ${event.target?.type ?? null} as target_type, ${targetId} as target_id, ${targetLabel} as target_label,
      ${detailExpression(event.detail)} as detail_json${from}
    where ${guard} limit 1`;
  const q = sql`insert into audit_events (at, category, action, workspace_id, site_id, experiment_id, site_generation, experiment_generation, via,
      actor_user_id, actor_email, actor_name, api_key_id, api_key_name, target_type, target_id, target_label, detail_json)
    select at, category, action, workspace_id, site_id, experiment_id, site_generation, experiment_generation, via,
      actor_user_id, actor_email, actor_name, api_key_id, api_key_name, target_type, target_id, substr(target_label, 1, ${sql.lit(AUDIT_TEXT_MAX_CHARS)}),
      case when length(cast(detail_json as blob)) > ${sql.lit(AUDIT_DETAIL_MAX_BYTES)} then ${sql.lit(TRUNCATED_DETAIL)} else detail_json end
    from (${inner})
    limit 1`;
  return q.compile(compiler);
}

/** 列の値(記録の文の中で比べる値。真偽は 0 / 1、JSON は文字列) */
export type AuditColumnValue = string | number | null;

/**
 * B129 final review(R64): 更新の記録の 1 欄。値が変わった欄だけを detail に入れる(changedFieldsDetail)
 * - `changed`: 欄の値が変わったか(記録の文の中で今の行と比べる式。auditChanged)
 * - `fromTo`: 前後を持つ短い値の欄の `{from, to}`(auditFromTo)。長い値の欄(配信条件・ドメインの一覧など)は省く(名前だけ)
 */
export type AuditFieldChange = { readonly key: string; readonly changed: Expression<SqlBool>; readonly fromTo?: AuditSql };

/**
 * 欄の値が変わったか。`column` = 記録の文で今の値を読む式(`t.<列>`)、`unchanged` = 「変わっていない」とみなす値(保存する値と、
 * それと同じ意味の読んだ行の値。unchangedValues)。どれとも `is` で一致しなければ真(NULL どうしも一致として比べる)。
 * 比べる値は保存する形(列に書く値)にそろえる: 真偽は 0 / 1、JSON は列に書く文字列
 */
export function auditChanged(column: AuditSql, unchanged: readonly AuditColumnValue[]): Expression<SqlBool> {
  const values = [...new Set(unchanged)];
  return sql<SqlBool>`not (${sql.join(values.map((v) => sql`${column} is ${v}`), sql` or `)})`;
}

/**
 * 「変わっていない」とみなす値の一覧: 保存する値(next)と、読んだ行の値(base)が同じ意味(same)ならその値も。
 * JSON の鍵の順・既定値の省略(null)のように、保存の形だけが違う値を「変わった」と数えないため(比べる相手は記録の文で読む今の行なので、
 * 読んだ後に別の保存が入った行は、保存する値と同じでなければ変わったと数える)
 */
export function unchangedValues<T extends AuditColumnValue>(next: T, base: T, same: (a: T, b: T) => boolean = (a, b) => a === b): AuditColumnValue[] {
  return same(base, next) && base !== next ? [next, base] : [next];
}

/** 鍵の順をそろえた JSON(配列の順は意味があるので保つ) */
function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x !== null && typeof x === "object")
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, norm((x as Record<string, unknown>)[k])]),
      );
    return x;
  };
  return JSON.stringify(norm(v));
}

/**
 * JSON の文字列(列の値)が同じ意味か: 鍵の順を問わない。`whenNull` を渡すと、null(列に値が無い)をその値として比べる(既定値の省略)。
 * 読めない JSON は文字列のまま比べる
 */
export function sameJsonText(a: AuditColumnValue, b: AuditColumnValue, whenNull?: unknown): boolean {
  const norm = (s: AuditColumnValue): string | null => {
    if (s === null) return whenNull === undefined ? null : canonicalJson(whenNull);
    try {
      return canonicalJson(JSON.parse(String(s)));
    } catch {
      return String(s);
    }
  };
  return norm(a) === norm(b);
}

/**
 * 前後(`{from, to}`)。from = 記録の文で読む式(長くなりうる文字列の列は呼び出し元が `substr(…, 1, 200)` で包む)、
 * to = 保存する値(文字列は from と同じく 200 文字で切る)
 */
export const auditFromTo = (from: AuditSql, to: AuditJson): AuditSql => sql`json(json_object('from', ${from}, 'to', json(${JSON.stringify(capStrings(to))})))`;

/** 記録の文で読む列のうち、文字列だけを 200 文字で切る(数・NULL はそのまま) */
export const auditCapText = (column: AuditSql): AuditSql => sql`case when typeof(${column}) = 'text' then substr(${column}, 1, ${sql.lit(AUDIT_TEXT_MAX_CHARS)}) else ${column} end`;

/**
 * 更新の記録の detail を記録の文の中で作る: `{fields: [変わった欄の名前(欄の順)], <欄>: {from, to}(前後を持つ欄のうち変わった欄だけ)}`。
 * 変わった欄が無ければ `{fields: []}`(操作は updated_at などを書くので、行は残す)。`names: false` は fields を持たない形
 * (使用状況の設定: 鍵そのものが変えた項目。変わらなければ `{}`)。
 * 作り方: すべての欄を入れた json_object から、変わっていない欄を json_remove で外す(外さない欄の道は、無い道 `$.__keep` にして何もしない)。
 * 往復は増えない(記録の文の中の式だけ)
 */
export function changedFieldsDetail(changes: readonly AuditFieldChange[], opts: { names?: boolean } = {}): AuditSql {
  const names = opts.names ?? true;
  if (changes.length === 0) return names ? sql`json_object('fields', json_array())` : sql`json_object()`;
  for (const c of changes) if (!AUDIT_FIELD_KEY.test(c.key)) throw new Error(`audit: field key must be an identifier: ${c.key}`);
  // 欄の名前と JSON の道は文の字面に書く(bind にしない)。D1 の 1 文の bind の上限(100)に、サイト設定の全部の欄(19)を送る保存でも
  // 届かないように: bind は欄ごとに比べる値(1〜2 個。前後を持つ欄は fields と鍵の 2 か所で比べるので 2 倍)と to の 1 個だけ
  const lit = (v: string) => sql.lit(v);
  const members = [
    ...(names ? [sql`'fields', json_array(${sql.join(changes.map((c) => lit(c.key)))})`] : []),
    ...changes.filter((c) => c.fromTo !== undefined).map((c) => sql`${lit(c.key)}, ${c.fromTo}`),
  ];
  if (members.length === 0) return sql`json_object()`;
  const keep = lit("$.__keep");
  const paths = [
    // 配列の要素は後ろから外す(前から外すと後ろの位置がずれる)
    ...(names ? changes.map((c, i) => sql`case when ${c.changed} then ${keep} else ${lit(`$.fields[${i}]`)} end`).reverse() : []),
    ...changes.filter((c) => c.fromTo !== undefined).map((c) => sql`case when ${c.changed} then ${keep} else ${lit(`$.${c.key}`)} end`),
  ];
  return sql`json_remove(json_object(${sql.join(members)}), ${sql.join(paths)})`;
}
/** 欄の名前(文の字面に書くので、識別子の形だけを受ける) */
const AUDIT_FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/** 「前」の書き方(spec §5.1): 操作の前に 1 文を実行する。失敗はそのまま投げる(呼び出し元は操作を始めない = 500) */
export async function writeAuditBefore(DB: D1Database, actor: AuditActor, event: AuditEvent, opts?: AuditStatementOpts): Promise<void> {
  await auditStatement(DB, actor, event, opts).run();
}

/**
 * 「後」の書き方(c が無い経路)。組み立て(actor・event。detail の JSON 化を含む)から INSERT までを 1 つの try で囲み、
 * 失敗は `console.error("audit: failed to record", { action, targetId }, { name, message })` だけ(投げない)。
 * メールアドレスはログに出さない: 例外はそのまま渡さず name と message だけを出す。組み立て(build)が投げる例外の文言に
 * メールアドレスを入れないこと(D1 の例外の文言は bind の値を含まない)。
 * waitUntil には回さない(応答の前に書く)
 */
export async function writeAuditAfterDb(DB: D1Database, build: () => { actor: AuditActor; event: AuditEvent }, opts?: AuditStatementOpts): Promise<void> {
  let event: AuditEvent | undefined;
  try {
    const built = build();
    event = built.event;
    await auditStatement(DB, built.actor, built.event, opts).run();
  } catch (e) {
    const error = e instanceof Error ? { name: e.name, message: e.message } : { name: typeof e, message: String(e) };
    console.error("audit: failed to record", { action: event?.action ?? null, targetId: event?.target?.id ?? null }, error);
  }
}

/** 「後」の書き方(要求の文脈がある経路)。操作した人は auditActor(c)。決まりは writeAuditAfterDb と同じ */
export async function writeAuditAfter(c: Context<AppEnv>, build: () => AuditEvent, opts?: AuditStatementOpts): Promise<void> {
  await writeAuditAfterDb(c.env.DB, () => ({ event: build(), actor: auditActor(c) }), opts);
}

/** 200 文字で切る(文字 = コードポイント。SQLite の substr と同じ数え方) */
function capText(s: string | null): string | null {
  if (s === null || s.length <= AUDIT_TEXT_MAX_CHARS) return s;
  const chars = Array.from(s);
  return chars.length <= AUDIT_TEXT_MAX_CHARS ? s : chars.slice(0, AUDIT_TEXT_MAX_CHARS).join("");
}

function capStrings(v: AuditJson): AuditJson {
  if (typeof v === "string") return capText(v);
  if (Array.isArray(v)) return v.map(capStrings);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x)]));
  return v;
}

const encoder = new TextEncoder();

function detailExpression(detail: AuditDetail | AuditSql | undefined): RawBuilder<unknown> {
  if (!detail) return sql`${"{}"}`;
  if (isExpression(detail)) return sql`${detail}`;
  const entries = Object.entries(detail).filter((e): e is [string, AuditJson | AuditSql] => e[1] !== undefined);
  if (!entries.some(([, v]) => isExpression(v))) {
    const json = JSON.stringify(capStrings(Object.fromEntries(entries) as { [key: string]: AuditJson }));
    return sql`${encoder.encode(json).length > AUDIT_DETAIL_MAX_BYTES ? TRUNCATED_DETAIL : json}`;
  }
  const parts = entries.map(([k, v]) => (isExpression(v) ? sql`${k}, ${v}` : sql`${k}, json(${JSON.stringify(capStrings(v as AuditJson))})`));
  return sql`json_object(${sql.join(parts)})`;
}

/**
 * B129 plan Task 5(spec §3.1・§12): 書き込みの経路(POST・PUT・PATCH・DELETE)の分類。キーは `METHOD /path`(Hono の `:param` の形)。
 * test/audit-coverage.test.ts の `every_write_route_is_classified` が、`/openapi.json`・ルータ・Better Auth のパススルー(AUTH_ALLOW)の
 * 書き込みの経路がどれも、記録しない(UNAUDITED_ROUTES)か、記録する・まだ記録していない(AUDITED_ROUTES・PENDING_ROUTES)の
 * どちらか一方だけに入ることを確かめる。新しい書き込みの経路を足すときは、記録するかを決めてどちらかに入れる
 * (記録するなら action を core の AUDIT_ACTIONS に足し、spec §3.1 に書く)。1 つの経路が AUDITED_ROUTES と PENDING_ROUTES の両方に入るのは、
 * 一部の action だけを記録した途中の経路(PENDING_ROUTES のコメント)だけで、同じ action を両方に書かない。
 *
 * AUDITED_ROUTES の各項目は、その経路で書く action と、その action の記録を確かめるテストの名前(test/audit-*.test.ts の `it("…")`。
 * 後ろの括弧書きは除く)。`every_audited_route_has_its_test` が名前のテストがあることを見る。
 * Cron の記録(`break_glass.sweep`)は経路が無いのでここには無い(test/audit-after.test.ts の `sweep_records_counts_once`)
 */
export type AuditRouteCheck = { readonly action: AuditAction; readonly test: string };

export const AUDITED_ROUTES: Readonly<Record<string, readonly AuditRouteCheck[]>> = {
  // 人とアクセス権(batch。Task 3: test/audit-access.test.ts)
  "DELETE /workspaces/:wid/invitations/:id": [{ action: "invitation.cancel", test: "invitation_cancel_records_email" }],
  "PATCH /workspaces/:wid/members/:memberId": [{ action: "member.role_change", test: "role_change_records_from_and_to" }],
  "DELETE /workspaces/:wid/members/:memberId": [{ action: "member.remove", test: "member_remove_records_revoked_keys" }],
  "POST /instance-admins": [{ action: "instance_admin.grant", test: "instance_admin_grant_and_revoke" }],
  "DELETE /instance-admins/:userId": [{ action: "instance_admin.revoke", test: "instance_admin_grant_and_revoke" }],
  "DELETE /me/api-keys/:kid": [{ action: "api_key.revoke", test: "api_key_revoke_own_and_member" }],
  "DELETE /workspaces/:wid/api-keys/:kid": [{ action: "api_key.revoke_member", test: "api_key_revoke_own_and_member" }],
  "POST /workspaces": [{ action: "workspace.create", test: "workspace_create_delete" }],
  "DELETE /workspaces/:wid": [{ action: "workspace.delete", test: "workspace_create_delete" }],
  "POST /setup": [{ action: "setup.complete", test: "setup_records_completion" }],
  "PATCH /usage/settings": [{ action: "usage.settings_change", test: "usage_settings_change_records_fields" }],
  // Better Auth が書く操作(前・後。Task 4: test/audit-after.test.ts)
  "POST /workspaces/:wid/invitations": [{ action: "invitation.create", test: "invitation_create_records_role_and_extended" }],
  "POST /invitations/:id/accept": [{ action: "invitation.accept", test: "accept_with_session_and_signup" }],
  "POST /me/api-keys": [
    { action: "api_key.create", test: "api_key_create_records_scope" },
    { action: "api_key.create", test: "api_key_create_success_row_carries_key_id" },
  ],
  "POST /workspaces/:wid/members/:memberId/reset-link": [{ action: "member.reset_link", test: "reset_link_records_target" }],
  "POST /break-glass/reset-link": [{ action: "break_glass.reset_link", test: "reset_link_records_target" }],
  "POST /auth/sign-in/email": [{ action: "auth.password_login", test: "password_login_is_recorded" }],
  // エクスペリエンス(batch。Task 6: test/audit-experiments.test.ts)
  "POST /sites/:sid/experiments": [{ action: "experiment.create", test: "create_records_kind" }],
  "PATCH /sites/:sid/experiments/:eid": [
    { action: "experiment.update", test: "patch_records_changed_fields" },
    { action: "experiment.memo", test: "memo_only_patch_is_memo_action" },
  ],
  "PATCH /sites/:sid/experiments/:eid/variants/:vid": [{ action: "experiment.variant_memo", test: "variant_memo_records_variant" }],
  "PUT /sites/:sid/experiments/:eid/variants": [{ action: "experiment.variants", test: "variants_records_names_and_weights" }],
  "PUT /sites/:sid/experiments/:eid/variants/:vid/changes": [{ action: "experiment.changes", test: "changes_records_counts_and_types" }],
  // 続く自動の公開は publish.publish(Task 7: test/audit-content.test.ts)
  "POST /sites/:sid/experiments/:eid/status": [
    { action: "experiment.status", test: "status_records_from_to" },
    { action: "publish.publish", test: "status_auto_publish_records_publish" },
  ],
  "PUT /sites/:sid/experiments/:eid/adoption": [{ action: "experiment.adoption", test: "adoption_records_variant" }],
  "POST /sites/:sid/experiments/:eid/duplicate": [{ action: "experiment.duplicate", test: "duplicate_records_source" }],
  "DELETE /sites/:sid/experiments/:eid": [{ action: "experiment.delete", test: "delete_records_name" }],
  "PUT /sites/:sid/experiments/:eid/evaluation-plan": [
    { action: "experiment.evaluation_plan", test: "evaluation_plan_records_fields" },
    { action: "experiment.evaluation_plan", test: "evaluation_plan_extension_records_fields" },
  ],
  // サイト・目標・オーディエンス・画像・公開(batch。static.rebuild だけは前。Task 7: test/audit-content.test.ts)
  "POST /workspaces/:wid/sites": [
    { action: "site.create", test: "site_create_records_domain" },
    // 作成の後の失敗で行を消すときの取り消しの行(detail.reason = "create_failed")
    { action: "site.delete", test: "site_create_failure_records_rollback" },
  ],
  "PATCH /sites/:sid": [
    { action: "site.update", test: "site_update_records_scalar_before_after" },
    { action: "site.update", test: "site_update_revert_records_reverted" },
  ],
  "DELETE /sites/:sid": [{ action: "site.delete", test: "site_delete_records_name" }],
  "POST /sites/:sid/goals": [{ action: "goal.create", test: "goal_audience_crud" }],
  "PATCH /sites/:sid/goals/:gid": [{ action: "goal.update", test: "goal_audience_crud" }],
  "DELETE /sites/:sid/goals/:gid": [{ action: "goal.delete", test: "goal_audience_crud" }],
  "POST /sites/:sid/audiences": [{ action: "audience.create", test: "goal_audience_crud" }],
  "PATCH /sites/:sid/audiences/:aid": [{ action: "audience.update", test: "goal_audience_crud" }],
  "DELETE /sites/:sid/audiences/:aid": [{ action: "audience.delete", test: "goal_audience_crud" }],
  "POST /sites/:sid/assets": [{ action: "asset.upload", test: "asset_upload" }],
  "PATCH /sites/:sid/assets/:aid": [{ action: "asset.rename", test: "asset_rename" }],
  "DELETE /sites/:sid/assets/:aid": [{ action: "asset.delete", test: "asset_delete" }],
  "POST /sites/:sid/publish": [
    { action: "publish.publish", test: "publish_records_version" },
    { action: "publish.publish", test: "publish_revert_records_reverted" },
  ],
  "POST /sites/:sid/static/redeploy": [{ action: "publish.static_redeploy", test: "static_redeploy_and_rebuild" }],
  "POST /static/rebuild": [{ action: "static.rebuild", test: "static_redeploy_and_rebuild" }],
};

/** 記録しない書き込みの経路と、その理由(spec §3.1 の注) */
export const UNAUDITED_ROUTES: Readonly<Record<string, string>> = {
  "POST /sites/:sid/evaluate": "配信条件の評価の結果を返すだけで、D1 にも KV にも書かない",
  "POST /auth/handoff/exchange": "Google のログインの引き継ぎのコードを、Google の戻りで作ったセッションのトークンに替えるだけ(Google のログインは記録しない)",
  "POST /auth/sign-out": "ログアウト。ログイン・ログアウトは記録しない(パスワードのログインだけは、非常口の後の確かめのために記録する)",
  "POST /auth/sign-up/email": "アカウントの作成は、招待の受諾(invitation.accept の detail.signUp)と初期設定(setup.complete)の記録に含める",
  "POST /auth/request-password-reset": "メールを送らないので、直接呼んでも再設定のリンクは誰にも届かない。リンクを配るのは自前の経路で、その発行を member.reset_link・break_glass.reset_link で記録する",
  "POST /auth/reset-password": "再設定リンクを使ったパスワードの設定。リンクの発行(member.reset_link・break_glass.reset_link)を記録する",
};

/**
 * まだ記録していない書き込みの経路と action。plan Task 6・7 で移し終えて空(Task 13 で空であることを確かめる)。
 * 新しい書き込みの経路は、記録するかを決めて AUDITED_ROUTES か UNAUDITED_ROUTES に入れる。記録を後の作業に回すときだけここに置き、
 * 1 つの経路の action の一部だけを記録したときは、記録した action を AUDITED_ROUTES に、残りをここに置く(同じ action は両方に書かない。
 * `every_write_route_is_classified` が見る)
 */
export const PENDING_ROUTES: Readonly<Record<string, { readonly task: number; readonly actions: readonly AuditAction[] }>> = {};
