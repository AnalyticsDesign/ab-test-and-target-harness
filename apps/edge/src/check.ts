import { kvKeys } from "@wtt/core";
import type { Env } from "./env";

/** 文字列の SHA-256 を小文字の 16 進で返す */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * B139 §4.2: 導入の確認(GET /__ab/ping・/__ab/decision・/__ab/event)。
 * 「このホストの /__ab/* が、この導入の edge に届いているか」を control が確かめるための応答で、
 * KV の `meta:install` の SHA-256(16 進)を返す。値そのものは返さない。
 * Cookie を読まず書かず、サイト設定も読まない(どのホストに来ても同じ応答。サイトの情報を漏らさない)。
 * B158 の門は POST にだけ掛かるので、Sec-Fetch-Site も Content-Type も付かない GET が通る。
 * 印が無ければ(移行が終わっていない)503
 */
export async function handleCheck(env: Env): Promise<Response> {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const marker = await env.CONFIG_KV.get(kvKeys.installMarker);
  if (marker === null || marker === "") return new Response(JSON.stringify({ error: "install marker unavailable" }), { status: 503, headers });
  return new Response(JSON.stringify({ edge: "wtt", install: await sha256Hex(marker) }), { status: 200, headers });
}
