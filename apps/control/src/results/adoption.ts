import type { VerdictState } from "@wtt/stats";
import { z } from "zod";
import type { Db, ExperimentRow, VariantRow } from "../db";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { deliveredAt } from "./delivered";
import type { ResultSnapshot } from "./report";

/**
 * D9 ③(plan ③ の K16、設計書 §8.1): 採用の記録。
 * - variantId = 基準以外のパターン: その変更を残す / 基準: 基準の変更を残す(基準に Change があるときだけ意味を持つ)/ null: 採用なし
 * - Change の無い基準の ID は null として保存する(同じ意味を 2 通りに残さない)。「基準に Change があるか」は終了の直前に
 *   届いていた定義で判断する(配信を確かめた定義が無ければ保存済みの Change)
 * - 採用の記録は未公開の変更に数えない(experiments.updated_at を進めず、touchSite も呼ばない)
 */

export const ADOPTION_NOTE_MAX = 1000;

export const AdoptionInputSchema = z.strictObject({
  variantId: z.string().nullable().describe("採用するパターンの ID。null = 採用なし(サイトは元のページのまま)。変更の無い基準の ID は null として記録する"),
  note: z.string().max(ADOPTION_NOTE_MAX).optional().describe(`メモ(${ADOPTION_NOTE_MAX} 字まで)`),
});
export type AdoptionInput = z.infer<typeof AdoptionInputSchema>;

export const AdoptionJsonSchema = z.object({
  variantId: z.string().nullable(),
  note: z.string(),
  decidedAt: z.number().int().describe("epoch ミリ秒"),
  decidedBy: z.string().nullable(),
});

/** パーソナライズ・終了以外の状態での採用 */
export const adoptionNotAllowed = (status: 409 | 422, hint: string) => new ApiError(status, "adoption_not_allowed", { hint });

/**
 * 保存する variantId を決める。パターンに無い ID は 422 unknown_variant。
 * at = 「終了の直前」の時刻(終了の処理は終了の時刻、終了後の PUT は stopped_at)
 */
export async function resolveAdoptedVariant(
  db: Db,
  siteId: string,
  exp: Pick<ExperimentRow, "id">,
  variants: Pick<VariantRow, "id">[],
  baselineId: string | null,
  variantId: string | null,
  at: number,
): Promise<string | null> {
  if (variantId === null) return null;
  if (!variants.some((v) => v.id === variantId)) {
    throw new ApiError(422, "unknown_variant", { path: ["adoption", "variantId"], hint: "このテストのパターンの ID を指定してください" });
  }
  if (variantId !== baselineId) return variantId;
  const delivered = await deliveredAt(db, siteId, exp.id, at);
  const hasChanges = delivered
    ? (delivered.definition.variants.find((v) => v.id === variantId)?.changes.length ?? 0) > 0
    : (await db.selectFrom("changes").select("id").where("site_id", "=", siteId).where("experiment_id", "=", exp.id).where("variant_id", "=", variantId).limit(1).executeTakeFirst()) !== undefined;
  return hasChanges ? variantId : null;
}

/**
 * 採用の upsert(1 文。終了の処理は結果の記録と同じ batch に入れる)。上書きでき、履歴は持たない(最後に記録した人と時刻だけ)。
 * requireSnapshot = 結果の記録があるときだけ書く(同じ batch の前の文で記録を書けなかったら、採用も書かない)
 */
export function adoptionUpsert(
  env: Env,
  siteId: string,
  experimentId: string,
  a: { variantId: string | null; note: string; by: string; at: number },
  opts: { requireSnapshot?: boolean } = {},
): D1PreparedStatement {
  const cond = opts.requireSnapshot ? "where exists (select 1 from result_snapshots where site_id = ?1 and experiment_id = ?2)" : "where true";
  return env.DB.prepare(
    `insert into adoptions (site_id, experiment_id, variant_id, note, decided_by, decided_at) select ?1, ?2, ?3, ?4, ?5, ?6 ${cond}
     on conflict (site_id, experiment_id) do update set
       variant_id = excluded.variant_id, note = excluded.note, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
  ).bind(siteId, experimentId, a.variantId, a.note, a.by, a.at);
}

export type AdoptionSummary = { diffPoints: number | null; relative: number | null; probBeat: number | null; verdict: VerdictState | null };

/**
 * 一覧の採用の要約(設計書 §8.1)。値はすべて正の判定の記録から取る。基準を採用したら差・確率・判定は null
 * (基準どうしの比較に意味が無い)。採用なし・記録が無いときは null。重み 0 のパターン(配信していない)は判定を持たない
 */
export function adoptionSummary(variantId: string | null, official: Pick<ResultSnapshot, "variants" | "plan"> | null): AdoptionSummary | null {
  if (variantId === null || official === null) return null;
  const v = official.variants.find((x) => x.id === variantId);
  if (!v) return null;
  if (variantId === official.plan?.baselineVariantId) return { diffPoints: null, relative: null, probBeat: null, verdict: null };
  return {
    diffPoints: v.diff?.mean ?? null,
    relative: v.diff?.relMean ?? null,
    probBeat: v.diff?.pAboveDelta ?? null,
    verdict: v.weight > 0 ? (v.state ?? null) : null,
  };
}
