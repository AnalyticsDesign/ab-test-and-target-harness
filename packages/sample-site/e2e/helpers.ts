import type { BrowserContext } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bucketOf, uuidToVisitorId } from "@wtt/core"; // 相対 import ではなく workspace 依存(Plan 1 レビュー繰越の正規化)
import { E2E_RESULTS_VISITOR_KEY, RESULTS_EDGE_PERSIST } from "./results-key";

/** 指定 Experiment の 50/50 で指定の半分に入る canonical ID を探す(vA = bucket < 5000) */
export function findVisitor(experimentId: string, half: "A" | "B"): string {
  for (let i = 0; i < 5000; i++) {
    const id = uuidToVisitorId(`00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`)!;
    const b = bucketOf(id, experimentId);
    if (half === "A" ? b < 5000 : b >= 5000) return id;
  }
  throw new Error("visitor not found");
}

/**
 * findVisitor と同じ半分に入る、実行ごとに新しい canonical ID。計測用 D1 はローカルの状態が実行をまたいで残るので、
 * 結果の E2E は毎回新しい訪問者で行を作る(前の実行の行と混ぜない。D9 ② K25)
 */
export function freshVisitor(experimentId: string, half: "A" | "B"): string {
  for (let i = 0; i < 5000; i++) {
    const id = uuidToVisitorId(randomUUID())!;
    const b = bucketOf(id, experimentId);
    if (half === "A" ? b < 5000 : b >= 5000) return id;
  }
  throw new Error("visitor not found");
}

/** Mode A: 既存 Cookie を事前設定して割当を決定論にする(runtime は canonical な既存値を必ず再利用する)。name は Site の visitorCookieName(既定 _ab_vid) */
export async function presetVisitor(context: BrowserContext, id: string, opts: { httpOnly?: boolean; name?: string } = {}): Promise<void> {
  await context.addCookies([{ name: opts.name ?? "_ab_vid", value: id, domain: "localhost", path: "/", httpOnly: opts.httpOnly ?? false }]);
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

const EDGE_DIR = fileURLToPath(new URL("../../../apps/edge/", import.meta.url));
const execFileAsync = promisify(execFile);

/**
 * 計測用 D1(ローカルの wtt-results)に SQL を流し、結果の行を返す(D9 ② K25)。`wrangler d1 execute --local --json` を
 * edge のディレクトリで動かす。既定で読むのは結果の E2E 用の edge の状態の置き場(results-key.ts)。
 * 1 回に 1〜2 秒かかるので expect.poll には使わない(応答を待ってから 1 回読む)
 */
export async function queryResults(sql: string, persistTo: string = RESULTS_EDGE_PERSIST): Promise<unknown[]> {
  const args = ["d1", "execute", "wtt-results", "--local", "--json", "--command", sql, "--persist-to", persistTo];
  const { stdout } = await execFileAsync(join(EDGE_DIR, "node_modules/.bin/wrangler"), args, { cwd: EDGE_DIR, maxBuffer: 16 * 1024 * 1024 });
  const out = JSON.parse(stdout) as Array<{ results?: unknown[] }>;
  return out[0]?.results ?? [];
}

/**
 * edge が D1 に書く visitor_key(HMAC-SHA-256(鍵, siteId + ":" + visitorId) の先頭 16 バイト)を、E2E の鍵で計算した SQL の BLOB リテラル。
 * D1 の行をその訪問者だけに絞るのに使う(D1 には訪問者 ID そのものが無い)
 */
export function visitorKeySql(siteId: string, visitorId: string): string {
  const mac = createHmac("sha256", Buffer.from(E2E_RESULTS_VISITOR_KEY, "base64")).update(`${siteId}:${visitorId}`).digest();
  return `X'${mac.subarray(0, 16).toString("hex")}'`;
}
