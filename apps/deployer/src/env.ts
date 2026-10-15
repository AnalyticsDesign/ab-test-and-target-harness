import type { DeployQueue } from "./queue-do";

export type Env = {
  DEPLOY_QUEUE: DurableObjectNamespace<DeployQueue>;
  /** 配信専用の Worker があるアカウント(var) */
  CF_ACCOUNT_ID?: string;
  /** Workers Scripts の Edit を持つ API トークン(secret)。決定 52 (3): このトークンはこの Worker にだけ置く */
  CF_DEPLOY_TOKEN?: string;
  /** 配信専用の Worker の名前。既定 wtt-static */
  STATIC_SCRIPT_NAME?: string;
  /** API の base。本番は書かない(既定 https://api.cloudflare.com/client/v4)。admin の E2E が偽の API に向ける */
  CF_API_BASE?: string;
};
