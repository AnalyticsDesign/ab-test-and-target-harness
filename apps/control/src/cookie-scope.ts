// B139: 訪問者 ID の Cookie を共有する範囲(Cookie の Domain)を、サイトの設定から導く。
// B139 の段階の入力は hosts と allowedOrigins(spec §10.1)。B148 で入力を domains に差し替える(差し替えるのは tagHosts だけ)
import { getDomain } from "tldts";
import type { SiteRow } from "./db";

/** 共有の範囲 1 つ(登録ドメイン)と、そこに属するタグを置くホスト */
export type CookieGroup = { domain: string; hosts: string[] };

/**
 * ホスト名の登録ドメイン(Cookie の Domain にできる最も広い範囲)。私的な接尾辞(pages.dev・workers.dev・github.io など)も接尾辞として扱う。
 * IP アドレス・localhost・公開の接尾辞そのもの(co.jp など)は null(Domain を付けて共有できない)
 */
export function registrableDomain(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true }) ?? null;
}

/** Origin の文字列からホスト名を取る。https で、ポートの無いものだけ(http・ポート付きは開発用として除く)。読めない値は null */
function originHost(origin: string): string | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  return u.protocol === "https:" && u.port === "" ? u.hostname : null;
}

/** タグを置くホスト = hosts ∪ allowedOrigins のホスト(重複を除き、出てきた順)。B148 でこの関数の入力を domains に差し替える */
export function tagHosts(row: SiteRow): string[] {
  const hosts = JSON.parse(row.hosts_json) as string[];
  const origins = (JSON.parse(row.allowed_origins_json) as string[]).map(originHost).filter((h): h is string => h !== null);
  return Array.from(new Set([...hosts, ...origins].map((h) => h.toLowerCase())));
}

/**
 * 共有の範囲を導く。共有がオン(share_subdomains = 1)なら、タグを置くホストを登録ドメインで束ねる(登録ドメインの無いホストは入れない)。
 * オフなら両方とも空(Cookie はホスト限定)。scopes = groups の domain の並び(KV の cookieDomains になる)
 */
export function deriveCookieScopes(row: SiteRow): { groups: CookieGroup[]; scopes: string[] } {
  if (row.share_subdomains !== 1) return { groups: [], scopes: [] };
  const groups = new Map<string, string[]>();
  for (const host of tagHosts(row)) {
    const domain = registrableDomain(host);
    if (domain === null) continue;
    const list = groups.get(domain);
    if (list) list.push(host);
    else groups.set(domain, [host]);
  }
  const out = Array.from(groups, ([domain, hosts]) => ({ domain, hosts }));
  return { groups: out, scopes: out.map((g) => g.domain) };
}
