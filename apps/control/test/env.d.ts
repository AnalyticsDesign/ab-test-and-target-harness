// edge の test/env.d.ts と同じ流儀: installed の @cloudflare/vitest-plugin は `env` を
// グローバル名前空間 `Cloudflare.Env` で型付けする(module "cloudflare:workers" の ProvidedEnv ではない)
import type { D1Migration } from "cloudflare:test";
import type { Env as ControlEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends ControlEnv {
      /** vitest.config.ts の miniflare.bindings で渡す(test/apply-migrations.ts が適用する) */
      TEST_MIGRATIONS: D1Migration[];
      /** D9 ②・③(K5): 計測用 D1 のマイグレーション(wrangler.jsonc の RESULTS_DB の migrations_dir = edge の results-migrations/)。test/apply-migrations.ts が毎テストの前に RESULTS_DB に当てる */
      TEST_RESULTS_MIGRATIONS: D1Migration[];
      TEST_REPAIR_SQL: string;
      /** backlog B35: control / core の src の中身(キー = control/… / core/…)。glossary.test.ts が読む */
      TEST_SOURCES: Record<string, string>;
      /** B129 plan Task 5: test/audit-*.test.ts の中身(キー = ファイル名)。audit-coverage.test.ts が読む */
      TEST_AUDIT_TESTS: Record<string, string>;
      /** B148: 本番の wrangler.jsonc(control と、開発リポジトリにだけある公開版の overlay)の生の文字列(キー = リポジトリの根からのパス)。domain-probe.test.ts が読む */
      TEST_WRANGLER_CONFIGS: Record<string, string>;
    }
  }
}

export {};
