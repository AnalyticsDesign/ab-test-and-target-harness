import type { Note } from "@wtt/stats";
import type { Db, ExperimentRow, SiteRow, VariantRow } from "../db";
import type { Env } from "../env";
import { loadPlan, type LoadedPlan } from "../evaluation-plan";
import type { StoredChangeInput } from "../publish";
import { canonicalJson, deliveredAt, type DeliveredDefinition } from "./delivered";
import { WriteFrozen, type WriteGuard } from "./guard";
import type { ReadSession } from "./read-session";
import { buildReport, controlFacts, type ResultReport, type ResultSnapshot } from "./report";

/**
 * D9 ③(plan ③ の K15・K13・K24、設計書 §5.3・§7.5): 結果の記録(固定)。
 *
 * - 記録は (site_id, experiment_id, kind) に 1 件だけ(INSERT … ON CONFLICT DO NOTHING)。一度書いた記録は書き換えない
 * - kind = evaluation(評価時点の記録、cutoff = 評価時点)/ stop(評価時点の前に終了したときの記録、cutoff = 終了の時刻)。
 *   正の判定 = 評価時点の記録があればそれ、無ければ終了の記録(両方がそろうことは無い: 評価時点の後の終了は終了の記録を作らず、
 *   評価時点の前の終了は後から評価時点の記録を作らない。どちらを作るかは呼び出し元が評価時点と終了の時刻から決める)
 * - 定義の写し = cutoff の時点で有効な届く定義の行(deliveredAt。partial で仮に確かめた行も使う: 個票が残っている間に
 *   記録を固定することを優先する)。無ければ definition: null と注記 definition_missing
 * - 名前(エクスペリエンス・パターンと original・サイトの目標)は記録を作る時点の wtt-control から写す(目標は削除されうるため)
 * - 計測用 D1 の読み取りは渡された read だけ(予約は呼び出し元 = 結果の API・終了・Cron の 1 件が持つ)
 */

export type SnapshotKind = "evaluation" | "stop";

/** 保存済みの記録(無ければ null) */
export async function readSnapshot(db: Db, siteId: string, experimentId: string, kind: SnapshotKind): Promise<ResultSnapshot | null> {
  const row = await db
    .selectFrom("result_snapshots")
    .select("result_json")
    .where("site_id", "=", siteId)
    .where("experiment_id", "=", experimentId)
    .where("kind", "=", kind)
    .executeTakeFirst();
  return row ? (JSON.parse(row.result_json) as ResultSnapshot) : null;
}

/** 正の判定の記録(評価時点の記録があればそれ、無ければ終了の記録。どちらも無ければ null) */
export async function readOfficialSnapshot(db: Db, siteId: string, experimentId: string): Promise<{ kind: SnapshotKind; snapshot: ResultSnapshot } | null> {
  const rows = await db.selectFrom("result_snapshots").select(["kind", "result_json"]).where("site_id", "=", siteId).where("experiment_id", "=", experimentId).execute();
  const row = rows.find((r) => r.kind === "evaluation") ?? rows.find((r) => r.kind === "stop");
  return row ? { kind: row.kind, snapshot: JSON.parse(row.result_json) as ResultSnapshot } : null;
}

/**
 * 記録の対象(結果の API・終了・Cron が共通に使う唯一の規則。設計書 §5.3・§7.5)。
 * ev = 到達の確認(checkReach)の**後**の計画で求めた evaluationOf の結果(到達を確かめずに渡すと、評価時点の後の終了を
 * 早期終了と誤り、正の判定でない終了の記録を作る)。now が評価時点の前なら null(まだ記録しない)。
 * - 評価時点の前に終了した(stoppedEarly): kind = stop、cutoff = 終了の時刻(後から評価時点の記録は作らない)
 * - それ以外: kind = evaluation、cutoff = 評価時点(評価時点の後の終了は終了の記録を作らない)
 */
export function snapshotTarget(ev: { point: { evaluationAt: number; stoppedEarly: boolean } } | null, now: number): { kind: SnapshotKind; cutoff: number } | null {
  if (ev === null || now < ev.point.evaluationAt) return null;
  return { kind: ev.point.stoppedEarly ? "stop" : "evaluation", cutoff: ev.point.evaluationAt };
}

/** 保存済みの Change(パターンごと。並びは position。届く定義の changes と同じ形 = buildCompileInput の形) */
export async function savedChanges(db: Db, siteId: string, experimentId: string): Promise<Map<string, StoredChangeInput[]>> {
  const rows = await db.selectFrom("changes").selectAll().where("site_id", "=", siteId).where("experiment_id", "=", experimentId).orderBy("position").execute();
  const out = new Map<string, StoredChangeInput[]>();
  for (const ch of rows) {
    const list = out.get(ch.variant_id) ?? [];
    list.push({ id: ch.id, type: ch.type, ...(ch.selector ? { selector: ch.selector } : {}), payload: JSON.parse(ch.payload_json) });
    out.set(ch.variant_id, list);
  }
  return out;
}

