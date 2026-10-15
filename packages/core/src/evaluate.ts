import { bucketOf, inTraffic } from "./hash";
import { matchPage, pageOf, type PageView } from "./page";
import { isValidProgram } from "./regex-run";
import { inTimeWindow } from "./time";
import type { Browser, Device, Os } from "./ua";
import type { CompiledConfig, DslNode, Experiment } from "./schema";

export { matchesUrl } from "./page";

/**
 * 判定の入力(決定 49、設計書 §11.1)。省略できる項目は「欠けている」ことがあり、それを使う条件を含むエクスペリエンスは対象外にする
 * (fail-closed)。`firstVisitAt` は undefined = 欠落、null = 発行時刻が不明(v4 の ID。§7.3 の扱い)
 */
export type PageContext = {
  url: string;
  query: Record<string, string>;
  /**
   * 端末。省略可(control の evaluate で device も userAgent も無いとき = 端末の条件は判定できない)。
   * runtime と edge は常に入れる(古い runtime の body にも device はある)
   */
  device?: Device;
  referrer: string;
  browser?: Browser;
  os?: Os;
  /** 画面の幅(px)。ページを開いた時点の値 */
  viewportWidth?: number;
  /** 判定時刻(epoch ミリ秒)。1 回の判定の最初に 1 度だけ取って固定する */
  now?: number;
  /** 初回の訪問時刻(epoch ミリ秒) */
  firstVisitAt?: number | null;
};

