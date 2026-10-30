// server.mjs の HTTPS の動かし方(WTT_TLS=1。B139 の E2E の土台)を子プロセスで確かめる:
// 自己署名の HTTPS で静的ページを返し、/v1・/__ab は Host 名(ポート無し)で転送先の edge を選び、載っていないホスト名には 404 を返す
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
let child;
let port;
let edge;
const seenByEdge = [];
const seenHeaders = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
}

/** 自己署名なので証明書の検証を省いて GET し、{ status, body } を返す。host は Host ヘッダ(ポート無しの名前を模す) */
function get(path, host, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host, ...extraHeaders }, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  // 転送先の edge の代わり(受けた要求の path を覚えて 200 を返す)
  const edgePort = await freePort();
  edge = http.createServer((req, res) => {
    seenByEdge.push(req.url);
    seenHeaders.push(req.headers);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("edge");
  });
  await new Promise((resolve) => edge.listen(edgePort, "127.0.0.1", resolve));
  port = await freePort();
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WTT_TLS: "1", WTT_EDGE_MAP: `www.example.test=http://127.0.0.1:${edgePort}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("on https://")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
});

after(() => {
  child?.kill();
  edge?.close();
});

test("serves static pages over https for any host name", async () => {
  const r = await get("/dlite.html", "form.example.test");
  assert.equal(r.status, 200);
  assert.match(r.body, /WTT sample site/);
});

test("forwards /__ab and /v1 only for host names in the edge map", async () => {
  const www = await get("/__ab/ping", "www.example.test");
  assert.equal(www.status, 200);
  assert.deepEqual(seenByEdge, ["/__ab/ping"]);
  // Host にポートが付いても同じ名前として引く
  assert.equal((await get("/v1/sites/s/decision", "www.example.test:443")).status, 200);
  // 載っていない名前(Cloudflare の外のホストを模す)は edge に届かない
  assert.equal((await get("/__ab/ping", "form.example.test")).status, 404);
  assert.equal((await get("/v1/sites/s/decision", "form.example.test")).status, 404);
  assert.equal(seenByEdge.length, 2);
});

test("forwards Sec-Fetch-Site so the edge POST gate sees the browser's value", async () => {
  const before = seenHeaders.length;
  assert.equal((await get("/__ab/ping", "www.example.test", { "sec-fetch-site": "cross-site" })).status, 200);
  assert.equal(seenHeaders[before]["sec-fetch-site"], "cross-site");
  // 付いていなければ付けない(Node の fetch が勝手に足さない)
  await get("/__ab/ping", "www.example.test");
  assert.equal(seenHeaders[before + 1]["sec-fetch-site"], undefined);
});

test("concurrent cert generation leaves one consistent key and certificate pair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wtt-tls-"));
  try {
    const tlsUrl = new URL("../tls.mjs", import.meta.url).href;
    // 鍵と証明書の全体の SHA-256 と、組として対応するか(証明書の公開鍵が鍵に合うか)を各プロセスが出力する
    const code = `import("node:crypto").then(async (crypto) => {
      const { ensureTestCert } = await import(${JSON.stringify(tlsUrl)});
      const { key, cert } = ensureTestCert(${JSON.stringify(dir)});
      const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
      const matches = new crypto.X509Certificate(cert).checkPrivateKey(crypto.createPrivateKey(key));
      process.stdout.write(JSON.stringify({ key: sha(key), cert: sha(cert), matches }));
    })`;
    const outs = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ["-e", code]).then((r) => JSON.parse(r.stdout))));
    assert.ok(outs.every((o) => o.matches === true), "every process must get a key that matches its certificate");
    assert.equal(new Set(outs.map((o) => o.key)).size, 1, "all processes must read the same key");
    assert.equal(new Set(outs.map((o) => o.cert)).size, 1, "all processes must read the same certificate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
