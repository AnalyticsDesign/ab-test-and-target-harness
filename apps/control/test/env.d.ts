// edge の test/env.d.ts と同じ流儀: installed の @cloudflare/vitest-plugin は `env` を
// グローバル名前空間 `Cloudflare.Env` で型付けする(module "cloudflare:workers" の ProvidedEnv ではない)
import type { D1Migration } from "cloudflare:test";
import type { Env as ControlEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends ControlEnv {
      /** vitest.config.ts の miniflare.bindings で渡す(test/apply-migrations.ts が適用する) */
      TEST_MIGRATIONS: D1Migration[];
      TEST_REPAIR_SQL: string;
      /** backlog B35: control / core の src の中身(キー = control/… / core/…)。glossary.test.ts が読む */
      TEST_SOURCES: Record<string, string>;
    }
  }
}

export {};
