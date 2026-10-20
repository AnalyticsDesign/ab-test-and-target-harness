// vitest(node)用の `cloudflare:workers` の差し替え先(vitest.config.ts の resolve.alias)。
// binding は何も無い = lib/control-binding.ts の controlBinding() は null を返し、公開 URL の経路になる。
// binding の経路を確かめるテストは `@/lib/control-binding` を vi.mock で差し替える(test/bff.test.ts)
export const env: Record<string, unknown> = {};
