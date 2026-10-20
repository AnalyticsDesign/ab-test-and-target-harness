/**
 * plan12 K8: control への service binding(wrangler.jsonc の services の `CONTROL` → wtt-control#ControlBff)を取り出す。
 * binding を読むのはこの関数だけ(lib/control.ts の controlRequest がこれだけを使い、単体テストはこの関数を差し替える)。
 *
 * 読み方は vinext の勧める `cloudflare:workers` の `env`。ただし静的な import にはしない:
 * 手元の開発の `next dev`(Turbopack)はこのモジュールを読めず、静的な import だとそれを読む画面がすべて 500 になる。
 * `turbopack.resolveAlias` で差し替える形は vinext build にも効き、本番でも binding が常に無いことになるので使わない。
 * そこで呼ばれたときに動的に読み、読めなければ null(= 公開 URL で呼ぶ。今までと同じ経路)にして 1 回だけ警告する。
 * Workers の上(vinext build の出力・wrangler dev)では読めるので、binding があれば必ずそれを返す
 */
let warned = false;

export async function controlBinding(): Promise<Fetcher | null> {
  try {
    const { env } = await import("cloudflare:workers");
    const b = env.CONTROL;
    return b && typeof b.fetch === "function" ? b : null;
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`[admin] cloudflare:workers を読めないため、control を公開 URL(AB_CONTROL_URL)で呼びます: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
}
