import { describe, expect, it } from "vitest";
import config from "@/next.config";

/**
 * 枠への埋め込みを禁じる応答ヘッダー(security triage v2 G36 / B157)。
 * 同じ登録ドメインの兄弟ホスト(設置サイト)が管理画面を透明な枠に入れて「公開する」を押させる、を止める。
 * 応答に実際に付くこと(HTML と Route Handler)は E2E(e2e/login-screen.spec.ts)で確かめる
 */
describe("next.config headers()", () => {
  it("全パスに frame-ancestors 'none' と X-Frame-Options: DENY だけを付ける", async () => {
    expect(config.headers).toBeTypeOf("function");
    const rules = await config.headers!();
    expect(rules).toEqual([
      {
        source: "/:path*",
        headers: [
          // CSP は frame-ancestors だけ(ほかのディレクティブは足さない。画面のスクリプト・スタイルの読み込みに触れない)
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ]);
  });
});
