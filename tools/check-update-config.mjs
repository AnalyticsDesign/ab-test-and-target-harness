// 更新前に、導入先を指す設定の仮値を検出する。Cloudflare への接続やファイルの変更は行わない。
import { readFileSync } from "node:fs";

const apps = ["edge", "deployer", "control", "admin"];
const zeroD1 = "00000000-0000-0000-0000-000000000000";
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const args = process.argv.slice(2);
const newResultsDb = args[0] === "--new-results-db" && args.length === 1;
if (args.length && !newResultsDb) {
  console.error("使い方: node tools/check-update-config.mjs [--new-results-db]");
  process.exit(1);
}

function readJsonc(path) {
  // 文字列はそのまま残し、コメントと末尾カンマだけを除く。URL の // や /* を壊さない。
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const withoutComments = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (part) => part.startsWith("/") ? " " : part);
  const config = JSON.parse(withoutComments.replace(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g,
    (part) => part === "," ? "" : part));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
  return config;
}

function hexId(value) {
  return typeof value === "string" && /^[\da-f]{32}$/i.test(value) && !/^0+$/.test(value);
}

function d1Id(value) {
  return typeof value === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) && value !== zeroD1;
}

function realHost(host) {
  return typeof host === "string" && host.includes(".") &&
    !/(^|\.)(?:example\.(?:com|net|org)|example\.workers\.dev)\.?$/i.test(host);
}

function realUrl(value) {
  const url = typeof value === "string" && URL.parse(value);
  return url && url.protocol === "https:" && realHost(url.hostname);
}

function bindingId(config, group, binding, field) {
  const entries = Array.isArray(config[group]) ? config[group].filter((entry) => entry?.binding === binding) : [];
  return entries.length === 1 ? entries[0][field] : undefined;
}

const problems = [];
if (!hexId(account)) problems.push("CLOUDFLARE_ACCOUNT_ID: 確認済みの Account ID を設定してください");

for (const app of apps) {
  const path = `apps/${app}/wrangler.jsonc`;
  let config;
  try {
    config = readJsonc(path);
  } catch {
    problems.push(`${path}: 設定を読み取れません。ファイルの場所と JSONC の構文を確認してください`);
    continue;
  }

  const vars = config.vars ?? {};
  const check = (ok, field) => {
    if (!ok) problems.push(`${path}: ${field} を導入先の設定に合わせてください`);
  };

  if (config.account_id !== undefined) check(hexId(account) && config.account_id === account, "account_id");
  if (app === "deployer" || vars.CF_ACCOUNT_ID !== undefined) {
    check(hexId(account) && vars.CF_ACCOUNT_ID === account, "vars.CF_ACCOUNT_ID");
  }

  if (app === "edge" || app === "control") {
    const kv = bindingId(config, "kv_namespaces", "CONFIG_KV", "id");
    check(hexId(kv), "kv_namespaces.CONFIG_KV.id");
    const results = bindingId(config, "d1_databases", "RESULTS_DB", "database_id");
    // 計測 DB が未作成のときだけ、両側の仮 ID を許す。移行の前に通常の検査を行う。
    check(newResultsDb ? results === zeroD1 : d1Id(results), "d1_databases.RESULTS_DB.database_id");
  }
  if (app === "control") {
    check(d1Id(bindingId(config, "d1_databases", "DB", "database_id")), "d1_databases.DB.database_id");
    check(realUrl(vars.AB_ADMIN_URL), "vars.AB_ADMIN_URL");
    check(realUrl(vars.AB_EDGE_ORIGIN), "vars.AB_EDGE_ORIGIN");
    if (vars.AB_STATIC_ORIGIN !== undefined) check(realUrl(vars.AB_STATIC_ORIGIN), "vars.AB_STATIC_ORIGIN");
    if (vars.AB_ASSET_PUBLIC_BASE) check(realUrl(vars.AB_ASSET_PUBLIC_BASE), "vars.AB_ASSET_PUBLIC_BASE");
  }
  if (app === "control" || app === "admin") check(realUrl(vars.AB_CONTROL_URL), "vars.AB_CONTROL_URL");

  const routes = config.routes ?? (config.route === undefined ? [] : [config.route]);
  check(Array.isArray(routes), "routes");
  if (!Array.isArray(routes)) continue;
  routes.forEach((route, index) => {
    const pattern = typeof route === "string" ? route : route?.pattern;
    const host = typeof pattern === "string" && pattern.replace(/^https?:\/\//i, "").split("/")[0].replace(/^\*\.?/, "");
    check(realHost(host), `routes[${index}].pattern`);
    if (route?.zone_name !== undefined) check(realHost(route.zone_name), `routes[${index}].zone_name`);
    if (route?.zone_id !== undefined) check(hexId(route.zone_id), `routes[${index}].zone_id`);
  });
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log("更新前の設定確認: OK");
}
