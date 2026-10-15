import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { requireSession, type AppEnv } from "../app";
import { capabilities, CapabilitiesSchema } from "../capabilities";
import { errorResponses } from "../openapi";
import { readWriteFreeze } from "../write-freeze";

export const capabilityRoutes = new Hono<AppEnv>();

/** 決定 43 (5) / 44 (4): この導入で使える機能。管理画面とエージェントが出し分けに使う(認可判定は control 側に残る) */
capabilityRoutes.get(
  "/capabilities",
  describeRoute({
    tags: ["capabilities"],
    summary: "この導入で使える機能(画像アップロードの有無、edge と設置タグの公開 origin、パスワードログインの有無)と、書き込みの凍結の状態を返す",
    responses: {
      200: { description: "機能の一覧", content: { "application/json": { schema: resolver(CapabilitiesSchema) } } },
      ...errorResponses(401),
    },
  }),
  requireSession,
  async (c) => c.json({ ...capabilities(c.env), writeFreeze: await readWriteFreeze(c.get("db")) }),
);
