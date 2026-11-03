import { kvKeys } from "@wtt/core";
import { MAX_DOMAINS, type DomainRow, type DomainVerdict } from "./domains";
import type { Env } from "./env";
import { INSTANCE_SETTING_DEFAULTS, type CloudflarePlan } from "./instance-settings";
import { NOT_FROZEN_SQL } from "./write-freeze";

/**
 * B148 Task 3: タグのドメインごとに `https://<domain>/__ab/ping` へ GET し、この導入の edge に届くか(edge)、届かないか(outside)、
 * 確かめられなかったか(unknown)を決める。edge の応答は apps/edge/src/check.ts(KV の `meta:install` の SHA-256 を返す)。
 * Workers Free では外部への fetch が 1 要求 50 本まで(KV・D1 は別の枠)なので、Free は 1 回の保存で FREE_PROBE_LIMIT 行まで。
 */

/** 1 本の打ち切り(ms)。時計は送り出したときから(待ち行列で待った時間は数えない) */
export const PROBE_TIMEOUT_MS = 3000;
/** Free で 1 回の保存で確かめる行の上限(外部 50 本の枠に収める) */
export const FREE_PROBE_LIMIT = 40;
/** 同時に応答を待つ本数(Workers の同時接続の上限 6 に合わせる) */
export const PROBE_CONCURRENCY = 6;
/** 確認の全体の打ち切り(ms)。終わらなかった行は deferred */
export const PROBE_TOTAL_MS = 12000;
/** 本文を読む上限(バイト)。edge の応答は 100 バイトほど */
const BODY_LIMIT = 1024;
/** 導入の印の正本の置き場所(D1 の instance_settings のキー。値は JSON の文字列) */
export const INSTALL_MARKER_KEY = "install_marker";

/**
 * E2E だけの宛先の上書き(`AB_PROBE_ORIGIN_OVERRIDE`)を受ける値の形。手元のポートだけ(本番の設定には置かない。wrangler.jsonc に無いことはテストが見る)
 */
const PROBE_OVERRIDE_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

/**
 * 環境変数から宛先の上書きを取り出す。`AB_E2E_PROBE_OVERRIDE_ENABLED` が "1" のときだけ `AB_PROBE_ORIGIN_OVERRIDE` を返す
 * (2 つの変数がそろわないと効かない。本番の設定に片方だけ紛れても、実在のドメインの確かめを手元へ向けない)。
 * 2 つとも admin の E2E(playwright.config.ts の --var)だけが置く
 */
export function probeOverrideFromEnv(env: Pick<Env, "AB_PROBE_ORIGIN_OVERRIDE" | "AB_E2E_PROBE_OVERRIDE_ENABLED">): string | undefined {
  const override = env.AB_PROBE_ORIGIN_OVERRIDE;
  if (override === undefined || override === "") return undefined;
  if (env.AB_E2E_PROBE_OVERRIDE_ENABLED === "1") return override;
  console.error("AB_PROBE_ORIGIN_OVERRIDE ignored (AB_E2E_PROBE_OVERRIDE_ENABLED is not set)");
  return undefined;
}

/**
 * 確かめに送る URL。ふつうは `https://<domain>/__ab/ping`。override(E2E の偽の edge)は、値が `http://127.0.0.1:<port>` か
 * `http://localhost:<port>` で、かつ domain が `.test` で終わるときだけ `<override>/__ab/ping?host=<domain>` にする。
 * それ以外の override は使わずにログに残す(本番で誤って置かれても、実在のドメインの判定を手元へ向けない)
 */
export function probeUrl(domain: string, override?: string): string {
  if (override !== undefined && override !== "") {
    if (PROBE_OVERRIDE_RE.test(override) && domain.endsWith(".test")) return `${override}/__ab/ping?host=${encodeURIComponent(domain)}`;
    console.error("AB_PROBE_ORIGIN_OVERRIDE ignored (only http://127.0.0.1:<port> or http://localhost:<port>, and only for .test domains)", { override, domain });
  }
  return `https://${domain}/__ab/ping`;
}

