import { upgradeV2 } from "./config-upgrade";
import { CompiledConfigSchema, type CompiledConfig } from "./schema";
import { CompiledConfigV2Schema } from "./schema-v2";

/**
 * compiled config を読む(edge・deployer・control の 1 か所。決定 49、設計書 §6.1 の「1 つ前の版まで読む」規則)。
 * 版 3 はそのまま、版 2 は凍結したスキーマで読んで upgradeV2 で版 3 にする(B69、spec §5)。それ以外の版・壊れた設定は null(配らない)。
 * 版で先に振り分ける(KV から読むたびに呼ばれるので、版 2 を版 3 のスキーマで読み損ねる分の CPU を使わない)
 */
export function parseCompiledConfig(json: unknown): CompiledConfig | null {
  const version = typeof json === "object" && json !== null ? (json as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version === 3) {
    const r = CompiledConfigSchema.safeParse(json);
    return r.success ? r.data : null;
  }
  if (version === 2) {
    const r = CompiledConfigV2Schema.safeParse(json);
    return r.success ? upgradeV2(r.data) : null;
  }
  return null;
}
