import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

/** JSONC(コメント付き JSON)を読む。コメントは文字列の外だけを除く("https://…" の // を壊さない) */
function readJsonc(file: string): Record<string, unknown> {
  const src = readFileSync(file, "utf8");
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * wrangler.jsonc の `services`(デプロイ専用の Worker の Service Binding)を除いた写しを作る。
 * vitest の workerd には wtt-deployer が無く、binding が解決できないと起動そのものが落ちるため。
 * テストの DEPLOYER は既定で無し(test/helpers.ts の testEnv)で、必要なテストだけ偽物を入れる。
 * 同じ理由で、別の script(wtt-edge)の Durable Object を指す binding(`script_name` 付き。D9 ② の Task 12)も除く。
 * 写しは .wrangler/ に置くので、相対パス(main / migrations_dir)は絶対パスにする
 */
function wranglerConfigForTests(cfg: Record<string, unknown>): string {
  delete cfg.services;
  const dos = cfg.durable_objects as { bindings?: Array<Record<string, string>> } | undefined;
  if (dos?.bindings) dos.bindings = dos.bindings.filter((b) => b.script_name === undefined);
  cfg.main = path.join(import.meta.dirname, cfg.main as string);
  cfg.d1_databases = (cfg.d1_databases as Array<Record<string, string>>).map((d) => ({ ...d, migrations_dir: path.join(import.meta.dirname, d.migrations_dir!) }));
  const dir = path.join(import.meta.dirname, ".wrangler");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "vitest.wrangler.jsonc");
  writeFileSync(out, JSON.stringify(cfg, null, 2));
  return out;
}

// D1 は migrations を適用してから使う(公式 fixture vitest-plugin-examples/d1 と同じ構成)。
// readD1Migrations は @cloudflare/vitest-plugin の直下 export(installed の dist/pool/index.d.mts で確認)
/** 本番の wrangler.jsonc の生の文字列(キー = リポジトリの根からのパス)。開発用の release/overlay は、あるときだけ入れる */
function wranglerConfigsForProbeCheck(): Record<string, string> {
  const out: Record<string, string> = { "apps/control/wrangler.jsonc": readFileSync(path.join(import.meta.dirname, "wrangler.jsonc"), "utf8") };
  const overlay = path.join(import.meta.dirname, "../../release/overlay/apps/control/wrangler.jsonc");
  if (existsSync(overlay)) out["release/overlay/apps/control/wrangler.jsonc"] = readFileSync(overlay, "utf8");
  return out;
}

export default defineConfig(async () => {
  const cfg = readJsonc(path.join(import.meta.dirname, "wrangler.jsonc"));
  // D1 の binding とマイグレーションの置き場所は wrangler.jsonc が正(テストの RESULTS_DB も wrangler.jsonc の binding だけから作る。D9 ③ K5)
  const migrationsDir = (binding: string): string => {
    const d = (cfg.d1_databases as Array<Record<string, string>>).find((x) => x.binding === binding);
    if (!d?.migrations_dir) throw new Error(`wrangler.jsonc: d1 binding ${binding} with migrations_dir is missing`);
    return path.join(import.meta.dirname, d.migrations_dir);
  };
  const migrations = await readD1Migrations(migrationsDir("DB"));
  // D9 ② (K4)・③ (K5): 計測用 D1(wtt-results)の表の形の正は edge の results-migrations/。control は同じファイルを当てる
  // (test/apply-migrations.ts が毎テストの前に env.RESULTS_DB に当てる)
  const resultsMigrations = await readD1Migrations(migrationsDir("RESULTS_DB"));
  // backlog B35: 利用者向けの文言の検査(test/glossary.test.ts)。テストは workerd の中で走りファイルを読めないので、ここで読んで渡す。
  // 生成物(src/generated/ = agent-guide の埋め込み)は公開文書の検査(docs:check)が見るので除く
  const readSources = (prefix: string, dir: string): Record<string, string> =>
    Object.fromEntries(
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".ts") && !f.startsWith("generated"))
        .map((f) => [`${prefix}/${f}`, readFileSync(path.join(dir, f), "utf8")]),
    );
  const sources = {
    ...readSources("control", path.join(import.meta.dirname, "src")),
    ...readSources("core", path.join(import.meta.dirname, "../../packages/core/src")),
  };
  return {
    plugins: [
      cloudflareTest({
        // 計測用 D1(RESULTS_DB)は wrangler.jsonc の binding のまま(miniflare で上書きしない)。test/helpers.ts の testEnv は既定で外す
        // (計測用 D1 の無い導入と同じ「無い」状態)。有りにするテストは RESULTS_STORE を envOverride で渡すか testEnvWith({ resultsStore: true })
        wrangler: { configPath: wranglerConfigForTests(cfg) },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_RESULTS_MIGRATIONS: resultsMigrations,
            TEST_SOURCES: sources,
            // B148: E2E だけの変数(AB_PROBE_ORIGIN_OVERRIDE・AB_E2E_PROBE_OVERRIDE_ENABLED)が本番の設定に無いことを domain-probe.test.ts が見る(生の文字列で渡す)。
            // release/ は公開リポジトリに無いので、overlay はあるときだけ渡す(公開リポジトリでは apps/control/wrangler.jsonc だけを見る)
            TEST_WRANGLER_CONFIGS: wranglerConfigsForProbeCheck(),
            BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
            AB_SETUP_TOKEN: "test-setup-token",
            // backlog B36: 更新の後に流す修復 SQL(scripts/instance-admins-repair.sql)をテストで実行するため
            TEST_REPAIR_SQL: readFileSync(path.join(import.meta.dirname, "scripts/instance-admins-repair.sql"), "utf8"),
            // wrangler.jsonc の vars は本番値なので、テストは localhost 値に上書きする(/dev-assets/* が開く条件も含む)
            AB_ADMIN_URL: "http://localhost:3000",
            AB_CONTROL_URL: "http://localhost:8788",
            AB_ASSET_PUBLIC_BASE: "http://localhost:8788/dev-assets",
            AB_GOOGLE_CLIENT_ID: "test-google-client-id",
            AB_GOOGLE_CLIENT_SECRET: "test-google-client-secret",
            // 使用状況(backlog D10)。テストは既定で「未設定」。設定済みにしたいテストは envOverride で入れる
            CF_USAGE_TOKEN: "",
            CF_ACCOUNT_ID: "",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      // backlog B132 ②: worker ごとに workerd が 1 本立ち、パスワードの hash(単独でも 3.6 秒かかるテストがある)が CPU を取り合う。
      // 既定の 5 秒では、他の作業と重なって load が上がると時間切れになるので、上限を 15 秒に(個別の指定はそのまま優先される)。
      // worker 数は既定(コア数 - 1)を 7 で頭打ちにして自分の負荷を少し下げる(10 コアで所要は変わらない。CI の 4 コアは既定の 3 のまま)。
      // 既定のコア数 - 1 は `vitest run` のとき。watch の既定は floor(コア数 / 2) なので、watch ではこの値の方が多くなりうる(10 コアで 5 → 7)
      testTimeout: 15_000,
      maxWorkers: Math.max(1, Math.min(7, availableParallelism() - 1)),
    },
  };
});
