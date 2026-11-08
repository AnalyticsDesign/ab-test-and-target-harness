/**
 * ページの一致(決定 49、設計書 §4.1.2 / §10.1)。URL を照合する場所(配信条件のページの URL / パス / ホスト・閲覧したページ・
 * エクスペリエンスの対象 URL・目標の PAGEVIEW)はすべて同じ `{ part, op, value }` で照合する。zod を使わない(runtime が import する)
 */
import { REGEX_RUN_LIMITS, runProgram, type RegexProgram } from "./regex-run";

export const PAGE_PARTS = ["url", "path", "host"] as const;
export type PagePart = (typeof PAGE_PARTS)[number];
export type PageOp = "equals" | "contains" | "startsWith" | "endsWith" | "regex";

/** part ごとに使える一致の仕方(設計書 §3)。url の regex は使えない(型には残るが、保存時は pageMatchIssue が案内付きで拒否し、配る形は schema が拒否する) */
export const PAGE_OPS: Record<PagePart, readonly PageOp[]> = {
  url: ["equals", "contains", "startsWith", "regex"],
  path: ["contains", "equals", "startsWith", "regex"],
  host: ["equals", "endsWith", "contains", "regex"],
};

/**
 * 配る形のページの一致。`part` 省略 = url。`prog` = 正規表現の命令列(op = regex のとき必須)。
 * 正規表現は命令列(runProgram)だけで照合し、`RegExp` には落ちない(版 1 の legacy フォールバックは backlog B52 で削除)
 */
export type PageMatch = { part?: PagePart; op: PageOp; value: string; prog?: RegexProgram };

/** 照合する値。host・path・params は URL を解析できなければ null(その条件は判定できない) */
export type PageView = { url: string; host: string | null; path: string | null; params: URLSearchParams | null };

/** ホスト = hostname(ポートを含まない)を小文字化し末尾のドットを除いた値。パス = pathname(percent-encoding のまま)。URL = 今の判定と同じ文字列 */
export function pageOf(url: string): PageView {
  try {
    const u = new URL(url);
    return { url, host: u.hostname.toLowerCase().replace(/\.+$/, ""), path: u.pathname, params: u.searchParams };
  } catch {
    return { url, host: null, path: null, params: null };
  }
}

/**
 * true / false / null(判定できない: URL を解析できない、正規表現の命令列が不正、照合する長さの上限を超える)。
 * null は呼び手が「対象外」にする(単に「一致しない」と扱うと not の下で配信対象が広がるため。設計書 §11.1)
 */
export function matchPage(m: PageMatch, page: PageView): boolean | null {
  const part = m.part ?? "url";
  const s = part === "url" ? page.url : part === "host" ? page.host : page.path;
  if (s === null) return null;
  const v = m.value;
  switch (m.op) {
    case "equals":
      return s === v;
    case "contains":
      return s.includes(v);
    case "startsWith":
      return s.startsWith(v);
    case "endsWith":
      return s === v || s.endsWith("." + v); // ドメインのラベル境界で判定(notexample.com は example.com に一致しない)
    case "regex":
      // 命令列が無い(url の regex・手書き)か、照合する長さの上限を超えるなら判定できない
      if (!m.prog || s.length > (part === "host" ? REGEX_RUN_LIMITS.hostMax : REGEX_RUN_LIMITS.pathMax)) return null;
      return runProgram(m.prog, s);
  }
  return null; // 未知の op(改竄・別の版の混入)
}

/** 文字列の URL に対する一致(true のときだけ一致。null は一致しない側)。対象 URL・パターン・目標の判定用 */
export function matchesUrl(url: string, m: PageMatch): boolean {
  return matchPage(m, pageOf(url)) === true;
}

/** パラメータの条件(対象 URL の行。値は URL の searchParams と同じ文字列で照合する) */
export type ParamMatch = { name: string; op: "equals"; value: string } | { name: string; op: "contains"; value: string } | { name: string; op: "exists" };
/** 対象 URL の 1 行 = ページの一致 AND すべてのパラメータの条件 */
export type UrlRow<P = PageMatch> = { page: P; params?: ParamMatch[] };
/** 対象 URL = 含める行のどれかに一致し、除く行のどれにも一致しない */
export type UrlMatch<P = PageMatch> = { include: UrlRow<P>[]; exclude?: UrlRow<P>[] };

/**
 * 対象 URL の照合(true = 対象)。行の結果は 3 値で、page とすべてのパラメータを短絡せず評価し、どれかが null なら null。
 * 除くの行が null なら対象外(判定できないページで配信先を広げない)、含めるの行が null なら一致しない。
 * 形の合わない入力(null・include が配列でない・page の無い行・版 2 の PageMatch・配列でない params)は例外を投げず false。
 * 配列でない exclude は、偽の値なら無いのと同じ、page を持たない値なら false。ただし page を持つオブジェクト(配列に包んでいない 1 行)は
 * 例外になる(schema が保存・配る形で止める入力で、ここでは守らない)
 */
export function matchTargetUrl(m: unknown, page: PageView): boolean {
  const { include, exclude } = (m || {}) as Partial<UrlMatch>;
  if (!Array.isArray(include)) return false;
  const rows = include.concat(exclude || []);
  if (rows.some((r) => !r || !r.page || (r.params && !Array.isArray(r.params)))) return false;
  // 行の結果。同じ名前のパラメータが複数あれば、どれか 1 つが条件を満たせば一致
  const row = ({ page: pm, params }: UrlRow): boolean | null => {
    const rs = [matchPage(pm, page)].concat(
      (params || []).map((p) => {
        const vs = page.params && page.params.getAll(p.name);
        return vs && (p.op === "exists" ? vs.length > 0 : vs.some((v) => (p.op === "equals" ? v === p.value : v.includes(p.value))));
      }),
    );
    return rs.includes(null) ? null : rs.every((r) => r);
  };
  return !(exclude || []).map(row).some((r) => r !== false) && include.map(row).some((r) => r === true);
}

/** 文字列の URL に対する対象 URL の照合(null は一致しない側)。テストなど、PageView を持たない呼び手用 */
export function matchesTargetUrl(url: string, m: unknown): boolean {
  return matchTargetUrl(m, pageOf(url));
}
