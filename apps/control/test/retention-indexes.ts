import { env } from "cloudflare:workers";

/** migration 0028・0029 の後にある索引。テストで落とす・数えるときはここだけを見る(名前の変更で片方だけずれないように)。 */
export const RETENTION_INDEXES = [
  "publishes_with_body",
  "experiment_delivered_definitions_unsettled",
  "publishes_kv_live",
  "experiment_delivered_definitions_without_generation",
  "experiment_delivery_changes_by_run",
] as const;

/** いま DB にある 0028・0029 の索引の数。 */
export async function countRetentionIndexes(): Promise<number> {
  const marks = RETENTION_INDEXES.map(() => "?").join(", ");
  const row = await env.DB.prepare(`select count(*) as n from sqlite_master where type = 'index' and name in (${marks})`).bind(...RETENTION_INDEXES).first<number>("n");
  return row ?? 0;
}