export type ProbeOutcome = "edge" | "outside" | "unknown";
export type ProbeResult = { domain: string; outcome: ProbeOutcome | "deferred" };

/**
 * 確かめる行を選ぶ。dev の行は選ばない(どちらにも入れない)。triedAt の古い順(null が先、同じなら一覧の順)に、
 * Free は FREE_PROBE_LIMIT 行・Paid は MAX_DOMAINS 行まで(移行で上限を超えた一覧も 1 回の保存ではここまで)。
 * probe は送る順(古い順)で返す。一覧の順で送ると、先頭の応答しない行が全体の打ち切りを毎回使い切り、後ろの行がいつまでも
 * 確かめられない(deferred は triedAt を進めないので、次の保存では先に送られる)
 */
export function pickRowsToProbe(rows: DomainRow[], plan: CloudflarePlan): { probe: string[]; deferred: string[] } {
  const limit = plan === "paid" ? MAX_DOMAINS : FREE_PROBE_LIMIT;
  const oldestFirst = rows
    .map((row, index) => ({ row, index }))
    .filter((t) => t.row.verdict !== "dev")
    .sort((a, b) => {
      const ta = a.row.triedAt;
      const tb = b.row.triedAt;
      if (ta !== tb) {
        if (ta === null) return -1;
        if (tb === null) return 1;
        return ta - tb;
      }
      return a.index - b.index;
    });
  return {
    probe: oldestFirst.slice(0, limit).map((t) => t.row.value),
    deferred: oldestFirst.slice(limit).map((t) => t.row.value),
  };
}

const ABORTED = Symbol("aborted");

/** promise と signal の早い方。signal が先なら ABORTED(fetchFn が signal を無視しても打ち切れるように、自分で競わせる) */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    p.catch(() => {}); // 後で落ちても未処理の reject にしない
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** 本文を BODY_LIMIT バイトまで読む。打ち切られたら ABORTED */
async function readLimited(res: Response, signal: AbortSignal): Promise<string | typeof ABORTED> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < BODY_LIMIT) {
      const r = await raceAbort(reader.read(), signal);
      if (r === ABORTED) return ABORTED;
      if (r.done) break;
      chunks.push(r.value);
      size += r.value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {}); // 残りは読まない(待たない)
  }
  const buf = new Uint8Array(Math.min(size, BODY_LIMIT));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, buf.length - at);
    buf.set(part, at);
    at += part.length;
    if (at >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

/** 応答の状態コードだけで決まるもの。200 は本文を見る(null) */
function outcomeOfStatus(status: number): ProbeOutcome | null {
  if (status === 403 || status === 429 || status >= 500) return "unknown"; // WAF の Block・レート制限・edge の 503(印が見えない)
  if (status === 200) return null;
  return "outside"; // 3xx(追わない)・404・ほかの 2xx / 4xx
}

/**
 * 1 つのドメインを確かめる。`stop`(全体の打ち切り)で止まったときも unknown を返す(呼び出し側が deferred に読み替える)。
 * 通信の失敗・打ち切りは unknown。本文が JSON として読めなければ outside
 */
export async function probeDomain(domain: string, installHash: string, fetchFn: typeof fetch, stop?: AbortSignal, originOverride?: string): Promise<ProbeOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const onStop = () => ctrl.abort();
  if (stop?.aborted) ctrl.abort();
  stop?.addEventListener("abort", onStop, { once: true });
  try {
    const res = await raceAbort(fetchFn(probeUrl(domain, originOverride), { method: "GET", redirect: "manual", signal: ctrl.signal }), ctrl.signal);
    if (res === ABORTED) return "unknown";
    const byStatus = outcomeOfStatus(res.status);
    if (byStatus !== null) {
      res.body?.cancel().catch(() => {});
      return byStatus;
    }
    const text = await readLimited(res, ctrl.signal);
    if (text === ABORTED) return "unknown";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return "outside"; // 別のサーバーの応答(HTML など)・1 KB を超えて切れた本文
    }
    const b = body as { edge?: unknown; install?: unknown } | null;
    return b !== null && typeof b === "object" && b.edge === "wtt" && b.install === installHash ? "edge" : "outside";
  } catch {
    return "unknown"; // 通信の失敗(DNS・TLS・接続の切断など)
  } finally {
    clearTimeout(timer);
    stop?.removeEventListener("abort", onStop);
  }
}

