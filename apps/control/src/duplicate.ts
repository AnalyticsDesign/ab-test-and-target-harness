import { sql, type ExpressionBuilder } from "kysely";
import type { Db, ExperimentRow, Tables } from "./db";
import type { DeliveredDefinition } from "./results/delivered";

/**
 * 決定 51(設計書 §4.1): 複製の行。元には何も書かない。
 * 写す中身: `same` は保存済みの中身(今の Change)。`variant` は配信していた中身(D9 ③ の Task 12。届く定義のうち配信を確かめた行。
 * 配信の記録が無いテストは保存済みの中身)。`same` かつテストのときは評価計画も写す(固定・到達は写さない)。
 * パターンと変更は、アプリで行を組み立てずに D1 の中で写す(INSERT … SELECT。配信した中身は json_each の 1 パラメータから)。batch は
 * エクスペリエンス・パターン・変更の 3 文(評価計画を写すときは 4 文)に固定し、パターン数・変更数にかかわらず 1 文 100 パラメータ・
 * 1 回の呼び出しあたりのクエリ数の上限に触れない
 * (batch の文が後者に 1 件ずつ数えられるかは公式に未確認。docs/dev/research/d1_batch_query_limits_2026-10-06.md、レビュー r1 CL-Low-9)
 */
export type CopyOptions = {
  siteId: string; sourceId: string; mode: "same" | "variant"; variantId?: string; id: string; name: string; user: string; now: number;
  /** 読んだときの元の updated_at。3 文すべてをこの版のときだけ書く(子の書き込みは親の updated_at を必ず更新する。レビュー r2 CX-High-4) */
  sourceUpdatedAt: number;
};

/**
 * D9 ②(設計書 §6.3、plan ② の K16): 一度開始してから削除したエクスペリエンスの ID。作成と複製(指定の id・自動の候補)は、
 * 使われている ID にこれを足して判定する(訪問者に残った割り当てが、同じ ID の新しいエクスペリエンスに効かないように)
 */
export async function retiredIds(db: Db, siteId: string): Promise<Set<string>> {
  const rows = await db.selectFrom("retired_experiment_ids").select("experiment_id").where("site_id", "=", siteId).execute();
  return new Set(rows.map((r) => r.experiment_id));
}

/** 元がまだ読んだ版のままか(3 文に共通の条件)。調べてから書くまでの間に元が編集・削除されたら、どの文も 0 行になる */
const sourceUnchanged = (o: CopyOptions) => (eb: ExpressionBuilder<Tables, any>) =>
  eb.exists(eb.selectFrom("experiments as g").select("g.id").where("g.site_id", "=", o.siteId).where("g.id", "=", o.sourceId).where("g.updated_at", "=", o.sourceUpdatedAt));

/** 新しいエクスペリエンスの行を、元が読んだ版のままのときだけ入れる(INSERT … SELECT … WHERE。0 行なら元が変わった) */
export function insertExperimentQuery(db: Db, row: ExperimentRow, o: CopyOptions) {
  const cols = Object.keys(row) as Array<keyof ExperimentRow>;
  return db
    .insertInto("experiments")
    .columns(cols)
    .expression(db.selectNoFrom((s) => cols.map((c) => s.val(row[c]).as(c))).where(sourceUnchanged(o)));
}

export function duplicateExperimentRow(e: ExperimentRow, o: CopyOptions): ExperimentRow {
  const variant = o.mode === "variant";
  return {
    site_id: e.site_id,
    id: o.id,
    name: o.name,
    kind: variant ? "single" : e.kind,
    status: "draft",
    published_status: null,
    url_match_json: e.url_match_json,
    targeting_json: e.targeting_json,
    // 「勝ったものを全員に出す」ための複製なので 100%・割当の固定は off(パターン 1 つでは意味を持たず、on は Site 全体の needsProfile を立てる)
    traffic_percentage: variant ? 100 : e.traffic_percentage,
    persist_assignment: variant ? 0 : e.persist_assignment,
    analytics_json: e.analytics_json,
    started_at: null,
    stopped_at: null,
    last_started_at: null,
    // D9 ②(設計書 §6.3): 複製は別のテスト。元の結果の記録の ID と個票の削除の印は写さない(開始で新しく振る)
    run_id: null,
    results_purged_at: null,
    description: e.description,
    created_by: o.user,
    updated_by: o.user,
    created_at: o.now,
    updated_at: o.now,
  };
}

/**
 * パターンを写す。variant は選んだ 1 つを重み 100・先頭の位置で、same はすべてをそのまま。オリジナルの印とメモ(B77)も写す。
 * メモは書いた時点の値を写す。メモの変更は親の updated_at を進めない(公開の対象にならない)ので、`sourceUnchanged` は
 * 読んでから書くまでのメモのずれを見つけない。写るのが少し古いか新しいメモになるだけで影響が小さいので、許す
 */
