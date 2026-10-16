import type { ExpressionBuilder } from "kysely";
import type { Db, ExperimentRow, Tables } from "./db";

/**
 * 決定 51(設計書 §4.1): 複製の行。元には何も書かない。写す中身は保存済みの中身(D9 plan ① の K10。`variant` を配信していた中身に
 * 切り替えるのは届く定義の記録が入る plan ③)。
 * パターンと変更は、アプリで行を組み立てずに D1 の中で元の行から写す(INSERT … SELECT)。batch はエクスペリエンス・パターン・変更の
 * 常に 3 文になり、パターン数・変更数にかかわらず 1 文 100 パラメータ・1 回の呼び出しあたりのクエリ数の上限に触れない
 * (batch の文が後者に 1 件ずつ数えられるかは公式に未確認。docs/dev/research/d1_batch_query_limits_2026-10-06.md、レビュー r1 CL-Low-9)
 */
export type CopyOptions = {
  siteId: string; sourceId: string; mode: "same" | "variant"; variantId?: string; id: string; name: string; user: string; now: number;
  /** 読んだときの元の updated_at。3 文すべてをこの版のときだけ書く(子の書き込みは親の updated_at を必ず更新する。レビュー r2 CX-High-4) */
  sourceUpdatedAt: number;
};

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
    created_by: o.user,
    updated_by: o.user,
    created_at: o.now,
    updated_at: o.now,
  };
}

/** パターンを写す。variant は選んだ 1 つを重み 100・先頭の位置で、same はすべてをそのまま */
export function copyVariantsQuery(db: Db, o: CopyOptions) {
  const variant = o.mode === "variant";
  return db
    .insertInto("variants")
    .columns(["site_id", "experiment_id", "id", "name", "weight", "position", "analytics_json"])
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
        ])
        .where("site_id", "=", o.siteId)
        .where("experiment_id", "=", o.sourceId)
        .where(sourceUnchanged(o));
      return variant ? q.where("id", "=", o.variantId!) : q;
    });
}

/** 変更を写す。ID・種類・セレクタ・中身・順は元のまま、作成者・更新者・時刻は複製した人と時刻 */
export function copyChangesQuery(db: Db, o: CopyOptions) {
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
