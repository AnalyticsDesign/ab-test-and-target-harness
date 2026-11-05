import { sql } from "kysely";
import { z } from "zod";
import { auditChanged, changedFieldsDetail, type AuditFieldChange, type AuditSql } from "./audit";
import type { Db } from "./db";

/**
 * backlog D10(brief K2・K3): 導入全体の設定。D1 の instance_settings にキーごとに 1 行(値は JSON)。
 * 行が無い・読めない・知らない値は、キーごとに既定値として扱う(設定の破損で画面と API を止めない)。
 * 書くのは PATCH /usage/settings(システム管理者・セッションのみ)と初回セットアップだけ。
 * 後から項目を足すときは SCHEMAS と既定値に 1 行足す(マイグレーションは要らない)。**使用状況の口(UsageSettingsSchema)は 3 項目に固定**で、
 * 新しいキーは自分の口と認可を持つ(例: 書き込みの凍結)
 */
export type UsageVisibility = "members" | "instance_admins";
export type CloudflarePlan = "free" | "paid";
/** 表全体の設定 */
export type InstanceSettings = { usageVisibility: UsageVisibility; cloudflarePlan: CloudflarePlan; showPaidReference: boolean };
/**
 * 使用状況の口(GET / PATCH /usage/settings・GET /usage の settings・judge・getUsage)が扱う 3 項目。
 * 今は 3 項目しかないので InstanceSettings と同じ形だが、表に項目を足しても使用状況の応答と PATCH の body に漏れないよう型を分けておく
 */
export type UsageSettings = Pick<InstanceSettings, "usageVisibility" | "cloudflarePlan" | "showPaidReference">;

export const INSTANCE_SETTING_DEFAULTS: InstanceSettings = { usageVisibility: "members", cloudflarePlan: "free", showPaidReference: true };

const SCHEMAS = {
  usageVisibility: z.enum(["members", "instance_admins"]),
  cloudflarePlan: z.enum(["free", "paid"]),
  showPaidReference: z.boolean(),
} satisfies Record<keyof InstanceSettings, z.ZodType>;

export const UsageSettingsSchema = z.object({
  usageVisibility: SCHEMAS.usageVisibility.describe("使用状況を見られる人。members = すべてのメンバー / instance_admins = システム管理者のみ"),
  cloudflarePlan: SCHEMAS.cloudflarePlan.describe("Cloudflare の Workers のプラン(free / paid)。判定に使う上限が変わる"),
  showPaidReference: SCHEMAS.showPaidReference.describe("paid のとき、管理画面で月額 $5 に含まれる量(日次の資源は 30 日で割った 1 日分)と比べるか。API の reference には影響しない"),
});

/** 表全体の設定から、使用状況の口に出す 3 項目だけを取り出す(表に項目を足しても使用状況の応答に漏れない) */
export const usageSettingsOf = (s: InstanceSettings): UsageSettings => ({
  usageVisibility: s.usageVisibility,
  cloudflarePlan: s.cloudflarePlan,
  showPaidReference: s.showPaidReference,
});

const KEYS = Object.keys(SCHEMAS) as Array<keyof InstanceSettings>;

export async function readInstanceSettings(db: Db): Promise<InstanceSettings> {
  const rows = await db.selectFrom("instance_settings").select(["key", "value"]).where("key", "in", KEYS).execute();
  return settingsOfRows(rows);
}

/** instance_settings の行から設定を作る(KEYS 以外の行は無視する) */
function settingsOfRows(rows: ReadonlyArray<{ key: string; value: string }>): InstanceSettings {
  const out: InstanceSettings = { ...INSTANCE_SETTING_DEFAULTS };
  for (const row of rows) {
    if (!(KEYS as readonly string[]).includes(row.key)) continue;
    const key = row.key as keyof InstanceSettings;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue; // 読めない値は既定値のまま
    }
    const r = SCHEMAS[key].safeParse(parsed);
    if (r.success) (out as Record<string, unknown>)[key] = r.data;
  }
  return out;
}

