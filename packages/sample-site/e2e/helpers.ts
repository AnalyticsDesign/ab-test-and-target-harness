import type { BrowserContext } from "@playwright/test";
import { bucketOf, uuidToVisitorId } from "@wtt/core"; // 相対 import ではなく workspace 依存(Plan 1 レビュー繰越の正規化)

/** 指定 Experiment の 50/50 で指定の半分に入る canonical ID を探す(vA = bucket < 5000) */
export function findVisitor(experimentId: string, half: "A" | "B"): string {
  for (let i = 0; i < 5000; i++) {
    const id = uuidToVisitorId(`00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`)!;
    const b = bucketOf(id, experimentId);
    if (half === "A" ? b < 5000 : b >= 5000) return id;
  }
  throw new Error("visitor not found");
}

/** Mode A: 既存 Cookie を事前設定して割当を決定論にする(runtime は canonical な既存値を必ず再利用する) */
export async function presetVisitor(context: BrowserContext, id: string, opts: { httpOnly?: boolean } = {}): Promise<void> {
  await context.addCookies([{ name: "_ab_vid", value: id, domain: "localhost", path: "/", httpOnly: opts.httpOnly ?? false }]);
}

export async function readDataLayer(page: import("@playwright/test").Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => ((window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer ?? []));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** data-layer-helper の merge と同じ規則: push 側が plain object なら再帰マージ、それ以外(null / 配列 / スカラー)は置換 */
function mergeInto(to: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(from)) {
    if (isPlainObject(v)) {
      if (!isPlainObject(to[k])) to[k] = {};
      mergeInto(to[k] as Record<string, unknown>, v);
    } else {
      to[k] = v;
    }
  }
}

/**
 * spec §10.9「テスト」: 生の push 列ではなく **マージ後のモデル** に対して検証するためのヘルパー。
 * dataLayer の配列を先頭から畳み込み、各 push 適用直後のモデルのスナップショットを返す(push の順序や回数を固定しない)
 */
export function foldDataLayer(pushes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const model: Record<string, unknown> = {};
  return pushes.map((p) => {
    mergeInto(model, p);
    return structuredClone(model);
  });
}
