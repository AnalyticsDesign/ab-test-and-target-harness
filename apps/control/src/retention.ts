import { maxWithinDays } from "@wtt/core";
import type { Db, SiteRow } from "./db";
import { ApiError } from "./errors";
import { loadActiveConfig } from "./publish";

export type RetentionConflict = { kind: "audience" | "experiment" | "published"; id: string; name: string; withinDays: number };
const KIND_JA: Record<RetentionConflict["kind"], string> = { audience: "オーディエンス", experiment: "エクスペリエンス", published: "公開中のエクスペリエンス" };

/**
 * 保存期間(retentionDays)を days に短くしたときに、期間の N がそれを超える条件(設計書 §11): 保存済みの定義(オーディエンスと、
 * archived を除くエクスペリエンス)と、公開中の設定。N > 保存期間だと判定が無関係な行動に左右されるので、直して Publish してから短くしてもらう。
 * archived は復帰できず二度と配らないので数えない(数えると保存期間を永久に短くできなくなる)
 */
export async function retentionConflicts(db: Db, site: SiteRow, days: number): Promise<RetentionConflict[]> {
  const out: RetentionConflict[] = [];
  for (const a of await db.selectFrom("audiences").select(["id", "name", "definition_json"]).where("site_id", "=", site.id).execute()) {
    const n = maxWithinDays(JSON.parse(a.definition_json));
    if (n > days) out.push({ kind: "audience", id: a.id, name: a.name, withinDays: n });
  }
  const exps = await db
    .selectFrom("experiments")
    .select(["id", "name", "targeting_json"])
    .where("site_id", "=", site.id)
    .where("status", "!=", "archived")
    .where("targeting_json", "is not", null)
    .execute();
  for (const e of exps) {
    const n = maxWithinDays(JSON.parse(e.targeting_json!));
    if (n > days) out.push({ kind: "experiment", id: e.id, name: e.name, withinDays: n });
  }
  const active = await loadActiveConfig(db, site);
  for (const e of active?.experiments ?? []) {
    const n = maxWithinDays(e.targeting);
    if (n > days) out.push({ kind: "published", id: e.id, name: e.name, withinDays: n });
  }
  return out;
}

export function retentionShrinkError(conflicts: RetentionConflict[], days: number): ApiError {
  const list = conflicts.slice(0, 5).map((c) => `${KIND_JA[c.kind]}「${c.name}」(${c.withinDays} 日)`).join("、");
  return new ApiError(422, "within_days_exceeds_retention", {
    path: ["retentionDays"],
    max: days,
    conflicts,
    message: `保存期間を ${days} 日にすると、期間がそれを超える条件があります`,
    hint: `先に期間を ${days} 日以下に直し、公開中のものは公開してから保存期間を短くしてください: ${list}`,
  });
}