export function copyVariantsQuery(db: Db, o: CopyOptions) {
  const variant = o.mode === "variant";
  return db
    .insertInto("variants")
    .columns(["site_id", "experiment_id", "id", "name", "weight", "position", "analytics_json", "original", "description"])
    .expression((eb) => {
      const q = eb
        .selectFrom("variants")
        .select((s) => [
          "site_id",
          s.val(o.id).as("experiment_id"),
          "id",
          "name",
          (variant ? s.val(100) : s.ref("weight")).as("weight"),
          (variant ? s.val(0) : s.ref("position")).as("position"),
          "analytics_json",
          "original",
          "description",
        ])
        .where("site_id", "=", o.siteId)
        .where("experiment_id", "=", o.sourceId)
        .where(sourceUnchanged(o));
      return variant ? q.where("id", "=", o.variantId!) : q;
    });
}

/**
 * 変更を写す。ID・種類・セレクタ・中身・順は元のまま、作成者・更新者・時刻は複製した人と時刻。
 * delivered = `variant` の複製で、配信を確かめた届く定義(呼ぶ側が選ぶ)。あれば選んだパターンの変更をその定義から写す
 * (保存だけして公開していない変更は写さない = 測った中身だけを全員に出す。設計書 §4.1)。無ければ保存済みの変更を写す。
 * 定義にそのパターンが無いとき(開始後はパターンを変えられないので起きない)も保存済みの変更を写す
 */
export function copyChangesQuery(db: Db, o: CopyOptions, delivered: DeliveredDefinition | null) {
  const fromDelivered = o.mode === "variant" ? delivered?.variants.find((v) => v.id === o.variantId) : undefined;
  if (fromDelivered) return copyDeliveredChangesQuery(db, o, fromDelivered.changes);
  return db
    .insertInto("changes")
    .columns(["site_id", "experiment_id", "variant_id", "id", "type", "selector", "payload_json", "position", "created_by", "updated_by", "created_at", "updated_at"])
    .expression((eb) => {
      const q = eb
        .selectFrom("changes")
        .select((s) => [
          "site_id",
          s.val(o.id).as("experiment_id"),
          "variant_id",
          "id",
          "type",
          "selector",
          "payload_json",
          "position",
          s.val(o.user).as("created_by"),
          s.val(o.user).as("updated_by"),
          s.val(o.now).as("created_at"),
          s.val(o.now).as("updated_at"),
        ])
        .where("site_id", "=", o.siteId)
        .where("experiment_id", "=", o.sourceId)
        .where(sourceUnchanged(o));
      return o.mode === "variant" ? q.where("variant_id", "=", o.variantId!) : q;
    });
}

/**
 * 配信した定義の変更を写す 1 文。変更の配列を 1 パラメータの JSON で渡し、json_each で行にする(変更の数にかかわらずパラメータは一定)。
 * 順 = 配列の位置(定義は保存済みの変更を position の順に並べて作る)。payload は JSON の文字列にして渡す(json_extract は文字列の値を文字列のまま返す)。
 * 定義の payload はキーの順を揃えた形(canonicalJson)なので、元の payload_json と文字列は違うことがあるが、中身は同じ
 */
function copyDeliveredChangesQuery(db: Db, o: CopyOptions, changes: DeliveredDefinition["variants"][number]["changes"]) {
  const items = JSON.stringify(changes.map((c) => ({ id: c.id, type: c.type, selector: c.selector ?? null, payload_json: JSON.stringify(c.payload ?? null) })));
  const q = sql`
    insert into changes (site_id, experiment_id, variant_id, id, type, selector, payload_json, position, created_by, updated_by, created_at, updated_at)
    select ${o.siteId}, ${o.id}, ${o.variantId!}, json_extract(j.value, '$.id'), json_extract(j.value, '$.type'),
           json_extract(j.value, '$.selector'), json_extract(j.value, '$.payload_json'),
           j.key, ${o.user}, ${o.user}, ${o.now}, ${o.now}
    from json_each(${items}) as j
    where exists (select 1 from experiments g where g.site_id = ${o.siteId} and g.id = ${o.sourceId} and g.updated_at = ${o.sourceUpdatedAt})`;
  // 他の 2 文と同じく「元が読んだ版のまま」のときだけ写す(sourceUnchanged と同じ条件)
  return { compile: () => q.compile(db) };
}

/**
 * 評価計画を写す(`same` かつテストのとき。設計書 §4.1)。計画の中身(基準・判定に使う目標を含む)だけを写し、固定(fixed_at)・
 * 到達(reached_*・reach_checked_day)・変更の履歴は写さない(複製は下書きで、開始のときに改めて固定する)。
 * 元に計画の行が無ければ(保存も開始もしていない)何も足さない(GET は既定値で埋めた形を返す)。集計の定義は計画の JSON に残るが、
 * 固定していない計画では loadPlan が既定の定義を使う
 */
export function copyPlanQuery(db: Db, o: CopyOptions) {
  return db
    .insertInto("evaluation_plans")
    .columns(["site_id", "experiment_id", "plan_json", "version", "update_token", "updated_by", "updated_at"])
    .expression((eb) =>
      eb
        .selectFrom("evaluation_plans")
        .select((s) => ["site_id", s.val(o.id).as("experiment_id"), "plan_json", s.val(1).as("version"), s.val(crypto.randomUUID()).as("update_token"), s.val(o.user).as("updated_by"), s.val(o.now).as("updated_at")])
        .where("site_id", "=", o.siteId)
        .where("experiment_id", "=", o.sourceId)
        .where(sourceUnchanged(o)),
    );
}
