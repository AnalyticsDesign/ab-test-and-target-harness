// server.mjs(E2E 用のヘルパー)を子プロセスで起動して、壊れた要求で落ちないことを確かめる(B161 / G38 (b))
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
let child;
let port;

/** 空いているポートを 1 つ選ぶ(一度 0 番で待ち受けて番号を読み、閉じる) */
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

/** 生のソケットで要求を送り、応答の全文を返す(相手が閉じるまで読む) */
function rawRequest(payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const chunks = [];
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    sock.on("error", reject);
    sock.setTimeout(5000, () => sock.destroy(new Error("timeout")));
  });
}

before(async () => {
  port = await freePort();
  // WTT_EDGE_URL へ転送する経路は叩かないので、届かない先でよい
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WTT_EDGE_URL: "http://127.0.0.1:9" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("on http://")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });
});

after(() => child?.kill());

test("a malformed request URL gets 400 and the server keeps answering", async () => {
  const bad = await rawRequest("GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  assert.match(bad, /^HTTP\/1\.1 400 /);
  // 落ちていないこと: 続けて通常の要求に答える(無い配信ファイルは 404)
  const ok = await rawRequest("GET /s/nope.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  assert.match(ok, /^HTTP\/1\.1 404 /);
  assert.equal(child.exitCode, null);
});
