import { WorkerEntrypoint } from "cloudflare:workers";
import type { StaticDeployer, StaticDeployRequest, StaticDeployResult, StaticRemoveRequest, StaticSiteStatus } from "@wtt/core";
import type { Env } from "./env";

export { DeployQueue } from "./queue-do";

const queueOf = (env: Env) => env.DEPLOY_QUEUE.get(env.DEPLOY_QUEUE.idFromName("global"));

/**
 * 決定 52 (3): control の Service Binding(RPC)だけが呼べる入口。インターネットからは届かない(plan K3)。
 * できるのは「Site の出し直し・削除・状態の確認」だけで、任意のスクリプトや API の操作は受けない
 */
export class Deployer extends WorkerEntrypoint<Env> implements StaticDeployer {
  redeploySite(req: StaticDeployRequest): Promise<StaticDeployResult> {
    return queueOf(this.env).redeploySite(req);
  }
  removeSite(req: StaticRemoveRequest): Promise<StaticDeployResult> {
    return queueOf(this.env).removeSite(req);
  }
  siteStatus(siteId: string): Promise<StaticSiteStatus> {
    return queueOf(this.env).siteStatus(siteId);
  }
}

export default {
  // workers_dev / ルートを誤って有効にしても、HTTP では何もしない
  fetch: () => new Response("not found", { status: 404 }),
  // plan K6・K7: 毎時、runtime の変化と取り残しを確かめる
  async scheduled(_c, env, ctx) {
    ctx.waitUntil(queueOf(env).tick());
  },
} satisfies ExportedHandler<Env>;
