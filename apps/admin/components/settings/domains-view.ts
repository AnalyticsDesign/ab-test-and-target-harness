/**
 * B148: サイト設定の「ドメイン」の節の、画面に出す値を決める純粋な関数(React に依存しない。テストは test/domains-view.test.ts)。
 * 入力のそろえ方は control の apps/control/src/domains.ts の normalizeDomainInput の写し(admin は control を import しない)。
 * 規則を変えるときは両方を直す。正は control(保存の検査と、保存する値)で、ここは入力中の「保存すると … になります」のためだけに使う
 */
import type { DomainChecks, DomainRow, Site } from "@/lib/types";
import type { SectionId } from "./sections";

/** 1 サイトが持てるドメインの数(control の MAX_DOMAINS と同じ) */
export const MAX_DOMAINS = 50;

const HOST_RE = /^[a-z0-9.-]+$/;

/** new URL(v).origin が v と一致するか(@wtt/core の設定の検査と同じ条件) */
function isCanonicalOrigin(v: string): boolean {
  try {
    return new URL(v).origin === v;
  } catch {
    return false;
  }
}

/** control の normalizeDomainInput と同じ規則で 1 行をそろえる。通常の行はホスト名、開発用(http・port 付き)は Origin の形 */
export function normalizeDomain(raw: string): { ok: true; value: string; dev: boolean } | { ok: false } {
  const s = raw.trim().toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):\/\//.exec(s);
  const scheme = m ? m[1] : null;
  if (scheme !== null && scheme !== "http" && scheme !== "https") return { ok: false };
  const rest = (m ? s.slice(m[0].length) : s).replace(/\/+$/, "");
  if (rest.includes("*") || /[/?#]/.test(rest)) return { ok: false };
  let host = rest;
  let port: number | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    const p = rest.slice(colon + 1);
    if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) return { ok: false };
    host = rest.slice(0, colon);
    port = Number(p);
  }
  host = host.replace(/\.+$/, "");
  if (host === "" || !HOST_RE.test(host) || host.split(".").some((label) => label === "")) return { ok: false };
  // 既定のポート(https の 443・http の 80)は落とす。Origin の正規形(new URL(v).origin)に合わせ、`https://h:443` は通常の行になる
  if (port === (scheme === "http" ? 80 : 443)) port = null;
  const origin = `${scheme ?? "https"}://${host}${port === null ? "" : `:${port}`}`;
  // 行は Origin にして allowedOrigins に入る。URL が別の形に書き直すホスト(`0x7f.1` → `127.0.0.1` など)は受けない
  if (!isCanonicalOrigin(origin)) return { ok: false };
  if (scheme !== "http" && port === null) return { ok: true, value: host, dev: false };
  return { ok: true, value: origin, dev: true };
}

/**
 * 「保存すると www.example.com になります」に出す値。入力のままと変わらないとき・保存で断られる形のときは null
 * (断られる形の文は、保存のときに control の日本語の文を行の下に出す)
 */
export function previewNormalized(raw: string): string | null {
  const r = normalizeDomain(raw);
  if (!r.ok || r.value === raw.trim()) return null;
  return r.value;
}

/** 保存済みの一覧と比べる値(そろえられない行は入力のまま = 変更として扱い、保存で control に断らせる) */
const keyOf = (raw: string): string => {
  const r = normalizeDomain(raw);
  return r.ok ? r.value : raw.trim();
};

/** 空の行を落とす(送る前に、画面の行もこの形にそろえる。control の 422 の行の番号と画面の行を合わせるため) */
export function compactRows(rows: string[]): string[] {
  return rows.map((r) => r.trim()).filter((r) => r !== "");
}

/** 入力中の一覧が保存済みの一覧と違うか(並びも見る。1 行目が代表のため) */
export function domainsChanged(rows: string[], saved: DomainRow[]): boolean {
  const now = compactRows(rows).map(keyOf);
  return now.length !== saved.length || now.some((v, i) => v !== saved[i]!.value);
}

/** 保存済みの行を、入力の 1 行から引く(そろえた値で照合。未保存の行は null) */
export function savedRowOf(raw: string, saved: DomainRow[]): DomainRow | null {
  const k = keyOf(raw);
  return saved.find((r) => r.value === k) ?? null;
}

/**
 * 保存で domains を送るか。ドメインの節で押した保存は、変更が無くても送る(送ると control が確かめ直す)。
 * ほかの節の保存は、一覧か導入の形を変えたときだけ送る(ほかの節の保存で確かめに行かない。
 * また、移行で 50 行を超えた一覧・共有がオンで公開の接尾辞の行がある一覧のサイトでも、ほかの節の保存を止めない)
 */
export function shouldSendDomains(section: SectionId, domainsChanged: boolean, modeChanged: boolean): boolean {
  return section === "domains" || domainsChanged || modeChanged;
}

