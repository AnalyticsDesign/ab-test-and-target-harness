import { pathToFileURL } from "node:url";
import { STATIC_HEADERS_FILE, STATIC_SCRIPT_COMPATIBILITY_DATE, STATIC_SCRIPT_SOURCE, staticPaths } from "@wtt/core";
import { PREVIEW_HASH, PREVIEW_SOURCE } from "@wtt/runtime/source";
import { assetHash, toBase64 } from "../src/assets";
import { deployAssets, ensureRoute, scriptExists, setWorkersDev, STATIC_SCRIPT_NAME_RE, zoneIdOf, type CfApiConfig } from "../src/cf-api";

type SetupOptions = { routes: Array<{ pattern: string; zone: string }>; workersDev?: boolean; toScript?: string };

/**
 * 決定 52 / plan K12: 導入・移行のときに手元で 1 回だけ実行する。配信専用の Worker を作り(既にあれば触らない)、
 * ルートを向け、workers.dev を切り替える。以後のスクリプトと asset の更新はデプロイ専用の Worker だけが行う。
 * トークンは wrangler のログインの OAuth トークン(workers_scripts:write / workers_routes:write / zone:read を含む)
 */
export async function setupStatic(cfg: CfApiConfig, opts: SetupOptions): Promise<string[]> {
  const log: string[] = [];
  if (opts.toScript) {
    // 切り戻し: ルートだけを付け替える。スクリプトの作成・デプロイ・workers.dev の切り替えは一切しない(どの Worker も書き換えない)
    for (const r of opts.routes) {
      const out = await ensureRoute(cfg, await zoneIdOf(cfg, r.zone), r.pattern, opts.toScript);
      log.push(`route ${r.pattern}: ${out.result}${out.from ? ` from ${out.from}` : ""} (to ${opts.toScript})`);
    }
    return log;
  }
  // 名前を誤って別の Worker(wtt-edge など)にしても、その Worker を 404 のスクリプトで上書きしない
  if (!STATIC_SCRIPT_NAME_RE.test(cfg.scriptName)) throw new Error(`not_configured: STATIC_SCRIPT_NAME must match ${STATIC_SCRIPT_NAME_RE}`);
  if (await scriptExists(cfg)) {
    log.push("script: exists (kept)");
  } else {
    // 中身はプレビューのファイルだけ。Site のファイルはデプロイ専用の Worker の最初のデプロイで入る
    const { b64, size } = toBase64(PREVIEW_SOURCE);
    const hash = await assetHash(b64, "js");
    await deployAssets(cfg, {
      manifest: { [staticPaths.preview(PREVIEW_HASH)]: { hash, size } },
      contentOf: async () => b64,
      headersFile: STATIC_HEADERS_FILE,
      scriptSource: STATIC_SCRIPT_SOURCE,
      compatibilityDate: STATIC_SCRIPT_COMPATIBILITY_DATE,
    });
    log.push("script: created");
  }
  for (const r of opts.routes) {
    const out = await ensureRoute(cfg, await zoneIdOf(cfg, r.zone), r.pattern);
    log.push(`route ${r.pattern}: ${out.result}${out.from ? ` from ${out.from}` : ""}`);
  }
  if (opts.workersDev !== undefined) {
    await setWorkersDev(cfg, opts.workersDev);
    log.push(`workers.dev: ${opts.workersDev ? "on" : "off"}`);
  }
  return log;
}

function parseArgs(argv: string[]): SetupOptions {
  const routes: Array<{ pattern: string; zone: string }> = [];
  let workersDev: boolean | undefined;
  let toScript: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--route") {
      const pattern = argv[++i];
      if (argv[++i] !== "--zone" || !pattern) throw new Error("usage: --route <pattern> --zone <zone_name>");
      const zone = argv[++i];
      if (!zone) throw new Error("usage: --route <pattern> --zone <zone_name>");
      routes.push({ pattern, zone });
    } else if (argv[i] === "--workers-dev") {
      const v = argv[++i];
      if (v !== "on" && v !== "off") throw new Error("usage: --workers-dev on|off");
      workersDev = v === "on";
    } else if (argv[i] === "--to-script") {
      toScript = argv[++i];
      if (!toScript) throw new Error("usage: --to-script <name>");
    } else if (argv[i] !== "--") {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (toScript && (routes.length === 0 || workersDev !== undefined)) throw new Error("usage: --to-script <name> needs --route and cannot be used with --workers-dev");
  return { routes, workersDev, toScript };
}

// tsx で直接実行したときだけ動く(テストは setupStatic を import する)。Windows でも一致するよう pathToFileURL で比べる
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    console.error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (wrangler auth token)");
    process.exit(2);
  }
  try {
    const opts = parseArgs(process.argv.slice(2));
    const log = await setupStatic({ accountId, token, scriptName: process.env.STATIC_SCRIPT_NAME || "wtt-static" }, opts);
    log.forEach((l) => console.log(l));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
