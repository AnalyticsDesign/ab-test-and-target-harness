import { CLIENT_IP_HEADER } from "@wtt/core";

/**
 * 公開の入口(default export の fetch)で、admin の service binding だけが付けてよいヘッダーを消す(plan12 K8 / 決定 63 (6))。
 * 利用者(攻撃者)が `x-wtt-client-ip` を自分で付けると、レート制限の鍵を好きな値にできてしまうため。
 * Headers は名前の大文字小文字を区別せず、`delete` は同名の値をすべて消す(同じ名前を 2 回付けた要求も残らない)。
 * 元の Request は変えず、新しい Request を返す(本文はそのまま引き継ぐ)
 */
export function stripTrustedHeaders(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.delete(CLIENT_IP_HEADER);
  return new Request(req, { headers });
}