/**
 * 一覧の行をまとめて確かめ、生の結果を一覧の順(dev の行を除く)で返す。行は作らない(mergeProbeResults が当てる)。
 * pickRowsToProbe の順(triedAt の古い順)に PROBE_CONCURRENCY 本ずつの待ち行列で送り、全体が PROBE_TOTAL_MS を超えたら、送っていない行と終わっていない行は deferred。
 * installHash が null(導入の印がまだ無い・移行の前の導入)なら、送らずに全部 unknown(誤って outside にしない)
 */
export async function probeDomains(
  rows: DomainRow[],
  opts: { plan: CloudflarePlan; installHash: string | null; fetchFn?: typeof fetch; originOverride?: string },
): Promise<ProbeResult[]> {
  const { probe, deferred } = pickRowsToProbe(rows, opts.plan);
  const out = new Map<string, ProbeResult["outcome"]>(deferred.map((d) => [d, "deferred"]));
  const hash = opts.installHash;
  if (hash === null) {
    for (const d of probe) out.set(d, "unknown");
  } else if (probe.length > 0) {
    // 既定は呼び出した時点の global fetch(テストの偽の edge が差し替えられるように、ここで読む)
    const fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    const stop = new AbortController();
    const totalTimer = setTimeout(() => stop.abort(), PROBE_TOTAL_MS);
    let next = 0;
    const worker = async () => {
      while (!stop.signal.aborted && next < probe.length) {
        const domain = probe[next++]!;
        const outcome = await probeDomain(domain, hash, fetchFn, stop.signal, opts.originOverride);
        if (!stop.signal.aborted) out.set(domain, outcome);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, probe.length) }, worker));
    } finally {
      clearTimeout(totalTimer);
    }
  }
  return rows.filter((r) => r.verdict !== "dev").map((r) => ({ domain: r.value, outcome: out.get(r.value) ?? "deferred" }));
}

/**
 * 判定の結果を、判定の後に読み直した行(latest)に当てる。edge・outside は判定・checkedAt・triedAt を書き、
 * unknown は triedAt だけ進める(前の判定と checkedAt は保つ)。deferred と結果の無い行、dev の行は latest のまま。
 * 一覧に無くなった行の結果は捨てる。changes は latest と当てた後の行の差
 */
export function mergeProbeResults(
  latest: DomainRow[],
  results: ProbeResult[],
  nowSec: number,
): { rows: DomainRow[]; changes: { domain: string; from: DomainVerdict; to: DomainVerdict }[]; deferred: string[]; unknown: string[] } {
  const byDomain = new Map(results.map((r) => [r.domain, r.outcome]));
  const changes: { domain: string; from: DomainVerdict; to: DomainVerdict }[] = [];
  const deferred: string[] = [];
  const unknown: string[] = [];
  const rows = latest.map((row): DomainRow => {
    const outcome = byDomain.get(row.value);
    if (outcome === undefined || row.verdict === "dev") return row;
    if (outcome === "deferred") {
      deferred.push(row.value);
      return row;
    }
    if (outcome === "unknown") {
      unknown.push(row.value);
      return { ...row, triedAt: nowSec };
    }
    if (outcome !== row.verdict) changes.push({ domain: row.value, from: row.verdict, to: outcome });
    return { ...row, verdict: outcome, checkedAt: nowSec, triedAt: nowSec };
  });
  return { rows, changes, deferred, unknown };
}