/** 届く定義のパターンごとの「Change があるか」(注記 aa_test・baseline_not_original と、基準の採用の判断に使う) */
export const definitionHasChanges = (d: DeliveredDefinition): Record<string, boolean> => Object.fromEntries(d.variants.map((v) => [v.id, v.changes.length > 0]));

/**
 * 記録を計算する(書かない)。cutoff までの個票を read で集計し、cutoff の時点の届く定義と、今の名前を写す。
 * plan を渡さなければ wtt-control の評価計画を読む(結果の API は、凍結中で記録できなかった到達を入れた計画を渡す)
 */
export async function computeSnapshot(
  env: Env,
  db: Db,
  site: SiteRow,
  exp: ExperimentRow,
  kind: SnapshotKind,
  cutoff: number,
  now: number,
  read: ReadSession,
  opts: { plan?: LoadedPlan } = {},
): Promise<ResultSnapshot> {
  const [variants, goals, delivered] = await Promise.all([
    db.selectFrom("variants").selectAll().where("site_id", "=", site.id).where("experiment_id", "=", exp.id).orderBy("position").execute(),
    db.selectFrom("goals").select(["id", "name"]).where("site_id", "=", site.id).execute(),
    deliveredAt(db, site.id, exp.id, cutoff),
  ]);
  const plan = opts.plan ?? (await loadPlan(db, site.id, exp, variants));
  const definition = delivered?.definition ?? null;
  // 注記 aa_test・baseline_not_original は写した定義から出す(設計書 §7.3)。写しが無ければ今の Change で出す(buildReport の既定)
  const report = await buildReport({
    env,
    db,
    site,
    exp,
    plan,
    cutoff,
    now,
    read,
    phase: kind === "evaluation" ? "fixed" : "stopped",
    ...(definition ? { hasChanges: definitionHasChanges(definition) } : {}),
  });
  const notes: Note[] = definition ? report.notes : [...report.notes, { key: "definition_missing" }];
  return {
    ...report,
    notes,
    definition,
    names: {
      experiment: exp.name,
      variants: Object.fromEntries(variants.map((v: VariantRow) => [v.id, { name: v.name, original: v.original === 1 }])),
      goals: Object.fromEntries(goals.map((g) => [g.id, g.name])),
    },
  };
}

/**
 * 記録の INSERT(1 文。終了の処理は採用の upsert と同じ batch に入れる)。記録(どちらの kind でも)が既にあれば何もしない
 * (K15。正の判定の記録はテストごとに 1 件 = 種類の違う呼び出しが競合しても 2 件目を書かない)。
 * エクスペリエンスが同じ run_id のまま残っているときだけ書く(削除と競合したときに外部キーの失敗で落とさない)
 */
export function snapshotInsert(env: Env, siteId: string, exp: Pick<ExperimentRow, "id" | "run_id">, kind: SnapshotKind, snap: ResultSnapshot): D1PreparedStatement {
  const stored: ResultSnapshot = { ...snap, persisted: true };
  return env.DB.prepare(
    `insert into result_snapshots (site_id, experiment_id, kind, run_id, cutoff_at, computed_at, stats_version, result_json)
     select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
     where exists (select 1 from experiments where site_id = ?1 and id = ?2 and run_id = ?4)
       and not exists (select 1 from result_snapshots where site_id = ?1 and experiment_id = ?2)
     on conflict (site_id, experiment_id, kind) do nothing`,
  ).bind(siteId, exp.id, kind, exp.run_id, snap.cutoff, snap.computedAt, snap.statsVersion, JSON.stringify(stored));
}

/**
 * 記録を作る(無ければ)。戻り値 = 保存済みの正の判定の記録(既にあった・競合で先に書かれた場合はその記録。kind が呼び出しと
 * 違っても、正の判定の記録があればそれを返し、2 件目を作らない)、または計算した記録。run_id が無い・計測用 D1 が無いときは null。
 * kind と cutoff は snapshotTarget で決める。
 * - 書く前に guard を呼ぶ。API の凍結(WriteFrozen)は捕まえて、保存せずに計算した値を persisted: false で返す(K24)。
 *   それ以外(Cron の凍結など)は投げる
 * - INSERT が 0 行(並行する結果の API か Cron が先に書いた)なら、保存済みの記録を読み直して返す(API と Cron が同じ記録を返す)。
 *   読み直しても無い(エクスペリエンスが消えた・run_id が違う)ときは、保存していない計算値として persisted: false
 */
