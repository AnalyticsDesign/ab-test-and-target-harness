import { test as base, expect, type Response } from "@playwright/test";

/**
 * 全 spec の test / expect の入口。edge の Rate Limiting binding(DECISION_RATE_LIMITER)の 429 を失敗の文言に出す(backlog B80)。
 * ローカルの wrangler dev では、すべての要求が同じ IP の鍵で数えられる。並列実行の合計が binding の上限を超えると decision / event が 429 になり、
 * runtime は何も適用しないので、テストは「応答待ちの 30 秒の時間切れ」や「文言の不一致」で落ちて runtime の不具合に見える。
 * ここで context のすべての応答を見て、/v1/* と /__ab/* の 429 があれば、テストの後にその URL を添えて落とす(先に落ちたテストにも追記される)
 */
export const test = base.extend<{ failOnRateLimited: void }>({
  failOnRateLimited: [
    async ({ context }, use) => {
      const limited: string[] = [];
      const onResponse = (r: Response): void => {
        const path = new URL(r.url()).pathname;
        if (r.status() === 429 && (path.startsWith("/v1/") || path.startsWith("/__ab/"))) limited.push(`${r.request().method()} ${r.url()}`);
      };
      context.on("response", onResponse);
      await use();
      context.off("response", onResponse);
      expect(limited, "edge の Rate Limiting binding が 429 を返した。apps/edge/wrangler.jsonc の DECISION_RATE_LIMITER の limit が、E2E の並列実行の要求の数より小さい").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
