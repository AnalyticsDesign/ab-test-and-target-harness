/**
 * ドメイン一覧(site_domains の行)の型・入力のそろえ方・一覧から導く列(B148 Task 1)。純粋な関数だけで、D1 や KV には触れない。
 * 一覧が正で、`domain` / `allowed_origins_json` / `hosts_json` はここの関数で一覧から導く(手で別々に書かない)。
 */

/** ホスト名の形の検査(小文字の英数字・ドット・ハイフンだけ)。site-settings.ts の zod もこれを使う */
export const HOST_RE = /^[a-z0-9.-]+$/;

/** 1 サイトが持てるドメインの数。移行で超えたサイトも、保存のときはこの数以下を求める */
export const MAX_DOMAINS = 50;

/** edge = 当ツールの配信が届く / outside = 届かない / unknown = まだ確かめていない・確かめられなかった / dev = 開発用(判定しない) */
export type DomainVerdict = "edge" | "outside" | "unknown" | "dev";

/** 一覧の 1 行。`checkedAt` は秒で、`dev` と判定していない行は null。`triedAt` は最後に確かめに行った時刻(結果が unknown でも進む) */
export type DomainRow = { value: string; verdict: DomainVerdict; checkedAt: number | null; triedAt: number | null };

export type DomainInputError = "path" | "wildcard" | "not_domain";

type NormalizeResult = { ok: true; value: string; dev: boolean } | { ok: false; reason: DomainInputError };

/** new URL(v).origin が v と一致するか(@wtt/core の設定の検査と同じ条件) */
function isCanonicalOrigin(v: string): boolean {
  try {
    return new URL(v).origin === v;
  } catch {
    return false;
  }
}

/**
 * 入力 1 行をそろえる。通常の行はホスト名(`www.example.com`)、開発用の行は Origin(`http://localhost:8080`)で持つ。
 * - 前後の空白・大文字・`https://`・末尾の `/` と `.` を落とす
 * - `http://` か明示の port がある行は開発用(Origin の形のまま持つ。scheme が無い port 付きは https 扱い)。既定のポート(https の 443・http の 80)は落とす
 *   (`https://www.example.com:443` は通常の行 `www.example.com`、`http://localhost:80` は開発用の `http://localhost`)
 * - localhost・IP も、Origin で書いたとき(http / port 付き)だけ開発用。素のホスト名は通常の行
 * - path・query・fragment は `path`、`*` は `wildcard`、HOST_RE に合わない(非 ASCII 含む)ものは `not_domain`
 */
export function normalizeDomainInput(raw: string): NormalizeResult {
  const s = raw.trim().toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):\/\//.exec(s);
  const scheme = m ? m[1] : null;
  if (scheme !== null && scheme !== "http" && scheme !== "https") return { ok: false, reason: "not_domain" };
  const rest = (m ? s.slice(m[0].length) : s).replace(/\/+$/, "");
  if (rest.includes("*")) return { ok: false, reason: "wildcard" };
  if (/[/?#]/.test(rest)) return { ok: false, reason: "path" };

  // port は最後の `:` の後ろ。数字 1〜65535 だけを受ける(IPv6 の `[::1]` などは HOST_RE で落ちる)
  let host = rest;
  let port: number | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    const p = rest.slice(colon + 1);
    if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) return { ok: false, reason: "not_domain" };
    host = rest.slice(0, colon);
    port = Number(p);
  }
  host = host.replace(/\.+$/, "");
  // 空のラベル(`.example.com` / `a..b`)も落とす
  if (host === "" || !HOST_RE.test(host) || host.split(".").some((label) => label === "")) return { ok: false, reason: "not_domain" };

  // 既定のポート(https の 443・http の 80)は落とす。Origin の正規形(new URL(v).origin)に合わせ、`https://h:443` は通常の行になる
  if (port === (scheme === "http" ? 80 : 443)) port = null;
  const origin = `${scheme ?? "https"}://${host}${port === null ? "" : `:${port}`}`;
  // 行は Origin にして allowedOrigins に入る。URL が別の形に書き直すホスト(`0x7f.1` → `127.0.0.1` など)は受けない
  if (!isCanonicalOrigin(origin)) return { ok: false, reason: "not_domain" };
  if (scheme !== "http" && port === null) return { ok: true, value: host, dev: false };
  return { ok: true, value: origin, dev: true };
}

type DomainListError = { index: number | null; reason: DomainInputError | "duplicate" | "empty" | "too_many" };

/**
 * 保存する一覧の入力を検査してそろえる。1 件以上 MAX_DOMAINS 件以下。重複はそろえた後の値で判定する
 * (scheme・port だけ違う行は別の値なので重複にしない)。行ごとの誤りは全部返し、重複は 2 つ目以降の行を指す
 */
export function checkDomainList(raws: string[]): { rows: { value: string; dev: boolean }[] } | { errors: DomainListError[] } {
  if (raws.length === 0) return { errors: [{ index: null, reason: "empty" }] };
  if (raws.length > MAX_DOMAINS) return { errors: [{ index: null, reason: "too_many" }] };
  const rows: { value: string; dev: boolean }[] = [];
  const errors: DomainListError[] = [];
  const seen = new Set<string>();
  raws.forEach((raw, index) => {
    const r = normalizeDomainInput(raw);
    if (!r.ok) {
      errors.push({ index, reason: r.reason });
      return;
    }
    if (seen.has(r.value)) {
      errors.push({ index, reason: "duplicate" });
      return;
    }
    seen.add(r.value);
    rows.push({ value: r.value, dev: r.dev });
  });
  return errors.length > 0 ? { errors } : { rows };
}

/** 行のホスト名。開発用の行は Origin から取り出す(今の `domain` 列は Origin の形を持たない) */
const hostOf = (row: DomainRow): string => (row.verdict === "dev" ? new URL(row.value).hostname : row.value);

/** 行の Origin。開発用の行は値が既に Origin、それ以外は https */
const originOf = (row: DomainRow): string => (row.verdict === "dev" ? row.value : `https://${row.value}`);

/**
 * 一覧から 3 つの列を導く。
 * - `allowedOrigins`: 全行を Origin にして一覧の順に並べる
 * - `domain`: 先頭行のホスト名(一覧は 1 件以上だが、空なら空文字)
 * - `hosts`: Mode B は edge と判定した行だけ。Mode A は hosts を持たないので空
 */
export function deriveDomainColumns(rows: DomainRow[], mode: "A" | "B"): { domain: string; allowedOrigins: string[]; hosts: string[] } {
  return {
    domain: rows.length > 0 ? hostOf(rows[0]!) : "",
    allowedOrigins: rows.map(originOf),
    hosts: mode === "B" ? rows.filter((r) => r.verdict === "edge").map((r) => r.value) : [],
  };
}

/** 画面用の 3 グループ。Mode A は判定しないので全部空。開発用の行はどこにも入れない。unchecked は verdict が unknown の行 */
export function domainGroups(rows: DomainRow[], mode: "A" | "B"): { edge: string[]; outside: string[]; unchecked: string[] } {
  const pick = (v: DomainVerdict): string[] => (mode === "B" ? rows.filter((r) => r.verdict === v).map((r) => r.value) : []);
  return { edge: pick("edge"), outside: pick("outside"), unchecked: pick("unknown") };
}
