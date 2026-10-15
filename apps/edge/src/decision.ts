import { decide, experimentsForUrl, patternsForUrl, type CompiledConfig, type DecisionBody, type DecisionResponse, type PageContext, type SiteSettings } from "@wtt/core";
import type { Env } from "./env";
import { profileStub } from "./profile";

const MAX_BODY_BYTES = 4096; // spec §6.4 / §9.5

export async function readBodyWithin4kb(req: Request): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false };
  if (!req.body) return { ok: true, text: "" };
  // Content-Length は欠落・過小申告があり得るため、実バイトを逐次数え 4096 超過時点で読むのをやめる(全展開しない)
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buf) };
}

/**
 * spec §9.1 / 決定 49 §11.1: body が評価入力のすべて。query は body.url から復元する。判定時刻は edge が決めて固定し、DO にも同じ値を渡す。
 * body に無い値(古い runtime は browser / os / firstVisitAt を送らない。viewport の meta が無いページは viewport を送らない)は
 * 欠けたままにする = それを使う条件を含むエクスペリエンスだけが対象外になる
 */
export function toPageContext(body: DecisionBody, now: number, firstVisitAt: number | null | undefined): PageContext {
  let query: Record<string, string> = {};
  try {
    query = Object.fromEntries(new URL(body.url).searchParams);
  } catch {
    // URL として解釈できない場合はクエリなし(ホスト・パスの条件は判定できない側に倒れる)
  }
  const ctx: PageContext = { url: body.url, query, device: body.device, referrer: body.referrer, now };
  if (body.browser !== undefined) ctx.browser = body.browser;
  if (body.os !== undefined) ctx.os = body.os;
  // 古い runtime(Publish 直後の bootstrap キャッシュ、最大 約 60 秒)は viewport の meta が無くても viewport を送るが無害: 新しい条件は新しい control の Publish 後にしか存在せず、そのころには古い bootstrap は失効している
  if (body.viewport !== undefined) ctx.viewportWidth = body.viewport.w;
  if (firstVisitAt !== undefined) ctx.firstVisitAt = firstVisitAt;
  return ctx;
}

/**
 * spec §7.4: needsProfile な config は URL で絞った部分集合を DO に渡し 1 往復で評価する。
 * Experiment にも patterns にも一致しなければ DO に触れず空応答(③)。DO の例外は null(呼び出し側が 503)。
 * config null(未知 version・未知 schemaVersion)は §9.1 のとおり空応答。needsProfile=false は従来どおりローカル評価。
 * firstVisitAt: Mode A は body の値(Mode C は参考用の匿名 Cookie の発行時刻)、D-lite は edge が Cookie の ID から読む(決定 49 §7.3)
 */
export async function evaluateDecision(
  env: Env,
  siteId: string,
  settings: SiteSettings,
  config: CompiledConfig | null,
  body: DecisionBody,
  visitorId: string,
  firstVisitAt: number | null | undefined,
  now: number = Date.now(),
): Promise<DecisionResponse | null> {
  if (!config) return { v: body.v, experiments: [] };
  const ctx = toPageContext(body, now, firstVisitAt);
  const toResponse = (results: Array<{ experimentId: string; variantId: string }>): DecisionResponse => ({
    v: config.version,
    experiments: results.map((r) => ({ id: r.experimentId, variant: r.variantId })),
  });
  if (!config.needsProfile) return toResponse(decide(config, ctx, visitorId, null));
  const experiments = experimentsForUrl(config, ctx.url);
  const matchedPatterns = patternsForUrl(config, ctx.url);
  if (experiments.length === 0 && matchedPatterns.length === 0) return toResponse([]); // §7.4 ③: DO 非接触
  try {
    const results = await profileStub(env, siteId, visitorId).decide({
      retentionDays: settings.retentionDays,
      patternKeys: Object.keys(config.patterns),
      matchedPatterns,
      experiments,
      ctx,
      visitorId,
      ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
    });
    return toResponse(results);
  } catch (e) {
    console.error("wtt: profile decide failed", e); // §7.4: 503(runtime は元表示)。無音にしない
    return null;
  }
}
