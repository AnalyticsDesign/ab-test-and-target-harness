/**
 * 版 2 の compiled config の凍結したスキーマ(B69、spec §5)。版 3 にした後も、更新の直後に KV・配信用のファイルに残る版 2 を
 * edge・deployer・control が読むためだけに置く。読んだら必ず upgradeV2(config-upgrade.ts)で版 3 にし、版 2 のまま評価しない。
 * 版 2 のときの CompiledConfigSchema の写し: 対象 URL は 1 つのページの一致、配信条件にページの条件(url / host / path / query)を持てる、
 * 名前(name)を受ける(B77 の K4)。版で変わらない部品(Change・目標のページの一致・payload・結果の収集・検査の関数)は schema.ts から借りる。
 * 次に版を上げるとき(版 4)に、このファイルと版 2 の読み取りを消す
 */
import { z } from "zod";
import { ConversionPayloadSchema, ExposurePayloadSchema } from "./analytics";
import { REGEX_LIMITS } from "./regex-compile";
import type { RegexProgram } from "./regex-run";
import {
  COMMON_CTX, ChangeSchema, CompiledHistSchema, CompiledPageMatchSchema, LIMITS, ResultsConfigSchema, dslDepth, programSize, refineConversionPayloads,
  refineExposurePayloads, refineVariantWeights, removedPageCtx, type CtxNode, type HistNode, type PageMatch,
} from "./schema";

/** 版 2 で配信条件に書けたページの条件(版 3 では対象 URL に移した) */
export type RemovedCtxNodeV2 =
  | { ctx: "url"; op: "equals" | "contains" | "startsWith"; value: string }
  | { ctx: "host"; op: "equals" | "endsWith" | "contains" | "regex"; value: string; prog?: RegexProgram }
  | { ctx: "path"; op: "contains" | "equals" | "startsWith" | "regex"; value: string; prog?: RegexProgram }
  | { ctx: "query"; name: string; op: "equals" | "contains"; value: string }
  | { ctx: "query"; name: string; op: "exists" };

export type DslNodeV2 = CtxNode | RemovedCtxNodeV2 | HistNode | { and: DslNodeV2[] } | { or: DslNodeV2[] } | { not: DslNodeV2 };

const DslNodeV2Base: z.ZodType<DslNodeV2> = z.lazy(() =>
  z.union([
    z.union([...removedPageCtx(true), ...COMMON_CTX]),
    CompiledHistSchema,
    z.strictObject({ and: z.array(DslNodeV2Base).min(1) }),
    z.strictObject({ or: z.array(DslNodeV2Base).min(1) }),
    z.strictObject({ not: DslNodeV2Base }),
  ]),
) as z.ZodType<DslNodeV2>;

const DslNodeV2Schema = DslNodeV2Base.superRefine((node, ctx) => {
  if (dslDepth(node) > LIMITS.dslDepthMax) ctx.addIssue({ code: "custom", message: `dsl depth over ${LIMITS.dslDepthMax}` });
});

/** 版 2 の `name` は任意(B77 の K4。compile は出さなくなったが、それより前の版 2 は名前を持つ) */
const legacyName = z.string().min(1).optional();

const VariantV2Schema = z.strictObject({ id: z.string().min(1), name: legacyName, weight: z.number().int().min(0).max(100), changes: z.array(ChangeSchema) });

const ExperimentV2Schema = z
  .strictObject({
    id: z.string().min(1),
    name: legacyName,
    trafficPercentage: z.number().int().min(1).max(100),
    persistAssignment: z.boolean(),
    urlMatch: CompiledPageMatchSchema,
    targeting: DslNodeV2Schema.optional(),
    variants: z.array(VariantV2Schema).min(1),
  })
  .superRefine(refineVariantWeights);
export type ExperimentV2 = z.infer<typeof ExperimentV2Schema>;

const goalBase = { id: z.string().min(1), name: legacyName };
const GoalV2Schema = z.discriminatedUnion("type", [
  z.strictObject({ ...goalBase, type: z.literal("PAGEVIEW"), config: z.strictObject({ page: CompiledPageMatchSchema }) }),
  z.strictObject({ ...goalBase, type: z.literal("CLICK"), config: z.strictObject({ selector: z.string().min(1).max(LIMITS.selectorMax) }) }),
  z.strictObject({ ...goalBase, type: z.literal("CUSTOM"), config: z.strictObject({}) }),
]);

/** 版 2 の命令数(対象 URL 1 つ・パターン・目標・配信条件の path / host) */
function regexInstructionTotalV2(c: { patterns: Record<string, { prog?: RegexProgram }>; goals: Array<z.infer<typeof GoalV2Schema>>; experiments: Array<{ urlMatch: PageMatch; targeting?: DslNodeV2 }> }): number {
  const inDsl = (n: DslNodeV2): number =>
    "and" in n ? n.and.reduce((a, x) => a + inDsl(x), 0) : "or" in n ? n.or.reduce((a, x) => a + inDsl(x), 0) : "not" in n ? inDsl(n.not) : "prog" in n ? programSize(n.prog) : 0;
  let total = 0;
  for (const p of Object.values(c.patterns)) total += programSize(p.prog);
  for (const g of c.goals) if (g.type === "PAGEVIEW") total += programSize(g.config.page.prog);
  for (const e of c.experiments) total += programSize(e.urlMatch.prog) + (e.targeting ? inDsl(e.targeting) : 0);
  return total;
}

export const CompiledConfigV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    version: z.number().int().min(1),
    siteId: z.string().min(1),
    siteSalt: z.string().min(1),
    needsProfile: z.boolean(),
    timezone: z.string().min(1).optional(),
    patterns: z.record(z.string(), CompiledPageMatchSchema),
    prehide: z.record(z.string(), z.array(z.string())),
    exposureSelectors: z.record(z.string(), z.array(z.string())),
    goals: z.array(GoalV2Schema),
    experiments: z.array(ExperimentV2Schema),
    exposurePayloads: z.record(z.string(), z.record(z.string(), ExposurePayloadSchema)).optional(),
    conversionPayloads: z.record(z.string(), ConversionPayloadSchema).optional(),
    results: ResultsConfigSchema.optional(),
  })
  .superRefine((c, ctx) => {
    refineExposurePayloads(c, ctx);
    refineConversionPayloads(c, ctx);
    const total = regexInstructionTotalV2(c);
    if (total > REGEX_LIMITS.instructionsPerSite) ctx.addIssue({ code: "custom", message: `regex instructions ${total} over ${REGEX_LIMITS.instructionsPerSite}` });
  });
export type CompiledConfigV2 = z.infer<typeof CompiledConfigV2Schema>;
