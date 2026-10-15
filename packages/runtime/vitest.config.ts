import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __WTT_PREVIEW_HASH__: JSON.stringify("test") },
  test: {
    globals: true,
    environment: "happy-dom",
    // https にして Secure Cookie を happy-dom でもそのまま扱えるようにする
    environmentOptions: { happyDOM: { url: "https://site.test/pricing?utm=x" } },
  },
});
