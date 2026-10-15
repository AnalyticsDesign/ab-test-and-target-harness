// E2E 用: 静的 sample-site + /s(fixture の CLI が焼いたファイル = 配信専用の Worker の代わり)+ /v1 /__ab を wrangler dev へ転送する同一オリジンプロキシ
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const EDGE = process.env.WTT_EDGE_URL ?? "http://127.0.0.1:8787";
const PORT = Number(process.env.PORT ?? 4173);
// 待ち受けは loopback だけ(E2E 用のヘルパー。同じネットワークの第三者に本文を送り込まれない)。LAN から見たいときだけ HOST=0.0.0.0
const HOST = process.env.HOST ?? "127.0.0.1";
// 転送する本文の上限。decision / event の本文は数 KB なので 1 MiB で十分。超えたら 413 で切る(無制限にバッファしない)
const MAX_BODY = 1024 * 1024;
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const STATIC = join(fileURLToPath(new URL(".", import.meta.url)), ".static");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css", ".png": "image/png" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/s/")) {
    // 配信専用の Worker と同じヘッダ(_headers)。無いファイルは 404(未 Publish の Site)
    try {
      const file = await readFile(join(STATIC, normalize(url.pathname).replace(/^([.][.][/\\])+/, "")));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" });
      res.end(file);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
    return;
  }
  if (/^\/(v1|__ab)\//.test(url.pathname)) {
    const upstreamUrl = EDGE + url.pathname + url.search;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    try {
      const chunks = [];
      let size = 0;
      if (hasBody) {
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) {
            res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
            res.end("payload too large");
            req.destroy();
            return;
          }
          chunks.push(c);
        }
      }
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: {
          ...(hasBody ? { "content-type": req.headers["content-type"] ?? "application/json" } : {}),
          ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
          ...(req.headers.origin ? { origin: req.headers.origin } : {}),
        },
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const headers = {};
      upstream.headers.forEach((v, k) => {
        if (!["set-cookie", "content-encoding", "content-length", "transfer-encoding"].includes(k)) headers[k] = v;
      });
      const setCookies = upstream.headers.getSetCookie();
      if (setCookies.length > 0) headers["set-cookie"] = setCookies; // 複数 Set-Cookie を配列のまま渡す
      res.writeHead(upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      // wrangler dev が未起動/クラッシュ/ポート競合の場合でもプロセス全体を落とさず、この 1 リクエストだけ失敗させる
      console.error(`wtt proxy: upstream failed (${upstreamUrl}):`, e);
      if (res.headersSent) {
        res.end(); // ヘッダ送信後に上流が壊れた場合は close するだけ(二重 writeHead を避ける)
      } else {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`wtt proxy: upstream failed: ${upstreamUrl}`);
      }
    }
    return;
  }
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const file = await readFile(join(ROOT, normalize(path).replace(/^([.][.][/\\])+/, "")));
    const headers = { "content-type": TYPES[extname(path)] ?? "application/octet-stream" };
    // Code Change の CSP 検証ページ(spec §11 / 決定 38)。'unsafe-inline' / 'unsafe-eval' は付けない
    // - code-csp.html: nonce + 'strict-dynamic' の下で runtime が生成する <script> / <style> が動くことを Chromium で証明する
    // - blocked-js.html: 'self' だけの allowlist で、runtime 自体(同一オリジン)は読めるが生成する inline <script> はブロックされる
    if (path === "/code-csp.html") headers["content-security-policy"] = "script-src 'nonce-wttE2E' 'strict-dynamic'; style-src 'nonce-wttE2E'";
    if (path === "/blocked-js.html") headers["content-security-policy"] = "script-src 'self'";
    res.writeHead(200, headers);
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
// 遅い送信で接続を占有されないよう、ヘッダと要求全体の待ち時間を短くする(Node の既定はそれぞれ 60 秒 / 300 秒)
server.headersTimeout = 10_000;
server.requestTimeout = 10_000;
server.listen(PORT, HOST, () => console.log(`sample-site with edge proxy on http://${HOST}:${PORT}`));
