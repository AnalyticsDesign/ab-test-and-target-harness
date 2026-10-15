import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compile, CompileError, parseSiteSettings, kvKeys, analyticsWarnings, bakeBootstrap, staticPaths } from "../../packages/core/src/index";

// usage: fixture <input.json> <output.json> [--kv-bulk <bulk.json>] [--static-dir <dir> [--api-base <origin>]]
const args = process.argv.slice(2);
// `--name <value>` を取り除いて値を返す(位置引数と混ぜて書けるように)
function takeOption(name: string): { value: string | undefined; present: boolean } {
  const i = args.indexOf(name);
  if (i < 0) return { value: undefined, present: false };
  const value = args[i + 1];
  args.splice(i, 2);
  return { value, present: true };
}
const kvBulk = takeOption("--kv-bulk");
const staticOpt = takeOption("--static-dir");
const apiBaseOpt = takeOption("--api-base");
const bulkOut = kvBulk.value;
const staticDir = staticOpt.value;
const apiBase = apiBaseOpt.value;
const [input, output] = args;
if (!input || !output || (kvBulk.present && !bulkOut) || (staticOpt.present && !staticDir) || (apiBaseOpt.present && (!apiBase || !staticDir))) {
  console.error("usage: fixture <input.json> <output.json> [--kv-bulk <bulk.json>] [--static-dir <dir> [--api-base <origin>]]");
  process.exit(2);
}

// 引数の検査(上)で絞り込んだ値を引数で受ける(関数内では const の絞り込みが効かないため)
async function main(input: string, output: string, bulkOut: string | undefined, staticDir: string | undefined, apiBase: string | undefined): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(input, "utf8"));
  } catch {
    throw new CompileError("invalid_input", "malformed JSON");
  }
  // settings ブロック(spec §5.4 site-settings record)は compile の対象外として分離する
  const { settings: settingsIn, ...def } = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (settingsIn !== undefined && typeof settingsIn === "object" && settingsIn !== null && ("siteId" in settingsIn || "settingsVersion" in settingsIn)) {
    throw new CompileError("invalid_input", "settings block must not contain siteId/settingsVersion");
  }
  const config = compile(def);
  // spec §10.9 / §13.5: 導出値(Experiment / Variant / Goal の name)の 100 字超は control が 422 にする。CLI は警告に留めて出力は書く
  for (const w of analyticsWarnings(config)) console.error(`warning: ${w.path}: ${w.message}`);
  const settings = parseSiteSettings({
    settingsVersion: 1,
    siteId: config.siteId,
    ...(typeof settingsIn === "object" && settingsIn !== null ? settingsIn : {}),
  });
  if (settings === null) throw new CompileError("invalid_input", "invalid settings block");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(config, null, 2)); // 人間向け。KV に入る正は下の compact
  if (bulkOut) {
    // KV 値は compact JSON。compile() の 512KB 計測(JSON.stringify(config))と同一バイト列を put する(Plan 1 繰越 3)
    const entries = [
      { key: kvKeys.config(config.siteId, config.version), value: JSON.stringify(config) },
      { key: kvKeys.active(config.siteId), value: String(config.version) },
      { key: kvKeys.settings(config.siteId), value: JSON.stringify(settings) },
      ...settings.hosts.map((h) => ({ key: kvKeys.host(h), value: config.siteId })),
    ];
    mkdirSync(dirname(bulkOut), { recursive: true });
    writeFileSync(bulkOut, JSON.stringify(entries, null, 2));
  }
  if (staticDir) {
    // 決定 52: 配信専用の Worker の asset と同じパスに焼く(E2E の sample-site がこのディレクトリを /s/* で配る)
    const { RUNTIME_SOURCE, RUNTIME_HASH, PREVIEW_SOURCE, PREVIEW_HASH } = await import("../../packages/runtime/generated/source");
    const sitePath = join(staticDir, staticPaths.site(config.siteId));
    mkdirSync(dirname(sitePath), { recursive: true });
    writeFileSync(sitePath, bakeBootstrap(config, settings, RUNTIME_SOURCE, { apiBase: apiBase ?? null, runtimeHash: RUNTIME_HASH }));
    const previewPath = join(staticDir, staticPaths.preview(PREVIEW_HASH));
    mkdirSync(dirname(previewPath), { recursive: true });
    writeFileSync(previewPath, PREVIEW_SOURCE);
  }
  console.log(
    `wrote ${output} (version ${config.version}, needsProfile=${config.needsProfile})${bulkOut ? ` and ${bulkOut}` : ""}`,
  );
}

main(input, output, bulkOut, staticDir, apiBase).catch((e) => {
  if (e instanceof CompileError) {
    console.error(`compile failed: ${e.code}: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
