import { kvKeys } from "@wtt/core";
import { getDb } from "../db";
import { reconcileActive, type ReconcileRow } from "../publish";
import { isWriteFrozen } from "../write-freeze";
import { activeNeedsMark, markActiveMismatches } from "./active-marker";
import { RECONCILE_DEFER_MS, repairCandidateWhere } from "./run-state";
import { CronFrozen, isTickPrioritySlot, SLOT_MS, type CronContext, type CronJob } from "./runner";

type Candidate = ReconcileRow & { id: string };
type Run = NonNullable<CronContext["run"]>;
const CANDIDATE_LIMIT = 3;
const columns = "id, active_kv_stale, active_version, last_activated_at";

async function readCandidates(ctx: CronContext): Promise<Candidate[]> {
  const cutoff = ctx.now - RECONCILE_DEFER_MS;
  const slot = Math.floor(ctx.now / SLOT_MS);
  // 件数も同じ文で読み、末尾では折り返さない。次の枠で先頭の位置が移る。
  const result = await ctx.env.DB.prepare(`select ${columns} from sites where ${repairCandidateWhere}
    order by id limit ${CANDIDATE_LIMIT} offset (? % max(1, (select count(*) from sites where ${repairCandidateWhere})))`)
    .bind(cutoff, slot, cutoff).all<Candidate>();
  return result.results;
}

async function markRecent(ctx: CronContext, recent: NonNullable<Run["state"]>["recentActive"], outside: Run["outside"]): Promise<Candidate[]> {
  const mismatches = new Map<string, { version: number; kv: string | null }>();
  for (const { id, activeVersion } of recent) {
    let kv: string | null;
    try {
      kv = await ctx.env.CONFIG_KV.get(kvKeys.active(id));
    } catch (e) {
      console.error(`cron publish-repair: active read failed site=${id}`, e);
      continue;
    }
    if (activeNeedsMark(kv, activeVersion)) mismatches.set(id, { version: activeVersion, kv });
  }
  if (!mismatches.size || !outside.use(2)) return [];
  if (await isWriteFrozen(getDb(outside.env))) throw new CronFrozen();

  return markActiveMismatches(outside.env.DB, mismatches, "publish-repair");
}

export const publishRepairJob: CronJob = {
  name: "publish-repair", cadence: { every: "tick" }, writesControl: true,
  queryShare: 7, queryFloor: 7, queryReserved: true,
  reserveWhen: ({ state, due, now }) => !!state?.repairCandidate &&
    !(due.has("results-daily") && due.has("results-purge") && !isTickPrioritySlot(now)),
  async run(ctx) {
    if (!ctx.run?.state) return;
    let candidates: Candidate[] = [];
    let marked = 0, puts = 0, unresolved = 0;
    try {
      if (ctx.run.reserved) candidates = await readCandidates(ctx);
      const updated = await markRecent(ctx, ctx.run.state.recentActive, ctx.run.outside);
      marked = updated.length;
      if (!ctx.run.reserved) return;
      if (!candidates.length) candidates = updated.slice(0, CANDIDATE_LIMIT);
      for (const row of candidates) {
        if (!ctx.queries.use(4)) return { more: true };
        unresolved++; // 凍結で途中終了した候補も未修復の数に残す。
        const result = await reconcileActive(ctx.env, ctx.db, row.id, {
          nowMs: ctx.now, row, cron: { async assertNotFrozen() {
            await ctx.assertNotFrozen();
            // この確認の直後の put を数える。put の後の凍結で結果が戻らない場合も含む。
            puts++;
          } },
        });
        if (!result.stale) {
          unresolved--;
          if (!result.kvPuts) console.log(`cron publish-repair: lowered-without-put site=${row.id} version=${row.active_version}`);
        }
        if (result.reason !== "config_missing") break;
      }
    } finally {
      console.log(`cron publish-repair: candidates=${candidates.length} marked=${marked} puts=${puts} unresolved=${unresolved}`);
    }
  },
};
