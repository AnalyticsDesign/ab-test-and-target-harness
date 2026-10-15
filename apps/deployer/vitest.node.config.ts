import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.node.test.ts", "test/assets.test.ts", "test/cf-api.test.ts"], environment: "node" },
});
