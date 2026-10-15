// apps/control/src/usage/fetch.ts
import type { Env } from "../env";
import { ApiError } from "../errors";
import type { Measured, RawUsage } from "./judge";
import { RESOURCE_IDS } from "./limits";

/**
 * backlog D10(brief K9・plan K20〜K23): Cloudflare GraphQL Analytics API から当日の使用量を 1 回の要求で取る。
 * アカウント全体は合計だけ、内訳は本製品の Worker / DB / KV だけ(同じアカウントの他のプロジェクトの名前を出さない)。
 * データセットとフィールドは 2026-10-05 の introspection と実データで確認した(検討記録 9.1)
 */
export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
/** K29: 1 つの照会で返る行の上限(maxPageSize。2026-10-06 の実測)。これに達した照会は切り詰められたとみなす */
export const GRAPHQL_LIMIT = 10_000;
const DAY_MS = 86_400_000;
const DEFAULT_WORKERS = ["wtt-edge", "wtt-control", "wtt-admin"];

export type UsageConfig = { accountId: string; token: string; workers: string[]; d1: Array<{ id: string; name: string }>; kv: Array<{ id: string; name: string }> };

const isNamed = (v: unknown): v is { id: string; name: string } =>
  typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string" && typeof (v as { name?: unknown }).name === "string";

/** 壊れた AB_USAGE_RESOURCES の警告は isolate で 1 回だけ出す(要求のたびにログを埋めない) */
let warnedResources = false;

/**
 * AB_USAGE_RESOURCES は wrangler.jsonc からは object、`--var` や .dev.vars からは JSON の文字列で来る。
 * 無ければ既定(Worker 名だけ)。読めない・object でないときも既定に倒し、警告を出す(取得は止めない。合計は出る)
 */
function readResources(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  let r: unknown = v;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      r = null;
    }
  }
  if (typeof r === "object" && r !== null && !Array.isArray(r)) return r as Record<string, unknown>;
  if (!warnedResources) {
    warnedResources = true;
    console.warn("AB_USAGE_RESOURCES is not a JSON object; using the default product workers only");
  }
  return {};
}

