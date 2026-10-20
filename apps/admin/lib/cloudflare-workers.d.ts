// Workers ランタイムの組み込みモジュール `cloudflare:workers` の型(admin が使う部分だけ)。
// @cloudflare/workers-types は足さない(DOM の型 lib: ["dom"] と重なるため)。
// このファイルは import / export を持たない(= モジュールの拡張ではなく、全体に効く宣言にする)

/** service binding(wrangler.jsonc の services)。control の Worker を内部の接続で呼ぶ */
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

declare module "cloudflare:workers" {
  /** wrangler.jsonc の services。binding の無い構成では undefined */
  export const env: { CONTROL?: Fetcher };
}
