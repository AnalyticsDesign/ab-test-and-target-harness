// admin の E2E 用の偽の edge(B148)。control がタグのドメインごとに送る `/__ab/ping` を受ける。
// control は E2E だけの変数 AB_PROBE_ORIGIN_OVERRIDE と AB_E2E_PROBE_OVERRIDE_ENABLED=1(playwright.config.ts の --var)で、`.test` のドメインの確かめを
// `https://<domain>/__ab/ping` の代わりに `http://127.0.0.1:<PORT>/__ab/ping?host=<domain>` へ送る(apps/control/src/domain-probe.ts の probeUrl)。
//
// 応答(host ごと):
// - edge.example.test: この導入の edge として答える({ edge: "wtt", install: <導入の印の SHA-256> })。本物の edge は apps/edge/src/check.ts
// - slow.example.test: 4 秒待ってから 200(control の 1 本の打ち切り 3 秒より遅い = 「確かめられませんでした」)
// - ほか: 404(= Cloudflare 外)
// 導入の印は global-setup.ts が D1 の instance_settings と KV の meta:install に置く固定値(fixtures.ts の E2E_INSTALL_MARKER)で、
// playwright.config.ts が環境変数で渡す。
//
// E2E 専用の経路(本物の edge には無い): GET /__e2e/requests で、起動からの /__ab/ping の受信の数と host の並びを返す
// (domains-flow.spec.ts が「ほかの節の保存では確かめに来ない」を数える)
import { createHash } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.FAKE_EDGE_PORT ?? 8812);
const MARKER = process.env.FAKE_EDGE_INSTALL_MARKER;
if (!MARKER) {
  console.error("fake-edge-ping: FAKE_EDGE_INSTALL_MARKER is not set");
  process.exit(1);
}
const INSTALL_HASH = createHash("sha256").update(MARKER, "utf8").digest("hex");
const SLOW_MS = 4_000;
/** 受けた /__ab/ping の host(受けた順) */
const received = [];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, { ok: true }); // Playwright の webServer の起動待ち
    if (req.method === "GET" && url.pathname === "/__e2e/requests") return send(res, 200, { count: received.length, hosts: received });
    if (req.method !== "GET" || url.pathname !== "/__ab/ping") return send(res, 404, { error: "not_found" });
    const host = url.searchParams.get("host") ?? "";
    received.push(host);
    if (host === "edge.example.test") return send(res, 200, { edge: "wtt", install: INSTALL_HASH });
    if (host === "slow.example.test") {
      const timer = setTimeout(() => send(res, 200, { edge: "wtt", install: INSTALL_HASH }), SLOW_MS);
      // control が打ち切って接続を閉じたら書かない
      res.on("close", () => clearTimeout(timer));
      return;
    }
    return send(res, 404, { error: "not_found" });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake-edge-ping listening on http://127.0.0.1:${PORT}`));
