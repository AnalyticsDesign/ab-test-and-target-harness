import { detectBrowser, detectDevice, detectOs, type PageContext } from "@wtt/core";

export { detectDevice }; // 判定は core(control の evaluate と同じ関数)。既存のテストの import 先を保つ

export type ContextSource = {
  url: string;
  referrer: string;
  userAgent: string;
  width: number;
  height: number;
  /** 幅を読む時点で `meta[name=viewport]` があるか。無ければ幅は不明(決定 49、設計書 §11) */
  hasViewportMeta: boolean;
  /** 判定時刻(epoch ミリ秒)。1 回の判定の最初に 1 度だけ取る */
  now: number;
  /** 初回の訪問時刻。Mode A / C は正本(参考用)の発行時刻、D-lite は undefined(edge が Cookie から読む) */
  firstVisitAt?: number | null;
};

/**
 * spec §10.1 / 決定 49 §11.1: 判定の入力を集める。端末・ブラウザ・OS は User-Agent だけから判定する(spec §6.1)。
 * 画面の幅は viewport の meta が無い時点では不明として扱う(iPhone の Safari は meta より前だと 980 を返す)。
 * viewport は decision の body で送る値(meta が無ければ送らない = edge でも不明)
 */
export function collectContext(src: ContextSource): { ctx: PageContext; viewport: { w: number; h: number } | null } {
  let query: Record<string, string> = {};
  try {
    query = Object.fromEntries(new URL(src.url).searchParams);
  } catch {
    // URL として解釈できない場合はクエリなし(ホスト・パスの条件は判定できない側に倒れる)
  }
  const ua = src.userAgent;
  const ctx: PageContext = { url: src.url, query, device: detectDevice(ua), browser: detectBrowser(ua), os: detectOs(ua), referrer: src.referrer, now: src.now };
  if (src.hasViewportMeta) ctx.viewportWidth = src.width;
  if (src.firstVisitAt !== undefined) ctx.firstVisitAt = src.firstVisitAt;
  return { ctx, viewport: src.hasViewportMeta ? { w: src.width, h: src.height } : null };
}
