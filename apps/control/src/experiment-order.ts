import type { ExperimentKind } from "@wtt/core";

/**
 * 決定 51(設計書 §3.2・§9.3): compile の入力に並べる順 = 優先の順(後に並ぶものほど優先が高い)。
 * [パーソナライズ: 作成の古い順] → [テスト: 配信に入った時刻(last_started_at。開始・再開のたびに更新)の新しい順]。
 * 同じミリ秒は ID の昇順(config のバイト列を決定的にする)。テストはパーソナライズより優先し、テストどうしは先に配信に入ったものを
 * 優先する(後から開始・再開したテストで、配信中のテストのパターンが途中から見えなくなると、配信中の結果が黙って壊れるため)。
 * last_started_at が null のテスト(下書きの評価・プレビュー・開始の確認の計算)は「今開始した」とみなし、テストの中で最も優先が低い側に置く(K5)
 */
export type OrderRow = { id: string; kind: ExperimentKind; created_at: number; last_started_at: number | null };

const byId = (a: OrderRow, b: OrderRow): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function compare(a: OrderRow, b: OrderRow): number {
  if (a.kind !== b.kind) return a.kind === "single" ? -1 : 1;
  if (a.kind === "single") return a.created_at - b.created_at || byId(a, b);
  const sa = a.last_started_at ?? Number.POSITIVE_INFINITY;
  const sb = b.last_started_at ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa > sb ? -1 : 1; // 配信に入った時刻の新しい順(Infinity どうしの引き算は NaN になるので比較で決める)
  return byId(a, b);
}

export function orderForCompile<T extends OrderRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compare);
}

/**
 * 決定 51(設計書 §3.3): 同じ対象 URL の条件(`urlMatch` の完全一致)で、同じセレクタの文字列を変えるエクスペリエンスの組を警告する(拒否しない)。
 * 入力は compile の入力と同じ並び(後ろほど優先が高い)。警告は優先の低い方に付け、どちらが優先されるかを文に入れる。
 * 範囲の違う URL の条件の重なり(サイト全体と特定のページ)・セレクタの意味の重なりは見ない(見えない重なりは並びの規則で
 * 一意に決まり、② 以降は適用の失敗として数える)。範囲の重なりを足すときは `urlKey` の比較をここで差し替える
 */
export type OverlapExperiment = { id: string; name: string; kind: ExperimentKind; urlMatch: unknown; variants: Array<{ changes: Array<{ selector?: string }> }> };
export type OverlapWarning = { path: string; message: string; experimentIds: [string, string] };

const SHOWN_SELECTORS = 3;

function urlKey(m: unknown): string {
  const { part, op, value } = (m ?? {}) as { part?: string; op?: string; value?: string };
  return JSON.stringify([part ?? "url", op, value]);
}

function selectorsOf(e: OverlapExperiment): string[] {
  const out: string[] = [];
  for (const v of e.variants) for (const c of v.changes) if (c.selector && !out.includes(c.selector)) out.push(c.selector);
  return out;
}

function describeSelectors(sels: string[]): string {
  const shown = sels.slice(0, SHOWN_SELECTORS).join("、");
  return sels.length > SHOWN_SELECTORS ? `${shown} ほか ${sels.length - SHOWN_SELECTORS} 件` : shown;
}

function overlapMessage(lo: OverlapExperiment, hi: OverlapExperiment, sels: string): string {
  if (lo.kind === "test" && hi.kind === "test") return `「${lo.name}」は「${hi.name}」と同じ要素(${sels})を変えます。「${hi.name}」(先に開始・再開)が優先され、「${lo.name}」の効果は薄まって見えます`;
  if (lo.kind === "single" && hi.kind === "single") return `「${lo.name}」と「${hi.name}」(どちらもパーソナライズ)は同じ要素(${sels})を変えます。後に作成した「${hi.name}」が優先されます`;
  return `「${lo.name}」(パーソナライズ)は「${hi.name}」(テスト)と同じ要素(${sels})を変えます。テストが優先され、テストのパターンが変える部分では「${lo.name}」の変更は表示されません`;
}

export function overlapWarnings(experiments: readonly OverlapExperiment[]): OverlapWarning[] {
  const keyed = experiments.map((e) => ({ e, url: urlKey(e.urlMatch), sels: selectorsOf(e) }));
  const out: OverlapWarning[] = [];
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const lo = keyed[i]!;
      const hi = keyed[j]!;
      if (lo.url !== hi.url) continue;
      const common = lo.sels.filter((s) => hi.sels.includes(s));
      if (common.length === 0) continue;
      out.push({ path: `experiments.${lo.e.id}`, message: overlapMessage(lo.e, hi.e, describeSelectors(common)), experimentIds: [lo.e.id, hi.e.id] });
    }
  }
  return out;
}
