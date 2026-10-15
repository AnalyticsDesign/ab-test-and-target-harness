import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

// @cloudflare/vitest-plugin 1.x はテスト単位のストレージ隔離を自動ではしない(旧 vitest-pool-workers の
// isolatedStorage 相当の設定が無く、代わりに cloudflare:test の reset() を明示的に呼ぶ)。
// 各テストの前に全 binding を空にし、D1 は migrations を貼り直してから始める。
// applyD1Migrations は未適用分だけ適用するので、reset() 直後でも重複しない
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
