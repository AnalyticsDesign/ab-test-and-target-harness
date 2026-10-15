import { kvKeys, parseCompiledConfig, parseSiteSettings, SITE_ID_RE, type CompiledConfig, type SiteSettings } from "@wtt/core";
import type { Env } from "./env";

/** spec §7.4 ② / §15: KV 読取は isolate メモリに 60 秒キャッシュし、PV 数に比例させない */
const TTL_MS = 60_000;

// Site ID の受理集合は core(settings.ts)の単一定義を再輸出する(r2 CX-Medium-8)
export { SITE_ID_RE };

const MAX_CACHE_ENTRIES = 1000; // 乱数 siteId 等によるメモリ膨張の防御。実運用の Site 数では到達しない
function capped<K, V>(map: Map<K, V>): Map<K, V> {
  if (map.size >= MAX_CACHE_ENTRIES) map.clear();
  return map;
}

const settingsCache = new Map<string, { at: number; value: SiteSettings | null }>();
const activeCache = new Map<string, { at: number; value: number | null }>();
const hostCache = new Map<string, { at: number; value: string | null }>();
// spec §7.4 ②: すべて 60 秒 TTL(immutable でも isolate メモリ保持は 60 秒に揃える)
const configCache = new Map<string, { at: number; value: CompiledConfig | null }>();

export function __resetEdgeCaches(): void {
  settingsCache.clear();
  activeCache.clear();
  hostCache.clear();
  configCache.clear();
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadSettings(env: Env, siteId: string, now = Date.now()): Promise<SiteSettings | null> {
  const hit = settingsCache.get(siteId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const raw = await env.CONFIG_KV.get(kvKeys.settings(siteId));
  const parsed = raw === null ? null : parseSiteSettings(safeJson(raw));
  // key と record の不一致は fail-closed(別 Site の設定を配らない)
  const value = parsed !== null && parsed.siteId === siteId ? parsed : null;
  capped(settingsCache).set(siteId, { at: now, value });
  return value;
}

export async function loadActiveVersion(env: Env, siteId: string, now = Date.now()): Promise<number | null> {
  const hit = activeCache.get(siteId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const raw = await env.CONFIG_KV.get(kvKeys.active(siteId));
  const value = raw !== null && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
  capped(activeCache).set(siteId, { at: now, value });
  return value;
}

export async function loadConfig(env: Env, siteId: string, version: number, now = Date.now()): Promise<CompiledConfig | null> {
  const key = kvKeys.config(siteId, version);
  const hit = configCache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const raw = await env.CONFIG_KV.get(key);
  const parsed = raw === null ? null : parseCompiledConfig(safeJson(raw));
  // key と record の不一致は fail-closed(別 Site の設定を配らない)
  const value = parsed !== null && parsed.siteId === siteId && parsed.version === version ? parsed : null;
  capped(configCache).set(key, { at: now, value });
  return value;
}

export async function loadSiteIdByHost(env: Env, host: string, now = Date.now()): Promise<string | null> {
  const key = kvKeys.host(host);
  const hit = hostCache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = await env.CONFIG_KV.get(key);
  capped(hostCache).set(key, { at: now, value });
  return value;
}
