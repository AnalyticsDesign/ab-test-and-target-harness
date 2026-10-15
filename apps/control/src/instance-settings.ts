import { z } from "zod";
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
  const out: InstanceSettings = { ...INSTANCE_SETTING_DEFAULTS };
  for (const row of rows) {
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

export async function writeInstanceSettings(db: Db, patch: Partial<InstanceSettings>, updatedBy: string | null, now = Date.now()): Promise<void> {
  const rows = KEYS.filter((k) => patch[k] !== undefined).map((k) => ({ key: k, value: JSON.stringify(patch[k]), updated_at: now, updated_by: updatedBy }));
  if (rows.length === 0) return;
  await db
    .insertInto("instance_settings")
    .values(rows)
    .onConflict((oc) =>
      oc.column("key").doUpdateSet((eb) => ({
        value: eb.ref("excluded.value"),
        updated_at: eb.ref("excluded.updated_at"),
        updated_by: eb.ref("excluded.updated_by"),
      })),
    )
    .execute();
}
