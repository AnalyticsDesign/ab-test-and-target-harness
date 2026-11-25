// 管理画面 E2E 専用。Wrangler の複数 Worker 起動と既存の設定・binding を使い、各 Worker の監視だけを切る。
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    config: { type: "string", short: "c", multiple: true },
    port: { type: "string" },
    "persist-to": { type: "string" },
    var: { type: "string", multiple: true },
    "auth-diagnostics": { type: "boolean" },
  },
});
const port = Number(values.port);
if (!values.config?.length || !Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("E2E Worker の起動には -c と --port が必要です");
}

// 各 app が選んだ Wrangler を使う。CLI の --live-reload はブラウザ再読み込み用で、bundle の監視は止めない。
const wrangler = createRequire(resolve("package.json"))("wrangler");
const DevEnv = wrangler.unstable_DevEnv;

// 実行ごとに専用のログを作る。状態初期化や Playwright の出力消去とは別の場所に残す。
let handleAuthDiagnostics;
if (values["auth-diagnostics"]) {
  const root = resolve(".wrangler/e2e-diagnostics");
  mkdirSync(root, { recursive: true });
  const run = mkdtempSync(join(root, new Date().toISOString().replace(/[:.]/g, "-") + "-"));
  const file = join(run, "control-auth.ndjson");
  const event = /^\[wtt:e2e-control\] (\{"at":"[0-9TZ:.\-]+","path":"\/(?:me|login-options)","status":[1-5][0-9]{2},"exception":(?:null|"(?:Error|TypeError|SyntaxError|AbortError|TimeoutError|Other)")\})$/;
  console.info(`E2E auth diagnostics: ${file}`);
  handleAuthDiagnostics = ({ level, message }) => {
    const match = event.exec(message);
    if (match) {
      appendFileSync(file, match[1] + "\n");
    } else {
      console.log(`[${level}] ${message}`);
    }
  };
}

// Wrangler 4 の startDev は主 Worker と補助 Worker の両方をこのクラスで作る。
// 別プロセスへの分割を避け、接続と D1 / KV の扱いを現行のまま使う。
wrangler.unstable_DevEnv = class extends DevEnv {
  constructor(options) {
    super(options);
    const set = this.config.set.bind(this.config);
    this.config.set = (input, ...rest) => set({
      ...input,
      dev: { ...input.dev, watch: false, liveReload: false, structuredLogsHandler: handleAuthDiagnostics },
    }, ...rest);
  }
};

await wrangler.runCfWranglerDev({
  config: values.config.length === 1 ? values.config[0] : values.config,
  ip: "127.0.0.1",
  port,
  persistTo: values["persist-to"],
  var: values.var,
  local: true,
  showInteractiveDevSession: false,
});