/** instance_settings の値(JSON の文字列)を印として読む。空・読めない値は null */
function parseMarker(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const v: unknown = JSON.parse(value);
    return typeof v === "string" && v !== "" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 判定に要る導入全体の設定(プランと D1 の導入の印)を、instance_settings の 1 回の SELECT で読む。
 * プランが無い・読めないときは既定(instance-settings.ts の INSTANCE_SETTING_DEFAULTS)
 */
export async function readProbeSettings(db: D1Database): Promise<{ plan: CloudflarePlan; installMarker: string | null }> {
  const rows = (
    await db.prepare("SELECT key, value FROM instance_settings WHERE key IN (?1, ?2)").bind("cloudflarePlan", INSTALL_MARKER_KEY).all<{ key: string; value: string }>()
  ).results;
  let plan = INSTANCE_SETTING_DEFAULTS.cloudflarePlan;
  let installMarker: string | null = null;
  for (const row of rows) {
    if (row.key === INSTALL_MARKER_KEY) installMarker = parseMarker(row.value);
    else {
      try {
        const v: unknown = JSON.parse(row.value);
        if (v === "free" || v === "paid") plan = v;
      } catch {
        // 読めない値は既定のまま
      }
    }
  }
  return { plan, installMarker };
}

/**
 * 導入の印を確かめ、無ければ作る。正本は D1(instance_settings の install_marker)、KV の `meta:install` は edge が読む写し。
 * (1) `read`(readProbeSettings が読んだ D1 の印)があればそれを使い、D1 には触れない
 * (2) 無ければ KV の今の値(B139 の移行が書いたもの)か、それも無く移行待ちのサイトが無ければ新しい UUID を INSERT OR IGNORE で入れ、
 *     読み直した値を使う(同時に呼ばれても全員が同じ値になる)。移行待ちがあれば作らず null。凍結中は書かず null
 * (3) KV が D1 の値と違えば D1 の値を put する
 * 戻り値が null のときは判定をすべて unknown にする。KV を別の値から書き換えた呼び出しも null(edge はしばらく前の値を返しうるので、
 * 不一致を outside と読まない)。KV が読めない・書けないときも null(ログに残す。次の呼び出しで直す)。
 * D1 の往復: (1) 0 回 / (2) KV に値あり 2 回(INSERT・読み直し)、どちらにも無い 3 回(移行待ちの確かめ・INSERT・読み直し)。KV は get 1 + 違えば put 1
 */
export async function ensureInstallMarker(env: Env, db: D1Database, read: string | null): Promise<string | null> {
  let kvValue: string | null;
  try {
    kvValue = await env.CONFIG_KV.get(kvKeys.installMarker);
  } catch (e) {
    console.error("install marker: KV read failed", e);
    return null;
  }
  if (kvValue === "") kvValue = null;
  let marker = read;
  if (marker === null) {
    let candidate = kvValue;
    if (candidate === null) {
      // 移行の途中で印を作ると、移行が終わる前に edge が答え始める。移行(Cron の finishMigration)が終わってから作る
      if ((await db.prepare("SELECT 1 AS x FROM sites WHERE share_migration_pending = 1 LIMIT 1").first()) !== null) return null;
      candidate = crypto.randomUUID();
    }
    await db
      .prepare(`INSERT OR IGNORE INTO instance_settings (key, value, updated_at, updated_by) SELECT ?1, ?2, ?3, NULL WHERE ${NOT_FROZEN_SQL}`)
      .bind(INSTALL_MARKER_KEY, JSON.stringify(candidate), Date.now())
      .run();
    marker = parseMarker((await db.prepare("SELECT value FROM instance_settings WHERE key = ?1").bind(INSTALL_MARKER_KEY).first<{ value: string }>())?.value);
    if (marker === null) return null; // 凍結中で書けなかった
  }
  if (kvValue === marker) return marker;
  try {
    await env.CONFIG_KV.put(kvKeys.installMarker, marker);
  } catch (e) {
    console.error("install marker: KV write failed", e);
    return null;
  }
  // KV が空だった: edge は見えるまで 503 を返すので unknown になる(印は返す)。別の値だった: edge が前の値で答えうるので null
  return kvValue === null ? marker : null;
}

/** 印の SHA-256(小文字の 16 進)。edge の check.ts の sha256Hex と同じ計算。null なら null */
export async function installHashOf(marker: string | null): Promise<string | null> {
  if (marker === null) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(marker));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
