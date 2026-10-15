import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Worker と DO の結線のテスト。API は偽の base(CF_API_BASE)に向け、fetch を差し替えて応答する
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { CF_ACCOUNT_ID: "acc", CF_DEPLOY_TOKEN: "tok", CF_API_BASE: "https://api.test/client/v4", STATIC_SCRIPT_NAME: "wtt-static" } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], exclude: ["test/**/*.node.test.ts", "test/assets.test.ts", "test/cf-api.test.ts"] },
});
