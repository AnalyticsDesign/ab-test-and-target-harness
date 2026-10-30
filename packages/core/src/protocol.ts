import { z } from "zod";
import { RUN_ID_RE } from "./results";
import { BROWSERS, DEVICES, OSES } from "./ua";

/** spec §9.1: decision リクエスト。body 4KB 上限(§9.5)はスキーマでなく edge が先に検証する */
export const DecisionBodySchema = z.strictObject({
  kind: z.literal("decision").optional(), // 省略時は decision(spec §9.1)
  v: z.number().int().min(1),
  url: z.string().min(1).max(2048),
  referrer: z.string().max(2048).default(""),
  device: z.enum(DEVICES),
  // 決定 49(設計書 §9 / §11.1): runtime が User-Agent から判定した値。欠けていれば、それを使う条件を含むエクスペリエンスは対象外
  browser: z.enum(BROWSERS).optional(),
  os: z.enum(OSES).optional(),
  // ページを開いた時点の画面の幅。viewport の meta が無い時点で読んだ幅は送らない(不明 = 画面の幅の条件は対象外)
  viewport: z.strictObject({ w: z.number().int().min(0), h: z.number().int().min(0) }).optional(),
  // 初回の訪問時刻(epoch ミリ秒)。null = 発行時刻が不明(v4 の ID)。Mode C は参考用の匿名 Cookie の発行時刻(ID 自体は送らない)。D-lite は edge が Cookie から読む
  firstVisitAt: z.number().int().min(0).nullable().optional(),
  visitorId: z.string().optional(), // Mode A 直接経路では必須(edge が §9.5 で検証)。D-lite では無視(Cookie が正)
});
export type DecisionBody = z.infer<typeof DecisionBodySchema>;

/** spec §9.1 / §16: revoke 専用ボディ。edge は Set-Cookie(Max-Age=0)を返すだけで DO へは転送しない */
export const ConsentBodySchema = z.strictObject({
  kind: z.literal("consent"),
  value: z.literal("denied"),
});

export const DliteRequestSchema = z.union([ConsentBodySchema, DecisionBodySchema]);

/** spec §7.5 */
export type DecisionResponse = {
  v: number;
  experiments: Array<{ id: string; variant: string }>;
  /** 設計書 §6.2: 訪問者 ID の短いハッシュ(D9 ②)。D-lite は runtime が ID(HttpOnly の Cookie)を読めないので edge が返し、runtime が送信済みの印と比べる */
  vh?: string;
};

/**
 * spec §9.2 / 決定 37: `/v1/sites/:siteId/event` と D-lite `/__ab/event` のボディ。
 * `goal` は Profile の goals[goalId].count を加算、`forget` は撤回時に Profile を deleteAll。
 * visitorId は Mode A 直接経路で必須(edge が §9.5 の形式検証を行う)。D-lite では無視(Cookie が正)。
 * goalId の受理集合は compiled config の `goals[].id`(`GoalSchema` = 1 字以上の任意文字列)と同じ広さにし(上限は body 4KB が担う)、
 * 存在しない ID は edge が active config と照合して 204 にする(§9.2)。狭い regex を置くと fixture 経路で compile を通った Goal(`purchase.completed` 等)が 400 になる(r1 CX-Medium-1)
 */
const RunId = z.string().regex(RUN_ID_RE);

/**
 * 決定 51(設計書 §6.3): 結果の参加。初回(`ok` / `failed`)は端末 `device` が必須、後から失敗(`failed_later`)と回復(`recovered`)は持たない。
 * `v` は種類ごとの版(将来の形の変更は新しい `v` か `type` で足し、今の受信を壊さない)
 */
const ParticipantBodySchema = z.discriminatedUnion("applied", [
  z.strictObject({ type: z.literal("participant"), v: z.literal(1), runId: RunId, variantId: z.string().min(1), device: z.enum(DEVICES), applied: z.enum(["ok", "failed"]), visitorId: z.string().optional() }),
  z.strictObject({ type: z.literal("participant"), v: z.literal(1), runId: RunId, variantId: z.string().min(1), applied: z.enum(["failed_later", "recovered"]), visitorId: z.string().optional() }),
]);
/**
 * 決定 51(設計書 §6.3): 結果の CV(run 指定、版 1)。1 回に 1〜20 件の runId(超える分は runtime が分けて送る)。
 * B139 §5.2: runtime は送らなくなるが、全サイトの配信ファイルを作り直すまで古い runtime が送るので edge は受ける
 */
const RunConversionBodySchema = z.strictObject({ type: z.literal("conversion"), v: z.literal(1), goalId: z.string().min(1), runIds: z.array(RunId).min(1).max(20), visitorId: z.string().optional() });
/**
 * B139 §5.2(Q14): 目標だけの CV(版 2)。run は edge が参加の記録から引く。1 回に 1〜20 件の目標(超える分は runtime が分けて送る)。
 * visitorId は Mode A の直接経路(/v1/)で必須(edge が検証する)。D-lite では無視(Cookie が正)
 */
const GoalConversionBodySchema = z.strictObject({ type: z.literal("conversion"), v: z.literal(2), goalIds: z.array(z.string().min(1)).min(1).max(20), visitorId: z.string().optional() });
/** CV は `v` で分ける(`type` の判別子が重ならないよう入れ子にする) */
const ConversionBodySchema = z.discriminatedUnion("v", [RunConversionBodySchema, GoalConversionBodySchema]);

export const EventBodySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("goal"), goalId: z.string().min(1), visitorId: z.string().optional() }),
  z.strictObject({ type: z.literal("forget"), visitorId: z.string().optional() }),
  ParticipantBodySchema,
  ConversionBodySchema,
]);
export type EventBody = z.infer<typeof EventBodySchema>;
export type ParticipantBody = z.infer<typeof ParticipantBodySchema>;
/** run 指定の CV(版 1。移行の間だけ受ける) */
export type ConversionBody = z.infer<typeof RunConversionBodySchema>;
/** 目標だけの CV(版 2。B139 §5.2) */
export type GoalConversionBody = z.infer<typeof GoalConversionBodySchema>;
