// admin の E2E 用の偽の Cloudflare API(決定 52)。wtt-deployer の CF_API_BASE をここに向ける。
// 受けるのは アップロードの準備 / アップロード / スクリプトの登録 の 3 つだけ。登録された manifest で /s/* を配る(配信専用の Worker の代わり)
import http from "node:http";

const PORT = Number(process.env.FAKE_CF_PORT ?? 8791);
const blobs = new Map(); // hash -> base64
const sessions = new Map(); // jwt -> manifest
let live = { manifest: {}, headers: {} };
let seq = 0;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
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
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    if (req.method === "POST" && p.endsWith("/assets-upload-session")) {
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
  })
  .listen(PORT, () => console.log(`fake cloudflare api on http://127.0.0.1:${PORT}`));
