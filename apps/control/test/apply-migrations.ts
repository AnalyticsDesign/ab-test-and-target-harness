import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { fakeEdgePing, installFakeEdge } from "./helpers";

// @cloudflare/vitest-plugin 1.x はテスト単位のストレージ隔離を自動ではしない(旧 vitest-pool-workers の
// isolatedStorage 相当の設定が無く、代わりに cloudflare:test の reset() を明示的に呼ぶ)。
// 各テストの前に全 binding を空にし、D1 は migrations を貼り直してから始める。
// applyD1Migrations は未適用分だけ適用するので、reset() 直後でも重複しない。
// D9 ③(K5): 計測用 D1(RESULTS_DB。表の形は edge の results-migrations/)にも当てる。binding は wrangler.jsonc にあるので必ずある
// (計測用 D1 の無い導入として扱うかは test/helpers.ts の testEnv が env から外して表す)
/**
 * control の D1(env.DB)にマイグレーションを当てる。`before` を渡すと、名前がその文字列より前のもの(例 "0025" → 0024 まで)だけを当てる。
 * B179: マイグレーションそのものを通るテスト(前の版が書いた形の行を入れてから、残りを当てる)のため。
 * 残りは引数なしでもう一度呼べば当たる(applyD1Migrations は未適用分だけ適用する)
 */
export async function applyControlMigrations(opts: { before?: string } = {}): Promise<void> {
  const { before } = opts;
  const list = before === undefined ? env.TEST_MIGRATIONS : env.TEST_MIGRATIONS.filter((m) => m.name < before);
  await applyD1Migrations(env.DB, list);
}

/** すべての binding を空にしてから、両方の D1 にマイグレーションを当てる。`before` は control の D1 だけに効く(上の applyControlMigrations) */
export async function resetStorage(opts: { before?: string } = {}): Promise<void> {
  await reset();
  await applyControlMigrations(opts);
  if (!env.RESULTS_DB) throw new Error("RESULTS_DB binding is missing in the vitest env (apps/control/wrangler.jsonc)");
  await applyD1Migrations(env.RESULTS_DB, env.TEST_RESULTS_MIGRATIONS);
}

beforeEach(async () => {
  // B148: 判定の GET(/__ab/ping)は偽の edge が受ける(外へ出さない)。差し替えた応答は毎テストで空に戻す
  installFakeEdge();
  fakeEdgePing.clear();
  await resetStorage();
});