export function usageConfig(env: Env): UsageConfig | null {
  const token = env.CF_USAGE_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim().toLowerCase();
  if (!token || !accountId || !/^[0-9a-f]{32}$/.test(accountId)) return null;
  const r = readResources(env.AB_USAGE_RESOURCES);
  const workers = Array.isArray(r.workers) && r.workers.every((w) => typeof w === "string") && r.workers.length > 0 ? (r.workers as string[]) : DEFAULT_WORKERS;
  const d1 = Array.isArray(r.d1) ? r.d1.filter(isNamed) : [];
  const kv = Array.isArray(r.kv) ? r.kv.filter(isNamed) : [];
  return { accountId, token, workers, d1, kv };
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const range = (from: number, to: number) => `date_geq: "${ymd(from)}", date_leq: "${ymd(to)}"`;

/** 値はすべて検証済み(アカウント ID は 32 桁の 16 進、日付は自前で作る)なので、変数を使わず埋め込む */
export function buildUsageQuery(accountId: string, now: number): string {
  const today = range(now, now);
  const twoDays = range(now - DAY_MS, now);
  const month = range(now - 30 * DAY_MS, now);
  return `{ viewer { accounts(filter: { accountTag: "${accountId}" }) {
  workers: workersInvocationsAdaptive(limit: ${GRAPHQL_LIMIT}, filter: { ${today} }) { dimensions { scriptName } sum { requests } }
  doRequests: durableObjectsInvocationsAdaptiveGroups(limit: ${GRAPHQL_LIMIT}, filter: { ${today} }) { dimensions { scriptName namespaceId } sum { requests } }
  doNamespaces: durableObjectsInvocationsAdaptiveGroups(limit: ${GRAPHQL_LIMIT}, filter: { ${month} }) { dimensions { scriptName namespaceId } }
  doRows: durableObjectsPeriodicGroups(limit: ${GRAPHQL_LIMIT}, filter: { ${today} }) { dimensions { namespaceId } sum { rowsRead rowsWritten } }
  doStorage: durableObjectsSqlStorageGroups(limit: ${GRAPHQL_LIMIT}, filter: { ${twoDays} }) { dimensions { namespaceId } max { storedBytes } }
  d1: d1AnalyticsAdaptiveGroups(limit: ${GRAPHQL_LIMIT}, filter: { ${today} }) { dimensions { databaseId } sum { rowsRead rowsWritten } }
  d1Storage: d1StorageAdaptiveGroups(limit: ${GRAPHQL_LIMIT}, filter: { ${twoDays} }) { dimensions { databaseId } max { databaseSizeBytes } }
  kv: kvOperationsAdaptiveGroups(limit: ${GRAPHQL_LIMIT}, filter: { ${today} }) { dimensions { namespaceId actionType } sum { requests } }
  kvStorage: kvStorageAdaptiveGroups(limit: ${GRAPHQL_LIMIT}, filter: { ${twoDays} }) { dimensions { namespaceId } max { byteCount } }
} } }`;
}

const upstream = (detail: string) =>
  new ApiError(503, "usage_upstream_failed", { hint: "時間をおいて開き直してください。続く場合は API トークンの権限(Account Analytics: Read)とアカウント ID を確認してください", detail });

/** K21: Cloudflare の ID はデータセットによってハイフンの有無が違う */
const norm = (id: unknown) => (typeof id === "string" ? id.replace(/-/g, "").toLowerCase() : "");
type Row = { dimensions?: Record<string, unknown>; sum?: Record<string, unknown>; max?: Record<string, unknown> };
/**
 * K23: 行の値は有限かつ 0 以上の数でなければ上流の失敗にする(欠けた値・文字列・負の値を 0 として足すと「問題なし」と読み違える)
 */
const num = (v: unknown, what: string): number => {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  throw upstream(`bad number: ${what}=${JSON.stringify(v) ?? "undefined"}`);
};

/** 合計(全行)と、本製品の名前ごとの内訳。nameOf が null を返す行は合計にだけ入る */
function measure(rows: Row[], value: (r: Row) => number, nameOf: (r: Row) => string | null): Measured {
  let used = 0;
  const by = new Map<string, number>();
  for (const r of rows) {
    const v = value(r);
    used += v;
    const name = nameOf(r);
    if (name !== null) by.set(name, (by.get(name) ?? 0) + v);
  }
  return { used, breakdown: [...by].filter(([, v]) => v > 0).map(([name, v]) => ({ name, used: v })) };
}

/** 保存量: ID ごとの最大(前日と当日の範囲)を合計する(K22) */
function storage(rows: Row[], idKey: string, field: string, nameOf: (id: string) => string | null): Measured {
  const maxById = new Map<string, number>();
  for (const r of rows) {
    const id = norm(r.dimensions?.[idKey]);
    maxById.set(id, Math.max(maxById.get(id) ?? 0, num(r.max?.[field], field)));
  }
  return measure([...maxById].map(([id, v]) => ({ dimensions: { id }, sum: { v } })), (r) => num(r.sum?.v, field), (r) => nameOf(String(r.dimensions?.id)));
}

const DATASETS = ["workers", "doRequests", "doNamespaces", "doRows", "doStorage", "d1", "d1Storage", "kv", "kvStorage"] as const;

/**
 * K23: 各データセットの行が持つべき値(sum / max の各フィールド)と、合計に要る dimension。分類の前に全行を検証する。
 * workers の scriptName・d1 の databaseId・kv の namespaceId は内訳にだけ使う(合計には不要)ので必須にしない(欠けても内訳に入らないだけ)
 */
const SHAPE: Record<(typeof DATASETS)[number], { values: Array<["sum" | "max", string]>; dims: string[] }> = {
  workers: { values: [["sum", "requests"]], dims: [] },
  doRequests: { values: [["sum", "requests"]], dims: ["namespaceId"] },
  doNamespaces: { values: [], dims: ["namespaceId"] },
  doRows: { values: [["sum", "rowsRead"], ["sum", "rowsWritten"]], dims: ["namespaceId"] },
  doStorage: { values: [["max", "storedBytes"]], dims: ["namespaceId"] },
  d1: { values: [["sum", "rowsRead"], ["sum", "rowsWritten"]], dims: [] },
  d1Storage: { values: [["max", "databaseSizeBytes"]], dims: ["databaseId"] },
  kv: { values: [["sum", "requests"]], dims: ["actionType"] },
  kvStorage: { values: [["max", "byteCount"]], dims: ["namespaceId"] },
};

export function parseUsage(body: unknown, cfg: UsageConfig): RawUsage {
  const b = body as { data?: { viewer?: { accounts?: unknown[] } } | null; errors?: unknown[] | null } | null;
  if (b?.errors && b.errors.length > 0) throw upstream(`graphql errors: ${JSON.stringify(b.errors).slice(0, 500)}`);
  const acc = b?.data?.viewer?.accounts?.[0] as Record<string, unknown> | undefined;
  if (!acc) throw upstream("no account in the response");
  for (const k of DATASETS) {
    const a = acc[k];
    if (!Array.isArray(a)) throw upstream(`dataset missing: ${k}`);
    // K29: 行数が上限に達した照会は切り詰められている(合計が少なく出る)
    if (a.length >= GRAPHQL_LIMIT) throw upstream(`truncated: ${k}`);
    // K23: 行が object でない(null など)のも上流の失敗
    if (a.some((r) => typeof r !== "object" || r === null)) throw upstream(`bad row: ${k}`);
  }
  const rows = (k: (typeof DATASETS)[number]) => acc[k] as Row[];
  // K23: 分類の前に、全データセットの全行の値と、合計に要る dimension を検証する
  for (const k of DATASETS) {
    for (const r of rows(k)) {
      for (const [part, field] of SHAPE[k].values) num(r[part]?.[field], `${k}.${field}`);
      for (const d of SHAPE[k].dims) {
        const v = r.dimensions?.[d];
        if (typeof v !== "string" || v === "") throw upstream(`missing dimension: ${k}.${d}`);
      }
    }
  }

  const workers = new Set(cfg.workers);
  // K20: 本製品の Worker が呼んだ DO の namespace(過去 30 日)→ その Worker の名前
  const doName = new Map<string, string>();
  for (const r of [...rows("doNamespaces"), ...rows("doRequests")]) {
    const script = r.dimensions?.scriptName;
    if (typeof script === "string" && workers.has(script)) doName.set(norm(r.dimensions?.namespaceId), script);
  }
  const d1Name = new Map(cfg.d1.map((d) => [norm(d.id), d.name]));
  const kvName = new Map(cfg.kv.map((k) => [norm(k.id), k.name]));
  const byScript = (r: Row) => {
    const s = r.dimensions?.scriptName;
    return typeof s === "string" && workers.has(s) ? s : null;
  };
  const byDo = (r: Row) => doName.get(norm(r.dimensions?.namespaceId)) ?? null;
  const byD1 = (r: Row) => d1Name.get(norm(r.dimensions?.databaseId)) ?? null;
  const byKv = (r: Row) => kvName.get(norm(r.dimensions?.namespaceId)) ?? null;
  // KV の操作の種別が read / write / delete / list 以外の文字列なら、どの資源にも数えない
  // (Cloudflare が種別を足しても止まらないように。上限があるのはこの 4 種別だけ)
  const kvAction = (action: "read" | "write" | "delete" | "list") => rows("kv").filter((r) => r.dimensions?.actionType === action);

  // K22: アカウント合計は全 DB。1 DB の上限は DB ごとに効くので、本製品の DB(AB_USAGE_RESOURCES.d1)の中の最大で判定し、
  // 本製品の DB ごとの大きさを内訳に出す。設定が空、または設定した ID がどの行とも一致しない(書き間違い・別の DB・まだ行が無い)なら判定しない
  // (本物の D1 が 0 バイトになることはなく、内訳は 0 の行を落とすので、内訳が空 = 一致なし。0 を「余裕あり」と誤判定しない。最終レビュー finding 3)
  const d1Storage = storage(rows("d1Storage"), "databaseId", "databaseSizeBytes", (id) => d1Name.get(id) ?? null);
  const d1Largest: Measured =
    cfg.d1.length === 0 || d1Storage.breakdown.length === 0
      ? { used: 0, breakdown: [], judged: false }
      : { used: Math.max(0, ...d1Storage.breakdown.map((d) => d.used)), breakdown: d1Storage.breakdown };

  const out: RawUsage = {
    workers_requests: measure(rows("workers"), (r) => num(r.sum?.requests, "requests"), byScript),
    do_requests: measure(rows("doRequests"), (r) => num(r.sum?.requests, "requests"), byDo),
    do_rows_read: measure(rows("doRows"), (r) => num(r.sum?.rowsRead, "rowsRead"), byDo),
    do_rows_written: measure(rows("doRows"), (r) => num(r.sum?.rowsWritten, "rowsWritten"), byDo),
    d1_rows_read: measure(rows("d1"), (r) => num(r.sum?.rowsRead, "rowsRead"), byD1),
    d1_rows_written: measure(rows("d1"), (r) => num(r.sum?.rowsWritten, "rowsWritten"), byD1),
    kv_reads: measure(kvAction("read"), (r) => num(r.sum?.requests, "requests"), byKv),
    kv_writes: measure(kvAction("write"), (r) => num(r.sum?.requests, "requests"), byKv),
    kv_deletes: measure(kvAction("delete"), (r) => num(r.sum?.requests, "requests"), byKv),
    kv_lists: measure(kvAction("list"), (r) => num(r.sum?.requests, "requests"), byKv),
    d1_storage: d1Storage,
    d1_largest_db: d1Largest,
    do_storage: storage(rows("doStorage"), "namespaceId", "storedBytes", (id) => doName.get(id) ?? null),
    kv_storage: storage(rows("kvStorage"), "namespaceId", "byteCount", (id) => kvName.get(id) ?? null),
  };
  // 表に資源を足したのに、ここで値を作り忘れたら気付けるようにする
  for (const id of RESOURCE_IDS) if (!out[id]) throw new Error(`usage: no value for ${id}`);
  return out;
}

export async function fetchRawUsage(cfg: UsageConfig, now: number, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<RawUsage> {
  const res = await fetchFn(GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: buildUsageQuery(cfg.accountId, now) }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => {
    throw upstream(`fetch failed: ${String(e)}`);
  });
  if (!res.ok) throw upstream(`http ${res.status}`);
  const body = await res.json().catch(() => {
    throw upstream("response is not json");
  });
  return parseUsage(body, cfg);
}
