import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * B161(security triage v2 G38 (a)(b)): E2E の偽の Cloudflare API(e2e/fake-cf-api.mjs)は
 * loopback(127.0.0.1)だけで待ち受け、本文に上限を持ち、壊れた要求の URL で落ちない。子プロセスで起動して確かめる
 */

const SERVER = path.join(import.meta.dirname, "..", "e2e", "fake-cf-api.mjs");
const MAX_BODY = 1024 * 1024; // fake-cf-api.mjs の MAX_BODY と同じ値
let child: ChildProcess;
let port: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address() as net.AddressInfo;
      s.close(() => resolve(p));
    });
  });
}

/**
 * 生のソケットで要求を送り、応答の先頭(状態行を含む最初の受信)を返す。
 * 413 の後にサーバーが接続を切ると、送り残しのせいで ECONNRESET / EPIPE が出うるので、応答を受け取った後のエラーは無視する
 */
function rawRequest(payload: string | Buffer, host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let got = "";
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (c) => {
      got += c.toString("latin1");
    });
    sock.on("end", () => resolve(got));
    sock.on("close", () => (got ? resolve(got) : reject(new Error("closed without a response"))));
    sock.on("error", (e) => (got ? resolve(got) : reject(e)));
    sock.setTimeout(5000, () => sock.destroy(new Error("timeout")));
  });
}

/** 接続できるか(できたら true。拒否・到達不能は false) */
function canConnect(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.setTimeout(2000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/** この機械にある loopback 以外の接続先: IPv6 の ::1(127.0.0.1 だけで待ち受けていれば届かない)と LAN の IPv4 */
function nonLoopbackTargets(): string[] {
  const all = Object.values(os.networkInterfaces()).flatMap((list) => list ?? []);
  const out: string[] = [];
  if (all.some((a) => a.family === "IPv6" && a.address === "::1")) out.push("::1");
  const lan = all.find((a) => a.family === "IPv4" && !a.internal);
  if (lan) out.push(lan.address);
  return out;
}

beforeAll(async () => {
  port = await freePort();
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, FAKE_CF_PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes("on http://")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`fake-cf-api exited early (${code})`)));
  });
});

afterAll(() => {
  child?.kill();
});

describe("fake-cf-api (E2E helper)", () => {
  it("answers on 127.0.0.1", async () => {
    expect(await canConnect("127.0.0.1")).toBe(true);
  });

  const targets = nonLoopbackTargets();
  it.skipIf(targets.length === 0)(`does not accept connections on non-loopback addresses (${targets.join(", ") || "none"})`, async () => {
    for (const host of targets) expect(await canConnect(host), host).toBe(false);
  });

  it("answers 400 to a malformed request URL and keeps running", async () => {
    const bad = await rawRequest("GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(bad).toMatch(/^HTTP\/1\.1 400 /);
    const ok = await rawRequest("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(ok).toMatch(/^HTTP\/1\.1 200 /);
    expect(child.exitCode).toBeNull();
  });

  it("answers 413 to a body over the limit and keeps running", async () => {
    const body = Buffer.alloc(MAX_BODY + 1, 0x20);
    const head = `POST /__e2e/fail HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    const res = await rawRequest(Buffer.concat([Buffer.from(head), body]));
    expect(res).toMatch(/^HTTP\/1\.1 413 /);
    // 上限ちょうどまでは読む(超えた分だけを断る)。上限内の正しい本文は通る
    const okBody = JSON.stringify({ on: false });
    const ok = await rawRequest(`POST /__e2e/fail HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${okBody.length}\r\nConnection: close\r\n\r\n${okBody}`);
    expect(ok).toMatch(/^HTTP\/1\.1 200 /);
    expect(child.exitCode).toBeNull();
  });

  /** 通常の要求に 200 で答え、プロセスが生きていること */
  async function expectAlive() {
    const ok = await rawRequest("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(ok).toMatch(/^HTTP\/1\.1 200 /);
    expect(child.exitCode).toBeNull();
  }

  it("keeps running after the client disconnects in the middle of the body", async () => {
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.on("connect", () => {
        // 100 バイトと宣言して 10 バイトだけ送り、切る(サーバーの本文の読み取りは ECONNRESET / aborted で失敗する)
        sock.write("POST /__e2e/fail HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"on\": tru", () => {
          setTimeout(() => {
            sock.resetAndDestroy();
            resolve();
          }, 50);
        });
      });
      sock.on("error", () => resolve());
      sock.setTimeout(5000, () => reject(new Error("timeout")));
    });
    // 落ちる場合は unhandled rejection の後に終了するので、少し待ってから確かめる
    await new Promise((r) => setTimeout(r, 200));
    await expectAlive();
  });

  it("answers 400 to a malformed JSON body on /assets-upload-session and keeps running", async () => {
    const body = "{not json";
    const res = await rawRequest(`POST /client/v4/accounts/a/workers/scripts/s/assets-upload-session HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    expect(res).toMatch(/^HTTP\/1\.1 400 /);
    await expectAlive();
  });

  it("answers 400 to a script upload without the metadata part and keeps running", async () => {
    const boundary = "b0undary";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="other"\r\n\r\nx\r\n--${boundary}--\r\n`;
    const res = await rawRequest(`PUT /client/v4/accounts/a/workers/scripts/s HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    expect(res).toMatch(/^HTTP\/1\.1 400 /);
    await expectAlive();
  });
});
