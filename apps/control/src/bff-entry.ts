/**
 * admin の service binding の入口(index.ts の ControlBff)から来た要求の印(Q528)。
 * ヘッダーや本文ではなく、この isolate のメモリの上で Request の実体そのものに付ける。
 * 公開の入口から来た要求は、送り手が何を足しても印を持てない(外から偽れない)。
 * index.ts の cloudflare:workers に依存させないため、別のファイルに置く(app.ts は Node のスクリプトからも読まれる)
 */
const fromBff = new WeakSet<Request>();

/** ControlBff が app へ渡す直前に呼ぶ */
export function markFromBff(req: Request): Request {
  fromBff.add(req);
  return req;
}

/** その要求が ControlBff から来たか。app.ts は c.req.raw(app.fetch に渡された Request そのもの)で聞く */
export function isFromBff(req: Request): boolean {
  return fromBff.has(req);
}
