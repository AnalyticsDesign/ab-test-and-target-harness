import { DurableObject } from "cloudflare:workers";
import type { StaticDeployRequest, StaticDeployResult, StaticRemoveRequest, StaticSiteStatus } from "@wtt/core";
import { PREVIEW_HASH, PREVIEW_SOURCE, RUNTIME_HASH, RUNTIME_SOURCE } from "@wtt/runtime/source";
import { deployAssets, STATIC_SCRIPT_NAME_RE, type CfApiConfig } from "./cf-api";
import type { Env } from "./env";
import { DeployQueueLogic, REBAKE_BATCH } from "./queue";

/**
 * デプロイの設定。トークン・アカウントが無い、または配信専用の Worker の名前が規則に合わなければ not_configured で throw する
 * (デプロイは失敗し、pending と理由が control に返る)
 */
export function cfApiConfigOf(env: Env): CfApiConfig {
  if (!env.CF_ACCOUNT_ID || !env.CF_DEPLOY_TOKEN) throw new Error("not_configured: CF_ACCOUNT_ID / CF_DEPLOY_TOKEN");
  const scriptName = env.STATIC_SCRIPT_NAME || "wtt-static";
  if (!STATIC_SCRIPT_NAME_RE.test(scriptName)) throw new Error(`not_configured: STATIC_SCRIPT_NAME must match ${STATIC_SCRIPT_NAME_RE}`);
  return { accountId: env.CF_ACCOUNT_ID, token: env.CF_DEPLOY_TOKEN, scriptName, ...(env.CF_API_BASE ? { apiBase: env.CF_API_BASE } : {}) };
}

/** 決定 52 (4): デプロイを 1 本ずつ流す DO(インスタンスは 1 つ)。ロジックは queue.ts */
export class DeployQueue extends DurableObject<Env> {
  private readonly logic: DeployQueueLogic;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.logic = new DeployQueueLogic({
      storage: ctx.storage,
      runtime: { source: RUNTIME_SOURCE, hash: RUNTIME_HASH, previewSource: PREVIEW_SOURCE, previewHash: PREVIEW_HASH },
      now: () => Date.now(),
      rebakeBatch: REBAKE_BATCH,
      deploy: async (input) => deployAssets(cfApiConfigOf(env), input),
    });
  }
  redeploySite(req: StaticDeployRequest): Promise<StaticDeployResult> {
    return this.logic.redeploySite(req);
  }
  removeSite(req: StaticRemoveRequest): Promise<StaticDeployResult> {
    return this.logic.removeSite(req);
  }
  siteStatus(siteId: string): Promise<StaticSiteStatus> {
    return this.logic.siteStatus(siteId);
  }
  tick(): Promise<void> {
    return this.logic.tick();
  }
  async alarm(): Promise<void> {
    await this.logic.tick();
  }
}
