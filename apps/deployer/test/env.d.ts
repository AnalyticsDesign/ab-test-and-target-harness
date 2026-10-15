import type { Env as DeployerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends DeployerEnv {}
  }
}

export {};
