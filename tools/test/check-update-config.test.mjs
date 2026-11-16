import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../check-update-config.mjs", import.meta.url));
const account = "a".repeat(32);
const kv = { binding: "CONFIG_KV", id: "b".repeat(32) };
const db = { binding: "DB", database_name: "wtt-control-restore", database_id: "11111111-2222-3333-4444-555555555555" };
const results = { binding: "RESULTS_DB", database_name: "wtt-results", database_id: "22222222-3333-4444-5555-666666666666" };
const zeroDb = "00000000-0000-0000-0000-000000000000";
const controlUrl = "https://wtt-control.team-demo.workers.dev";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "wtt-update-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const configs = structuredClone({
    edge: {
      routes: [{ pattern: "deploy.example-team.net/v1/*", zone_name: "example-team.net" }],
      d1_databases: [{ ...results }],
      kv_namespaces: [kv],
    },
    control: {
      d1_databases: [db, results],
      kv_namespaces: [kv],
      vars: {
        AB_CONTROL_URL: controlUrl,
        AB_ADMIN_URL: "https://wtt-admin.team-demo.workers.dev",
        AB_EDGE_ORIGIN: "https://deploy.example-team.net",
        CF_ACCOUNT_ID: account,
      },
    },
    admin: { vars: { AB_CONTROL_URL: controlUrl } },
    deployer: { vars: { CF_ACCOUNT_ID: account } },
  });
  const check = ({ args = [], accountId = account, overwrite = {} } = {}) => {
    for (const [app, config] of Object.entries(configs)) {
      const dir = join(cwd, "apps", app);
      mkdirSync(dir, { recursive: true });
      const jsonc = JSON.stringify(config, null, 2).replace(/\n}$/, ",\n}");
      writeFileSync(join(dir, "wrangler.jsonc"), overwrite[app] ?? `// "id": "00000000000000000000000000000000"\r\n${jsonc}\n`);
    }
    return spawnSync(process.execPath, [cli, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    });
  };
  return { configs, check };
}

test("JSONC のコメントを飛ばし、復旧した D1 と R2 無しの構成を通す", (t) => {
  const r = fixture(t).check();
  assert.equal(r.status, 0, r.stderr);
});

test("workers.dev の構成では Route なしと別のタグ用 URL を通す", (t) => {
  const { configs, check } = fixture(t);
  delete configs.edge.routes;
  configs.edge.workers_dev = true;
  configs.control.vars.AB_EDGE_ORIGIN = "https://wtt-edge.team-demo.workers.dev";
  configs.control.vars.AB_STATIC_ORIGIN = "https://wtt-static.team-demo.workers.dev";
  assert.equal(check().status, 0);
});

test("仮の D1・KV・URL・Route・アカウントを検出し、値は出力しない", (t) => {
  const { configs, check } = fixture(t);
  configs.control.d1_databases[0].database_id = zeroDb;
  configs.edge.kv_namespaces[0].id = "0".repeat(32);
  configs.edge.routes[0].pattern = "www.example.com/v1/*";
  configs.control.vars.AB_ASSET_PUBLIC_BASE = "https://wtt-control.example.workers.dev/dev-assets";
  configs.admin.vars.AB_CONTROL_URL = "https://wtt-control.example.workers.dev";
  configs.deployer.vars.CF_ACCOUNT_ID = "0".repeat(32);
  configs.control.vars.CF_ACCOUNT_ID = "";
  configs.edge.account_id = "c".repeat(32);
  const r = check();
  assert.equal(r.status, 1, r.stderr);
  for (const field of [/d1_databases.*DB.*database_id/, /kv_namespaces.*CONFIG_KV.*id/, /routes.*pattern/, /AB_ASSET_PUBLIC_BASE/, /admin.*AB_CONTROL_URL/, /deployer.*CF_ACCOUNT_ID/, /control.*CF_ACCOUNT_ID/, /edge.*account_id/]) {
    assert.match(r.stderr, field);
  }
  assert.doesNotMatch(r.stderr, /wtt-control\.example\.workers\.dev|00000000-0000/);
});

test("計測 D1 の新設準備だけで両方の雛形 ID を許し、他の仮値は拒む", (t) => {
  const { configs, check } = fixture(t);
  configs.edge.d1_databases[0].database_id = zeroDb;
  configs.control.d1_databases[1].database_id = zeroDb;
  const preparation = { args: ["--new-results-db"] };
  assert.equal(check().status, 1);
  assert.equal(check(preparation).status, 0);
  configs.control.d1_databases[0].database_id = zeroDb;
  assert.equal(check(preparation).status, 1);
  configs.control.d1_databases[0].database_id = db.database_id;
  configs.control.d1_databases[1].database_id = results.database_id;
  assert.equal(check(preparation).status, 1);
  configs.edge.d1_databases[0].database_id = results.database_id;
  assert.equal(check().status, 0);
});

test("未固定のアカウント・未設定の主 D1・壊れた JSONC で失敗する", (t) => {
  const { configs, check } = fixture(t);
  assert.match(check({ accountId: "" }).stderr, /CLOUDFLARE_ACCOUNT_ID/);
  delete configs.control.d1_databases;
  assert.match(check().stderr, /d1_databases.*DB/);
  assert.match(check({ overwrite: { admin: '{ "vars": /* comment */' } }).stderr, /apps\/admin\/wrangler\.jsonc/);
});
