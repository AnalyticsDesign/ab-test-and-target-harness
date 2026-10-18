import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 計測用 D1(wtt-results)のマイグレーションを読んで、テストの binding として渡す。
// 適用は表を使うテスト(test/results-schema.test.ts)が applyD1Migrations で行う(control の apply-migrations と同じ読み方)
export default defineConfig(async () => {
  const resultsMigrations = await readD1Migrations(path.join(import.meta.dirname, "results-migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_RESULTS_MIGRATIONS: resultsMigrations,
            // 訪問者 ID の HMAC の鍵(base64 で 32 バイト)。テスト用の固定値で、本番の鍵ではない
            RESULTS_VISITOR_KEY: "dGVzdC1yZXN1bHRzLXZpc2l0b3Ita2V5LTMyYnl0ZSE=",
            // 結果の書き込みの予算をテストでは 1000 行にする(本番の既定は wrangler.jsonc の 70000)。予算の DO はコンストラクタで env から読むので、
            // 小さい値で配り終えるまでを確かめられる(test/results-budget.test.ts・results-lease.test.ts)。読み取りの予算と枠は wrangler.jsonc のまま
            RESULTS_WRITE_BUDGET: "1000",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"] },
  };
});