/** 前回の保存の結果で、その行をどう扱ったか(この画面で保存する前は null) */
export function checkOf(value: string, checks: DomainChecks): "probed" | "deferred" | "unknown" | null {
  if (checks === null) return null;
  if (checks.deferred.includes(value)) return "deferred";
  if (checks.unknown.includes(value)) return "unknown";
  return "probed";
}

/** 判定が Cloudflare 経由から別の値に変わった行(保存の後、節の先頭で警告する) */
export function edgeLost(checks: DomainChecks): NonNullable<DomainChecks>["changes"] {
  return checks === null ? [] : checks.changes.filter((c) => c.from === "edge" && c.to !== "edge");
}

export const LABEL_EDGE = "Cloudflare 経由(edge が応答しました)";
export const LABEL_OUTSIDE = "Cloudflare 外(edge が応答しません)";
export const LABEL_UNKNOWN = "確かめられませんでした";
export const LABEL_DEV = "開発用(確かめません)";
export const LABEL_PENDING = "保存すると確かめます";
/** Cloudflare 外の札の注記。画面ではこの後ろに Route の手順へのリンクを添える */
export const NOTE_ROUTE = "Route を足したら、もう一度保存";
export const NOTE_DEFERRED = "次の保存で確かめます";
/** 403・429・5xx も「確かめられませんでした」になる(サイトのゾーンの WAF が止めた場合を含む) */
export const NOTE_UNKNOWN = "もう一度保存すると確かめ直します。サイトのゾーンの WAF が確認を止めたかもしれません";

const PREVIOUS: Partial<Record<DomainRow["verdict"], string>> = { edge: "Cloudflare 経由", outside: "Cloudflare 外" };

/**
 * 行の右の札と、その下の小さな灰色の注記。Mode A は判定しないので札を出さない(label が空)。tone は札の色(注記は常に灰色)。
 * check = 前回の保存の結果(checkOf)。null のときは保存済みの行だけで決める:
 * 最後に確かめに行った時刻(triedAt)が判定の時刻(checkedAt)より新しい行は、確かめられずに前回の判定を保った行
 */
export function verdictLabel(
  row: DomainRow,
  mode: "A" | "B",
  check: "probed" | "deferred" | "unknown" | null,
): { label: string; note: string | null; tone: "ok" | "warn" | "gray" } {
  if (mode !== "B") return { label: "", note: null, tone: "gray" };
  if (row.verdict === "dev") return { label: LABEL_DEV, note: null, tone: "gray" };
  const deferredNote = check === "deferred" ? NOTE_DEFERRED : null;
  const keptPrevious = row.triedAt !== null && (row.checkedAt === null || row.triedAt > row.checkedAt);
  const failed = check === "unknown" || (check === null && keptPrevious);
  if (row.verdict === "unknown") {
    if (row.triedAt === null && check !== "unknown") return { label: LABEL_PENDING, note: deferredNote, tone: "gray" };
    return { label: LABEL_UNKNOWN, note: deferredNote ?? NOTE_UNKNOWN, tone: "warn" };
  }
  if (failed) return { label: `${LABEL_UNKNOWN}(前回: ${PREVIOUS[row.verdict]})`, note: NOTE_UNKNOWN, tone: "warn" };
  if (row.verdict === "edge") return { label: LABEL_EDGE, note: deferredNote, tone: "ok" };
  return { label: LABEL_OUTSIDE, note: deferredNote ?? NOTE_ROUTE, tone: "gray" };
}

/** 「この一覧から決まる値」の行の名前(文言の正。画面とテストが使う) */
export const DERIVED_LABELS = {
  rep: "代表のドメイン",
  origins: "受け付ける Origin(/v1/ の CORS)",
  edge: "Cloudflare 経由のドメイン",
  outside: "Cloudflare 外のドメイン",
  unchecked: "確かめられなかったドメイン",
  groups: "ID の共有の範囲(登録ドメインごと)",
} as const;

/**
 * 共有のカードの状態の表で、まとまり 1 つに含まれるドメインの判定(B148)。
 * 保存済みが Mode B なら判定の結果(outsideDomains / uncheckedDomains)から。保存済みがまだ Mode A なら判定していないので、全部を未判定として返す
 * (導入の形を B にした入力中の表で「なし」と言い切らないため)
 */
export function groupDomainChecks(
  site: Pick<Site, "mode" | "outsideDomains" | "uncheckedDomains">,
  group: { hosts: string[] },
): { outside: string[]; unchecked: string[] } {
  if (site.mode !== "B") return { outside: [], unchecked: [...group.hosts] };
  return {
    outside: group.hosts.filter((h) => site.outsideDomains.includes(h)),
    unchecked: group.hosts.filter((h) => site.uncheckedDomains.includes(h)),
  };
}