/**
 * B129(spec §10.4・Q10・Q24): 制御用の D1(wtt-control)の大きさ。保持の Cron(cron/audit-retention.ts)が 1 日 1 回、D1 の応答の
 * meta.size_after を書く(結果の D1 の results_store_status と同じ考え方)。値は `{ sizeBytes, measuredAt }` の JSON。
 * 使用状況の口の 3 項目(UsageSettingsSchema)には入れない(自分の口 = GET /usage の controlCapacity を持つ)
 */
export const CONTROL_DB_SIZE_KEY = "control_db_size";
export type ControlDbSize = { sizeBytes: number; measuredAt: number };
const ControlDbSizeSchema = z.object({ sizeBytes: z.number().int().nonnegative(), measuredAt: z.number().int() });

/** 行が無い(まだ測っていない)・読めない値は null(設定の破損で使用状況の口を止めない) */
function controlDbSizeOf(value: string | undefined): ControlDbSize | null {
  if (value === undefined) return null;
  try {
    const r = ControlDbSizeSchema.safeParse(JSON.parse(value));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * GET /usage 用: 設定と制御用の D1 の大きさを instance_settings の 1 回の SELECT で読む(readInstanceSettings の往復に相乗りする。往復は増えない)
 */
export async function readInstanceSettingsWithControlDbSize(db: Db): Promise<{ settings: InstanceSettings; controlDbSize: ControlDbSize | null }> {
  const rows = await db.selectFrom("instance_settings").select(["key", "value"]).where("key", "in", [...KEYS, CONTROL_DB_SIZE_KEY]).execute();
  return { settings: settingsOfRows(rows), controlDbSize: controlDbSizeOf(rows.find((r) => r.key === CONTROL_DB_SIZE_KEY)?.value) };
}

/** Cloudflare のプラン(KV の Site の設定の記録に書く新しい訪問者の予算の既定が決まる。plan12 K10) */
export const readCloudflarePlan = async (db: Db): Promise<CloudflarePlan> => (await readInstanceSettings(db)).cloudflarePlan;

export async function writeInstanceSettings(db: Db, patch: Partial<InstanceSettings>, updatedBy: string | null, now = Date.now()): Promise<void> {
  await instanceSettingsUpsert(db, patch, updatedBy, now)?.execute();
}

/**
 * 設定の upsert の文(書く項目が無ければ null)。B129: PATCH /usage/settings は、この文と記録の文を 1 つの batch に積む(往復は 1 回のまま)
 */
export function instanceSettingsUpsert(db: Db, patch: Partial<InstanceSettings>, updatedBy: string | null, now = Date.now()) {
  const rows = KEYS.filter((k) => patch[k] !== undefined).map((k) => ({ key: k, value: JSON.stringify(patch[k]), updated_at: now, updated_by: updatedBy }));
  if (rows.length === 0) return null;
  return db
    .insertInto("instance_settings")
    .values(rows)
    .onConflict((oc) =>
      oc.column("key").doUpdateSet((eb) => ({
        value: eb.ref("excluded.value"),
        updated_at: eb.ref("excluded.updated_at"),
        updated_by: eb.ref("excluded.updated_by"),
      })),
    );
}

/**
 * B129: `usage.settings_change` の detail。送った項目のうち値が変わった項目だけ `{ from, to }`(変わらなければ `{}`。B129 final review = R64)。
 * from は記録の文の中で今の行から読む(記録を upsert の前に置く。行が無い・読めない JSON は既定値。readInstanceSettings と同じく
 * 設定の破損で操作を止めない)、to は要求の値。比べるのは JSON の形(json() で整えた文字列)どうし。
 * 値が変わらない保存も行は残す(upsert は無条件で updated_at を書き、プランの再送では全サイトの KV の記録も書き直すため)
 */
export function instanceSettingsChangeDetail(patch: Partial<InstanceSettings>): AuditSql {
  const changes: AuditFieldChange[] = KEYS.filter((k) => patch[k] !== undefined).map((k) => {
    const from = sql`json(coalesce((select case when json_valid(value) then value end from instance_settings where key = ${k}), ${JSON.stringify(INSTANCE_SETTING_DEFAULTS[k])}))`;
    const to = JSON.stringify(patch[k]);
    return { key: k, changed: auditChanged(from, [to]), fromTo: sql`json_object('from', ${from}, 'to', json(${to}))` };
  });
  return changedFieldsDetail(changes, { names: false });
}