/** Profile の履歴。lastAt は epoch 秒(DO の形)。lastAt が無いのに期間の条件があれば判定できない(対象外) */
export type ProfileSnapshot = {
  goals: Record<string, { count: number; lastAt?: number }>;
  pages: Record<string, { count: number; lastAt?: number }>;
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 期間の条件(設計書 §11)。「N 回以上 + 最後が N 日以内」= count >= min かつ now - lastAt <= N 日 */
function histMatch(e: { count: number; lastAt?: number } | undefined, min: number, withinDays: number | undefined, now: number | undefined): boolean | null {
  const count = e?.count ?? 0;
  if (withinDays === undefined) return count >= min;
  if (now === undefined) return null;
  if (count === 0) return false;
  if (typeof e?.lastAt !== "number") return null;
  return count >= min && now - e.lastAt * 1000 <= withinDays * DAY_MS;
}

/**
 * DSL の評価。true / false / null(判定に要る入力が欠けている・不正 = そのエクスペリエンスは対象外)。
 * **and / or は短絡しない**: どの子の入力が欠けても null にする(評価の前に静的に対象外にするのと同じ結果。edge とブラウザで同じ判定にするため。§11.1)。
 * 認識できない node も null(not の下で配信対象を広げない)
 */
export function evaluateDsl(node: DslNode, ctx: PageContext, profile: ProfileSnapshot | null, timezone?: string, page: PageView = pageOf(ctx.url)): boolean | null {
  const all = (xs: DslNode[], every: boolean): boolean | null => {
    let missing = false;
    let hit = every;
    for (const x of xs) {
      const r = evaluateDsl(x, ctx, profile, timezone, page);
      if (r === null) missing = true;
      else if (r !== every) hit = !every;
    }
    return missing ? null : hit;
  };
  if ("and" in node) return Array.isArray(node.and) ? all(node.and, true) : null;
  if ("or" in node) return Array.isArray(node.or) ? all(node.or, false) : null;
  if ("not" in node) {
    const r = evaluateDsl(node.not, ctx, profile, timezone, page);
    return r === null ? null : !r;
  }
  if ("hist" in node) {
    if (profile === null) return null; // 履歴を取れない(DO を使わない経路・取得不能)
    if (node.hist === "visited") return histMatch(profile.pages[node.pattern], node.min ?? 1, node.withinDays, ctx.now);
    if (node.hist === "converted") return histMatch(profile.goals[node.goal], 1, node.withinDays, ctx.now);
    return null;
  }
  switch (node.ctx) {
    case "url":
      return matchPage({ op: node.op, value: node.value }, page);
    case "host":
    case "path":
      // ctx キーを PageMatch に持ち込まないよう、フィールドを明示して組み立てる
      return matchPage({ part: node.ctx, op: node.op, value: node.value, ...(node.prog !== undefined ? { prog: node.prog } : {}) }, page);
    case "query": {
      const v = ctx.query[node.name];
      if (node.op === "exists") return v !== undefined;
      // node.value の型の確認は schema を迂回した不正 node への fail-closed(decide_malformed_targeting_never_qualifies)
      if (typeof node.value !== "string") return null;
      return node.op === "equals" ? v === node.value : v !== undefined && v.includes(node.value);
    }
    case "device":
    case "browser":
    case "os": {
      // User-Agent から判定した値。browser / os は古い runtime からの要求などで欠けることがある(欠けていれば判定できない)
      const v = ctx[node.ctx];
      return v === undefined || !Array.isArray(node.value) ? null : (node.value as string[]).includes(v);
    }
    case "referrer":
      if (node.op === "isEmpty") return ctx.referrer === "";
      if (typeof node.value !== "string") return null;
      return node.op === "equals" ? ctx.referrer === node.value : ctx.referrer.includes(node.value);
    case "viewport": {
      const w = ctx.viewportWidth;
      if (typeof w !== "number" || !Number.isFinite(w)) return null;
      return (node.minWidth === undefined || w >= node.minWidth) && (node.maxWidth === undefined || w < node.maxWidth);
    }
    case "time":
      if (ctx.now === undefined || timezone === undefined) return null;
      return inTimeWindow(node, ctx.now, timezone);
    case "sinceFirstVisit": {
      if (ctx.now === undefined || ctx.firstVisitAt === undefined) return null;
      // 発行時刻が不明(v4 の ID = v1.0 より前に発行)は古い訪問者として扱う(§7.3)
      if (ctx.firstVisitAt === null) return node.op === "gte";
      const threshold = node.hours !== undefined ? node.hours * HOUR_MS : (node.days ?? NaN) * DAY_MS;
      if (!Number.isFinite(threshold)) return null;
      const elapsed = Math.max(0, ctx.now - ctx.firstVisitAt); // 未来の時刻(端末の時計のずれ)は経過 0 = 新規
      return node.op === "gte" ? elapsed >= threshold : elapsed < threshold;
    }
  }
  return null;
}

export function dslNeedsProfile(node: DslNode): boolean {
  if ("and" in node) return node.and.some(dslNeedsProfile);
  if ("or" in node) return node.or.some(dslNeedsProfile);
  if ("not" in node) return dslNeedsProfile(node.not);
  return "hist" in node;
}

/** spec §7.2: 累積 weight × 100 の区間に bucket が入る Variant を返す */
export function pickVariant(exp: Experiment, visitorId: string): string {
  const bucket = bucketOf(visitorId, exp.id);
  let acc = 0;
  for (const v of exp.variants) {
    acc += v.weight * 100;
    if (bucket < acc) return v.id;
  }
  return exp.variants[exp.variants.length - 1]!.id;
}

export function decide(
  config: Pick<CompiledConfig, "needsProfile" | "experiments" | "timezone">, // DO は URL 一致の部分集合だけを受け取る(spec §7.4)
  ctx: PageContext,
  visitorId: string,
  profile: ProfileSnapshot | null,
  persisted?: Record<string, string>,
): Array<{ experimentId: string; variantId: string }> {
  // Profile 取得不能(null)かつ needsProfile な config は全体を空 Decision(元表示、fail-closed)
  if (config.needsProfile && profile === null) return [];
  const page = pageOf(ctx.url);
  const out: Array<{ experimentId: string; variantId: string }> = [];
  for (const exp of config.experiments) {
    if (matchPage(exp.urlMatch, page) !== true) continue;
    // 判定できない(null)・偽は配信しない。profile 取得不能時の履歴条件も null になる(fail-closed)
    if (exp.targeting && evaluateDsl(exp.targeting, ctx, profile, config.timezone, page) !== true) continue;
    const persistedVariant = exp.persistAssignment ? persisted?.[exp.id] : undefined;
    const validPersisted =
      persistedVariant !== undefined && exp.variants.some((v) => v.id === persistedVariant)
        ? persistedVariant
        : undefined;
    // 決定 28(spec §7.3): 有効な保存済み割当は traffic 判定より優先する。縮小は未割当の訪問者にのみ及ぶ
    if (validPersisted === undefined && !inTraffic(visitorId, exp.id, exp.trafficPercentage)) continue;
    out.push({ experimentId: exp.id, variantId: validPersisted ?? pickVariant(exp, visitorId) });
  }
  return out;
}

/**
 * 配信条件の閲覧の条件(`hist: "visited"`)が参照するパターンが使えないなら true: 存在しない、正規表現なのに命令列が無い・
 * `isValidProgram` を通らない、または **page を渡したとき、そのページで判定できない**(256 字を超えるパスでのパスの正規表現・
 * URL を解析できない = matchPage が null。plan ② P12)。
 * 使えないパターンは Profile が数えない(patternsForUrl)ので、`not(visited(p))` が真になって配信対象が広がる。
 * そのため評価の前に静的に対象外にする(設計書 §10.3・§11.1。plan ① P4 と同じ考え方)
 */
export function experimentUsesInvalidPattern(exp: Experiment, patterns: CompiledConfig["patterns"], page?: PageView): boolean {
  const bad = (node: DslNode): boolean => {
    if ("and" in node) return Array.isArray(node.and) && node.and.some(bad);
    if ("or" in node) return Array.isArray(node.or) && node.or.some(bad);
    if ("not" in node) return bad(node.not);
    if (!("hist" in node) || node.hist !== "visited") return false;
    const def = Object.prototype.hasOwnProperty.call(patterns, node.pattern) ? patterns[node.pattern] : undefined;
    if (def === undefined) return true;
    if (page !== undefined && matchPage(def, page) === null) return true;
    if (def.op !== "regex") return false;
    return def.prog === undefined || !isValidProgram(def.prog);
  };
  return exp.targeting !== undefined && bad(exp.targeting);
}

/**
 * spec §7.4 ③: URL に一致する Experiment(config の順序を保つ)。edge が DO に渡す部分集合を作る。
 * 使えないパターン・このページで判定できないパターンを参照する Experiment は入れない(experimentUsesInvalidPattern。対象外)
 */
export function experimentsForUrl(config: Pick<CompiledConfig, "experiments" | "patterns">, url: string): Experiment[] {
  const page = pageOf(url);
  return config.experiments.filter((e) => matchPage(e.urlMatch, page) === true && !experimentUsesInvalidPattern(e, config.patterns, page));
}

/** spec §7.4 ③ / §6.3: URL に一致するパターン ID。Profile はこの ID だけをカウントする(判定できないパターンは数えない) */
export function patternsForUrl(config: Pick<CompiledConfig, "patterns">, url: string): string[] {
  const page = pageOf(url);
  return Object.entries(config.patterns).filter(([, def]) => matchPage(def, page) === true).map(([id]) => id);
}
