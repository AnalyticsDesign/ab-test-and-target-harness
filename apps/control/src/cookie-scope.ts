// B139: 訪問者 ID の Cookie を共有する範囲(Cookie の Domain)を、サイトの設定から導く。
// 入力はタグを置くドメインの一覧(domains_json。B148 で hosts と allowedOrigins から差し替えた。差し替えたのは tagHosts だけ)
import { getDomain } from "tldts";
import type { SiteRow } from "./db";
import type { DomainRow } from "./domains";

/** 共有の範囲 1 つ(登録ドメイン)と、そこに属するタグを置くホスト */
export type CookieGroup = { domain: string; hosts: string[] };

/**
 * ホスト名の登録ドメイン(Cookie の Domain にできる最も広い範囲)。私的な接尾辞(pages.dev・workers.dev・github.io など)も接尾辞として扱う。
 * IP アドレス・localhost・公開の接尾辞そのもの(co.jp など)は null(Domain を付けて共有できない)
 */
export function registrableDomain(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true }) ?? null;
}

/** タグを置くホスト = 一覧の開発用でない行の値(一覧の順。値はそろえて保存してあるので重複しない)。開発用の行(http・ポート付きの Origin)は共有しない */
export function tagHosts(row: SiteRow): string[] {
  return (JSON.parse(row.domains_json) as DomainRow[]).filter((d) => d.verdict !== "dev").map((d) => d.value);
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
