import path from "node:path";
import { defineConfig } from "vitest/config";

// BFF(Route Handler)は素の Request / Response を受け渡すだけなので node 環境で直接呼び出せる。
// `next/headers` の cookies() だけはテスト側で差し替える(test/bff.test.ts)
export default defineConfig({
  resolve: { alias: { "@": path.join(import.meta.dirname, ".") } },
  test: { include: ["test/**/*.test.ts"], environment: "node", env: { AB_CONTROL_URL: "http://control.test" } },
});