export async function ensureSnapshot(
  env: Env,
  db: Db,
  site: SiteRow,
  exp: ExperimentRow,
  kind: SnapshotKind,
  cutoff: number,
  now: number,
  read: ReadSession,
  guard: WriteGuard,
  opts: { plan?: LoadedPlan } = {},
): Promise<ResultSnapshot | null> {
  if (exp.run_id === null || !env.RESULTS_DB) return null;
  const existing = await readOfficialSnapshot(db, site.id, exp.id);
  if (existing) return existing.snapshot;
  const snap = await computeSnapshot(env, db, site, exp, kind, cutoff, now, read, opts);
  try {
    await guard();
  } catch (e) {
    if (e instanceof WriteFrozen) return { ...snap, persisted: false };
    throw e;
  }
  const res = await snapshotInsert(env, site.id, exp, kind, snap).run();
  if ((res.meta.changes ?? 0) === 0) {
    const stored = await readOfficialSnapshot(db, site.id, exp.id);
    return stored ? stored.snapshot : { ...snap, persisted: false };
  }
  return { ...snap, persisted: true };
}

/**
 * 記録を応答にする(計測用 D1 を読まない)。記録に入れない今の事実だけを重ねる: 採用・記録の有無・個票が残っているか
 * (個票を消した後は records: purged と注記 purged。数字は記録のまま)・収集の状態(今のサイトの設定と計測用 D1 の有無)。
 * 計画の変更・テスト中の変更の件数は記録の時点の値のまま
 */
export async function serveSnapshot(
  env: Env,
  db: Db,
  site: Pick<SiteRow, "id" | "results_retention_days" | "results_enabled">,
  exp: ExperimentRow,
  snap: ResultSnapshot,
): Promise<ResultSnapshot> {
  const facts = await controlFacts(db, site.id, exp);
  const purged = exp.results_purged_at !== null;
  const notes: Note[] = purged && !snap.notes.some((n) => n.key === "purged") ? [...snap.notes, { key: "purged", params: { days: site.results_retention_days } }] : snap.notes;
  const helpKeys = [...snap.helpKeys];
  if (facts.adoption !== null && !helpKeys.includes("adopt")) helpKeys.push("adopt");
  if (purged && !helpKeys.includes("retention")) helpKeys.push("retention");
  const collection: ResultReport["collection"] = !env.RESULTS_DB ? "store_missing" : site.results_enabled === 1 ? "enabled" : "site_disabled";
  return { ...snap, persisted: true, collection, adoption: facts.adoption, snapshots: facts.snapshots, records: purged ? "purged" : "available", notes, helpKeys };
}

/**
 * 今の wtt-control から決まる注記(記録には入れず、応答のたびに足す。終了のモーダルが使う。設計書 §8.2):
 * - unpublished_changes { variantId }: 保存済みの Change と、配信していた定義(実行中は今、終了したテストは終了の直前)の食い違い
 * - edited_after_evaluation { variantId }: 評価時点の記録に写した定義と、保存済みの Change の食い違い
 * deliveredChanges = 配信していた定義でパターンごとに Change があるか(配信を確かめた定義が無ければ null = 保存済みの Change で判断する)
 */
export async function liveFacts(
  db: Db,
  siteId: string,
  exp: Pick<ExperimentRow, "id" | "status" | "stopped_at">,
  official: { kind: SnapshotKind; snapshot: Pick<ResultSnapshot, "definition"> } | null,
  now: number,
): Promise<{ notes: Note[]; deliveredChanges: Record<string, boolean> | null }> {
  const at = exp.status === "archived" && exp.stopped_at !== null ? exp.stopped_at : now;
  const [delivered, saved] = await Promise.all([deliveredAt(db, siteId, exp.id, at), savedChanges(db, siteId, exp.id)]);
  const differs = (v: { id: string; changes: StoredChangeInput[] }) => canonicalJson(saved.get(v.id) ?? []) !== canonicalJson(v.changes);
  const notes: Note[] = [];
  if (delivered) {
    for (const v of delivered.definition.variants) if (differs(v)) notes.push({ key: "unpublished_changes", params: { variantId: v.id } });
  }
  const fixedDef = official?.kind === "evaluation" ? official.snapshot.definition : null;
  if (fixedDef) {
    for (const v of fixedDef.variants) if (differs(v)) notes.push({ key: "edited_after_evaluation", params: { variantId: v.id } });
  }
  return { notes, deliveredChanges: delivered ? definitionHasChanges(delivered.definition) : null };
}

/** 応答に今の注記を足す(同じ鍵の古い注記は外す) */
export function withLiveFacts<T extends ResultReport>(report: T, live: { notes: Note[]; deliveredChanges: Record<string, boolean> | null }): T & { deliveredChanges: Record<string, boolean> | null } {
  const kept = report.notes.filter((n) => n.key !== "unpublished_changes" && n.key !== "edited_after_evaluation");
  return { ...report, notes: [...kept, ...live.notes], deliveredChanges: live.deliveredChanges };
}
