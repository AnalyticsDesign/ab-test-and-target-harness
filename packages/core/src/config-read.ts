import { CompiledConfigSchema, type CompiledConfig } from "./schema";

/**
 * compiled config を読む。今は版 2 だけ(版 2 が公開の最初の版なので、版 1 の読み取りは置かない。backlog B52)。
 * 版 2 でなければ null(未知の版・壊れた設定は配らない)。
 * 次に版を上げるときは、ここで 1 つ前の版も読む(決定 49、設計書 §6.1 の「1 つ前の版まで読む」規則)
 */
export function parseCompiledConfig(json: unknown): CompiledConfig | null {
  const r = CompiledConfigSchema.safeParse(json);
  return r.success ? r.data : null;
}
