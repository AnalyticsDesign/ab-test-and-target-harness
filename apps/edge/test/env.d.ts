// NOTE: deviates from the brief's literal `declare module "cloudflare:workers" { interface ProvidedEnv extends Env {} }`.
// The installed @cloudflare/workers-types@5.20260831.1 / @cloudflare/vitest-plugin@1.1.2 type `env` from
// "cloudflare:workers" as `Cloudflare.Env` (a global namespace interface), not a `ProvidedEnv` interface in the
// "cloudflare:workers" module — there is no `ProvidedEnv` export in these packages' .d.ts files. Augmenting the
// global `Cloudflare.Env` namespace is the equivalent hook for these versions.
import type { Env as WttEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends WttEnv {}
  }
}

export {};
