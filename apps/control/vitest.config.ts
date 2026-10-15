import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * 写しは .wrangler/ に置くので、相対パス(main / migrations_dir)は絶対パスにする
 */
function wranglerConfigForTests(): string {
  const cfg = readJsonc(path.join(import.meta.dirname, "wrangler.jsonc"));
  delete cfg.services;
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
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
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
        wrangler: { configPath: wranglerConfigForTests() },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SOURCES: sources,
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
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
