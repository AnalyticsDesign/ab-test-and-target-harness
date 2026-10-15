import type { SiteSettings } from "@wtt/core";

/** spec §4.1: 完全一致のみ。Origin 欠落・"null"・ワイルドカードは拒否。allowedOrigins 空は全拒否 */
export function originAllowed(settings: SiteSettings, origin: string | null): origin is string {
  if (!origin || origin === "null" || origin === "*") return false;
  return settings.allowedOrigins.includes(origin);
}

export function corsHeaders(origin: string): Record<string, string> {
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

/** spec §9.5: decision / event 共用の preflight 応答ヘッダ */
export function preflightHeaders(origin: string): Record<string, string> {
  return {
    ...corsHeaders(origin),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
