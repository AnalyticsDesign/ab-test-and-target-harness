// admin の E2E 用の偽の Cloudflare API(決定 52)。wtt-deployer の CF_API_BASE をここに向ける。
// 受けるのは アップロードの準備 / アップロード / スクリプトの登録 の 3 つだけ。登録された manifest で /s/* を配る(配信専用の Worker の代わり)
// E2E 専用の切り替え(本物の API には無い経路): POST /__e2e/fail { on: boolean } で、on のあいだアップロードの準備を
// 503 + Authentication error にする(トークンの問題で配置が止まった状態。static-delivery.spec.ts が使い、終わりに必ず on: false に戻す)
import http from "node:http";

const PORT = Number(process.env.FAKE_CF_PORT ?? 8791);
// 本文の上限(sample-site の server.mjs と同じ考え方。超えたら 413 で切り、無制限にバッファしない)。
// いちばん大きいのはアップロード(base64 の multipart)で、1 ファイル = runtime(約 28 KB)+ E2E の小さな config。
// E2E の Site は 6 つほどで、一度登録したハッシュは送り直さないので、まとめて送っても 0.5 MiB に届かない
const MAX_BODY = 1024 * 1024;
const blobs = new Map(); // hash -> base64
const sessions = new Map(); // jwt -> manifest
let live = { manifest: {}, headers: {} };
let seq = 0;
let failing = false;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
class BodyTooLarge extends Error {}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new BodyTooLarge();
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
/** _headers の書式を { name: value } にする(/s/* の 1 規則だけを想定) */
function parseHeaders(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

http
  .createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      // どの例外もここで受ける(投げ直すと async の中の拒否を誰も受けず、プロセスごと落ちる)。
      // 本文の送信途中の切断(ECONNRESET / aborted)・応答の送信後の例外では、もう答えられないので接続を閉じるだけにする
      if (res.headersSent || !res.socket || res.socket.destroyed) {
        res.destroy();
        return;
      }
      if (e instanceof BodyTooLarge) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ success: false, errors: [{ code: 413, message: "payload too large" }] }));
        req.destroy();
        return;
      }
      // 残りは壊れた入力(JSON の誤り・multipart の部分の欠け など)として 400 で返す
      send(res, 400, { success: false, errors: [{ code: 400, message: `bad request: ${e instanceof Error ? e.message : String(e)}` }] });
    }
  })
  // loopback だけで待ち受ける(同じネットワークの第三者に /__e2e/fail を押されたり、偽のファイルを登録されたりしない)
  .listen(PORT, "127.0.0.1", () => console.log(`fake cloudflare api on http://127.0.0.1:${PORT}`));

async function handle(req, res) {
  // 壊れた要求の URL(例 `//[`)で投げると async の中の拒否を誰も受けずプロセスごと落ちるので、400 で返す
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    return send(res, 400, { success: false, errors: [{ code: 400, message: "bad request url" }] });
  }
  const p = url.pathname;
  if (req.method === "POST" && p === "/__e2e/fail") {
    const body = await readBody(req); // 上限超えの 413 は外の catch に任せる(下の JSON の誤りと分ける)
    let on;
    try {
      on = JSON.parse(body.toString("utf8")).on;
    } catch {
      on = undefined;
    }
    if (typeof on !== "boolean") return send(res, 400, { success: false, errors: [{ code: 400, message: "body must be { on: boolean }" }] });
    failing = on;
    return send(res, 200, { success: true, result: { failing } });
  }
  if (req.method === "POST" && p.endsWith("/assets-upload-session")) {
    if (failing) {
      await readBody(req); // 本文は読み捨てる(接続を正しく閉じるため)
      return send(res, 503, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    }
    const { manifest } = JSON.parse((await readBody(req)).toString("utf8"));
    const jwt = `s${++seq}`;
    sessions.set(jwt, manifest);
    const missing = [...new Set(Object.values(manifest).map((e) => e.hash))].filter((h) => !blobs.has(h));
    return send(res, 200, { success: true, result: { jwt, buckets: missing.length ? [missing] : [] } });
  }
  if (req.method === "POST" && p.endsWith("/workers/assets/upload")) {
    const jwt = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const form = await new Request(`http://x${req.url}`, { method: "POST", headers: req.headers, body: await readBody(req) }).formData();
    for (const [hash, file] of form.entries()) blobs.set(hash, await file.text());
    return send(res, 201, { success: true, result: { jwt: `done:${jwt}` } });
  }
  if (req.method === "PUT" && /\/workers\/scripts\/[^/]+$/.test(p)) {
    const form = await new Request(`http://x${req.url}`, { method: "PUT", headers: req.headers, body: await readBody(req) }).formData();
    const meta = JSON.parse(await form.get("metadata").text());
    const manifest = sessions.get(String(meta.assets.jwt).replace(/^done:/, ""));
    if (!manifest) return send(res, 400, { success: false, errors: [{ code: 1, message: "unknown jwt" }] });
    live = { manifest, headers: parseHeaders(meta.assets.config?._headers) };
    return send(res, 200, { success: true, result: { id: "wtt-static" } });
  }
  if (req.method === "GET" && p.startsWith("/s/")) {
    const entry = live.manifest[p];
    if (!entry) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    res.writeHead(200, live.headers);
    return res.end(Buffer.from(blobs.get(entry.hash), "base64"));
  }
  if (req.method === "GET" && p === "/") return res.end("fake-cf-api");
  send(res, 404, { success: false, errors: [{ code: 404, message: "not found" }] });
}
