import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  StaticBatchDeployRequest,
  StaticBatchDeployResult,
  StaticDeployer,
  StaticDeployRequest,
  StaticDeployResult,
  StaticInstanceStatus,
  StaticRemoveRequest,
  StaticSiteStatus,
} from "@wtt/core";
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
  /** 7o K10: 5 サイトまでのまとめた出し直し・削除の受け付け(配置は待たない) */
  async redeploySites(req: StaticBatchDeployRequest): Promise<StaticBatchDeployResult> {
    const r = await queueOf(this.env).redeploySites(req);
    // RPC の型は rejected の `sites: []`(空の tuple)を `never[]` に広げるので、形を作り直して返す(中身は同じ)
    return r.state === "accepted" ? r : { state: "rejected", sites: [], error: r.error };
  }
  /** 7o K9: デプロイ専用の Worker の全サイトの状態(読み取りだけ) */
  instanceStatus(): Promise<StaticInstanceStatus> {
    return queueOf(this.env).instanceStatus();
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
