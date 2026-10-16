import { openAPIRouteHandler } from "hono-openapi";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./app";

/** spec §13.5 決定 34 のエラー封筒。全ルートの 4xx / 5xx はこの schema を参照する */
export const ErrorEnvelopeSchema = z
  .object({
    error: z.string().describe("機械可読コード(snake_case)"),
    message: z.string(),
    hint: z.string().optional(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .passthrough();
/**
 * describeRoute の responses に使う共通のエラー応答。
 * `resolver(ErrorEnvelopeSchema)` を渡すと hono-openapi が全ルートに封筒の形を**展開**して埋め込むので、
 * 下の `components.schemas.ErrorEnvelope` は誰からも参照されない飾りになる。生の `$ref` を渡すと
 * hono-openapi は(`toOpenAPISchema` を持たない schema として)そのまま素通しするため、
 * 文書は 1 つの定義を全ルートが参照する形になる(決定 34。openapi.test.ts が全ルートでこれを固定する)
 */
export const ERROR_ENVELOPE_REF = "#/components/schemas/ErrorEnvelope";
export const errorResponses = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((s) => [s, { description: `error envelope (${s})`, content: { "application/json": { schema: { $ref: ERROR_ENVELOPE_REF } } } }]),
  );

/**
 * GET /openapi.json(認証不要)。spec §13.10: 契約はルート定義の zod から生成し、手書きしない。
 * hono-openapi 1.x では openAPISpecs が openAPIRouteHandler に改名されている(Step 0 スパイクで確認)。
 * documentation.components.schemas は生の zod ではなく JSON Schema を入れる(生の zod を渡すと内部表現がそのまま出る)
 */
export function mountOpenApi(app: Hono<AppEnv>): void {
  app.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      excludeStaticFile: false, // /llms.txt(§13.10 の無認証の入口)を paths に載せる。既定 true では "." を含む末尾要素が除外される
      documentation: {
        openapi: "3.1.0",
        info: {
          title: "AB Test and Target Harness control API",
          version: "0.1.0",
          description:
            "メンテナンス中(書き込みの凍結中)は、ログイン以外の変更操作(POST / PUT / PATCH / DELETE)が 503 `write_frozen` になります。封筒の `hint` に理由と再開の見込み、`Retry-After` ヘッダーに待つ秒数が入ります。封筒の `retryAfter` にも同じ秒数が入ります。読み取り(GET)と、配信条件の計算(`POST /sites/{sid}/evaluate`)はそのまま使えます。凍結の状態は `GET /capabilities` の `writeFreeze` で確かめられます。",
        },
        components: {
          securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "セッショントークンまたは API キー(wtt_…)" } },
          schemas: { ErrorEnvelope: z.toJSONSchema(ErrorEnvelopeSchema) as Record<string, unknown> },
        },
        security: [{ bearer: [] }],
      },
    }),
  );
}
