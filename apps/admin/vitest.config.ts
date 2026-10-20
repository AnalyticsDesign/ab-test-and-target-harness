import path from "node:path";
import { defineConfig } from "vitest/config";

// BFF(Route Handler)は素の Request / Response を受け渡すだけなので node 環境で直接呼び出せる。
// `next/headers` の cookies() / headers() だけはテスト側で差し替える(test/bff.test.ts)。
// `cloudflare:workers`(service binding を読む Workers の組み込みモジュール)は node に無いので、binding の無い差し替え先に向ける
export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(import.meta.dirname, "."),
      "cloudflare:workers": path.join(import.meta.dirname, "test/stubs/cloudflare-workers.ts"),
    },
  },
  test: { include: ["test/**/*.test.ts"], environment: "node", env: { AB_CONTROL_URL: "http://control.test" } },
});
