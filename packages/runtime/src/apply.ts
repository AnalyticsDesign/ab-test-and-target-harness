import type { Change } from "@wtt/core";
import { activateScripts, runCustomJs, setNonce } from "./code";

/** rank = config の experiments の並びの番号(後ろほど優先が高い。決定 51、設計書 §3.2)。省略は 0 */
export type ActiveChange = { experimentId: string; variantId: string; change: Change; rank?: number };
export type ControlWatch = { experimentId: string; selectors: string[] };
export type EngineCallbacks = { onApplied(experimentId: string): void; onControlSeen(experimentId: string): void };
export type ApplyEngine = { start(changes: ActiveChange[], watches: ControlWatch[]): void; stop(): void };

export type HtmlChange = Extract<Change, { type: "HTML" }>;
export type CssChange = Extract<Change, { type: "CSS" }>;
type CustomJsChange = Extract<Change, { type: "CUSTOM_JS" }>;

/**
 * ページ寿命の状態(spec §10.4)。consent の撤回 → 再許可でエンジンは作り直されるが、この状態は runtime が 1 回だけ作って引き継ぐ
 * (r1 CX-High-1 / CL-High-3)。キーは experiment/variant/change の組 — Change ID は Variant 内でしか一意でない(D1 PK。r1 CX-High-2)
 */
export type PageState = {
  applied: WeakMap<Element, Set<string>>; // 要素ごとの適用済み changeKey(冪等性のため)
  executed: Set<string>; // CUSTOM_JS / HTML 内 <script> / CSS 注入の試行済み changeKey(試行前に登録。決定 38)
  succeeded: Set<string>; // 適用に成功した changeKey。要素が selector から外れても新世代が Exposure を出せるように(r2 CX-High-1)
  styles: Map<string, HTMLStyleElement>; // CSS: changeKey -> 注入した <style>
  owners: WeakMap<Element, Map<string, number>>; // 決定 51(設計書 §3.2): 要素の部分 → それを書いたエクスペリエンスの順位
};
export function createPageState(): PageState {
  return { applied: new WeakMap(), executed: new Set(), succeeded: new Set(), styles: new Map(), owners: new WeakMap() };
}
/** core の ID は min(1) だけで "/" などを含み得るため、区切り文字連結ではなく JSON 配列で一意にする(r2 CX-High-2) */
export function changeKey(experimentId: string, variantId: string, changeId: string): string {
  return JSON.stringify([experimentId, variantId, changeId]);
}

export type EngineOptions = { nonce?: string | null; state?: PageState };

/** 不正セレクタはスキップして 0 件(§10.7)。preview のエンジンとも共有する */
export function queryAll(doc: Document, selector: string): Element[] {
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** 要素を changeKey について適用済みにする。既に記録済みなら false(§10.4 の冪等性)。preview のエンジンとも共有する */
export function markApplied(applied: PageState["applied"], el: Element, key: string): boolean {
  let set = applied.get(el);
  if (set?.has(key)) return false;
  if (!set) applied.set(el, (set = new Set()));
  set.add(key);
  return true;
}

/**
 * 決定 51(設計書 §3.2): 変更が書く「要素の部分」。"*" = HTML の replace(要素のすべての部分)。
 * null = 優先を保証しないもの(HTML の挿入は両方入る・CSS は詳細度・CUSTOM_JS は保証しない)
 */
export function partOf(change: Change): string | null {
  switch (change.type) {
    case "TEXT":
      return "content";
    case "IMAGE":
      return "attr:src"; // ATTRIBUTE の src と同じ属性を書くので同じ部分(レビュー r1 CX-High-1)
    case "HIDE":
      return "display";
    case "ATTRIBUTE":
      return `attr:${change.payload.name.toLowerCase()}`;
    case "HTML":
      return change.payload.position === "replace" ? "*" : null;
    default:
      return null;
  }
}

/** 並びで後ろ(rank が大きい)のエクスペリエンスが、この部分(replace ならどれかの部分)を書いているか */
function blocked(owners: PageState["owners"], el: Element, part: string, rank: number): boolean {
  const m = owners.get(el);
  if (!m) return false;
  if (part === "*") {
    for (const r of m.values()) if (r > rank) return true;
    return false;
  }
  return (m.get(part) ?? -1) > rank || (m.get("*") ?? -1) > rank;
}

/** 部分を自分の順位で書いたと記録する。上書きした前の順位(無ければ null)を返す(② が「後から失敗」を数えるのに使う) */
function claim(owners: PageState["owners"], el: Element, part: string, rank: number): number | null {
  let m = owners.get(el);
  if (!m) owners.set(el, (m = new Map()));
  const prev = m.get(part) ?? null;
  m.set(part, rank);
  return prev !== null && prev < rank ? prev : null;
}

/** spec §11: TEXT / IMAGE / HIDE / ATTRIBUTE を 1 要素に適用する。例外はスキップして false(§10.7)。Code Change はエンジンが扱う */
export function applyChangeTo(el: Element, change: Change): boolean {
  try {
    switch (change.type) {
      case "TEXT":
        el.textContent = change.payload.text;
        return true;
      case "IMAGE":
        if (el.tagName !== "IMG") return false; // §11 の IMAGE は <img src> の置換。非 img は適用扱いにしない(r1 CX-Medium-6)
        el.setAttribute("src", change.payload.src);
        el.removeAttribute("srcset"); // §11: srcset は除去
        return true;
      case "HIDE":
        (el as HTMLElement).style.setProperty("display", "none", "important");
        return true;
      case "ATTRIBUTE":
        el.setAttribute(change.payload.name, change.payload.value);
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * spec §11 / §10.4: HTML を挿入する(DOM のみ。<script> の実行は呼び手が activateScripts で行う)。
 * template 経由で作るため、含まれる <script> は不活性(already started)のまま挿入される。
 * 返り値は挿入した最上位要素(テキストノードは含めない)。`replace` で html / head / body 自身は壊せないのでスキップ(null)
 */
export function applyHtml(el: Element, change: HtmlChange): Element[] | null {
  const doc = el.ownerDocument;
  const { html, position } = change.payload;
  if (position === "replace" && (el === doc.documentElement || el === doc.head || el === doc.body)) return null;
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  const nodes = Array.from(tpl.content.childNodes);
  const inserted = nodes.filter((n): n is Element => n.nodeType === 1);
  if (position === "replace") el.replaceWith(...nodes);
  else if (position === "before") el.before(...nodes);
  else if (position === "after") el.after(...nodes);
  else el.append(...nodes);
  return inserted;
}

/** spec §11: Change ごとに <style> を <head> へ。data 属性は管理・検証用、nonce は style-src の CSP 対応 */
export function injectCss(doc: Document, change: CssChange, ids: { experimentId: string; variantId: string }, nonce: string | null): HTMLStyleElement {
  const st = doc.createElement("style");
  st.setAttribute("data-ab-experiment", ids.experimentId);
  st.setAttribute("data-ab-variant", ids.variantId);
  st.setAttribute("data-ab-change", change.id);
  setNonce(st, nonce);
  st.textContent = change.payload.css;
  (doc.head ?? doc.documentElement).appendChild(st);
  return st;
}

export function createApplyEngine(doc: Document, cbs: EngineCallbacks, opts: EngineOptions = {}): ApplyEngine {
  const nonce = opts.nonce ?? null;
  const { applied, executed, succeeded, styles, owners } = opts.state ?? createPageState();
  // この世代で Exposure を出した Experiment。前の世代(撤回前)が成功させた Change(succeeded)は 1 回だけ onApplied を呼び、
  // §16 の「再許可は新しい訪問者として Exposure を再発火」を保つ。この世代で直接適用したものは重ねて数えない
  const credited = new Set<string>();
  let active: ActiveChange[] = [];
  let watches: ControlWatch[] = [];
  let observer: MutationObserver | null = null;
  let scheduled = false;
  let stopped = false;

  /** 前の世代が成功させた Change: この世代で 1 回だけ Exposure */
  function credit(experimentId: string): void {
    if (credited.has(experimentId)) return;
    credited.add(experimentId);
    cbs.onApplied(experimentId);
  }
  /** この世代で適用した: 成功を記録し、従来どおり要素・Change ごとに onApplied(exposure 側が Experiment ごとに 1 回へ丸める) */
  function appliedNow(experimentId: string, key: string): void {
    succeeded.add(key);
    credited.add(experimentId);
    cbs.onApplied(experimentId);
  }

  /** 適用済みとして記録する。既に記録済みなら false */
  const mark = (el: Element, key: string): boolean => markApplied(applied, el, key);
  const query = (selector: string): Element[] => queryAll(doc, selector);

  function applyCss(experimentId: string, variantId: string, change: CssChange, key: string): void {
    const existing = styles.get(key);
    if (existing) {
      if (!existing.isConnected) (doc.head ?? doc.documentElement).appendChild(existing); // SPA が <head> を作り直して外れた場合は戻す(DOM の再適用)
      return;
    }
    if (executed.has(key)) return; // 注入に失敗した(Trusted Types 等)。再試行しない(§10.7)
    executed.add(key);
    styles.set(key, injectCss(doc, change, { experimentId, variantId }, nonce));
    appliedNow(experimentId, key); // 注入した時点で適用成功(§11)。対照は compile の :root で同時に発火する(§10.5)
  }

  function applyCustomJs(experimentId: string, variantId: string, change: CustomJsChange, key: string): void {
    if (executed.has(key)) return; // ページ読込ごとに 1 回(§10.4)。前の世代の成功は succeeded から credit 済み
    const el = query(change.selector)[0];
    if (!el) return; // 要素が現れるまで待つ(試行済みにしない)
    executed.add(key); // 試行前に登録: 再入・例外後の二重実行を防ぐ(決定 38)
    const r = runCustomJs(doc, change.payload.code, el, { experimentId, variantId, changeId: change.id }, nonce);
    if (r.ok) {
      appliedNow(experimentId, key);
    } else {
      console.debug("wtt: custom js failed", change.id, r.error);
    }
  }

  function applyHtmlChange(experimentId: string, change: HtmlChange, key: string, rank: number): void {
    for (const el of query(change.selector)) {
      if (applied.get(el)?.has(key)) continue; // 同一要素へは 1 回だけ(§10.4)
      const replace = change.payload.position === "replace";
      if (replace && blocked(owners, el, "*", rank)) continue; // 決定 51: 後ろのエクスペリエンスが要素のどこかを書いている。印を付けず、要素が変われば再試行
      const before = replace ? owners.get(el) : undefined;
      let inserted: Element[] | null;
      try {
        inserted = applyHtml(el, change);
      } catch (e) {
        inserted = null; // 不正な HTML でも他の Change は続行(§10.7)
        console.debug("wtt: html insert failed", change.id, e);
      }
      if (inserted === null) continue;
      mark(el, key);
      // <script> の作り直しを先に行う(Plan 10 B2): activateScripts は <script> を新しい要素に差し替えるため、
      // 差し替え前にマークすると、マークは外れた旧要素に付きクローンは未マークのまま残る(self-matching selector で再適用される)
      let roots: Element[] = inserted;
      if (change.payload.runScripts && !executed.has(key)) {
        executed.add(key); // ページ読込ごとに 1 回(§10.4)。再適用では不活性のまま
        try {
          const clones = activateScripts(doc, inserted, nonce);
          // 差し替えで外れた最上位 <script> は落とし、代わりにクローンをマーク対象に加える(クローンに子孫は無い)
          roots = [...inserted.filter((n) => n.isConnected), ...clones];
        } catch (e) {
          console.debug("wtt: html scripts failed", change.id, e);
        }
      }
      // 決定 51: replace は要素のすべての部分を書いた。元の記録を新しい最上位の要素に写し、新しい部分木のすべての要素を自分の順位にする
      // (生成した子孫が同じセレクタに一致しても、前の順位の変更を通さない。レビュー r1 CX-High-2)。
      // <script> の差し替えの後の最終の roots で行う(activateScripts は script を clone に置き換えるので、前に付けた記録は clone に残らない。レビュー r2 CX-High-2)
      if (replace)
        for (const n of roots) {
          owners.set(n, new Map([...(before ?? new Map<string, number>()), ["*", rank]]));
          for (const d of Array.from(n.querySelectorAll("*"))) owners.set(d, new Map([["*", rank]]));
        }
      // 挿入した部分木への自己再適用を防ぐ: 最上位要素と、selector に一致する子孫を適用済みにする
      for (const n of roots) {
        mark(n, key);
        try {
          for (const d of Array.from(n.querySelectorAll(change.selector))) mark(d, key);
        } catch {
          /* 不正セレクタは query() で既に空 */
        }
      }
      appliedNow(experimentId, key); // DOM 挿入で適用成功(中の <script> の成否には依らない。r1 CX-Medium-2)
    }
  }

  function applyOne(experimentId: string, variantId: string, change: Change, rank: number): void {
    const key = changeKey(experimentId, variantId, change.id);
    // 前の世代(撤回前)が成功させた Change は、DOM から再発見できなくても(replace で selector が消えた、CUSTOM_JS が class を変えた)
    // この世代の Exposure を 1 回出す(§16。r2 CX-High-1)。この世代の成功は appliedNow が credited に入れるので二重にならない
    if (succeeded.has(key)) credit(experimentId);
    if (change.type === "CSS") return applyCss(experimentId, variantId, change, key);
    if (change.type === "CUSTOM_JS") return applyCustomJs(experimentId, variantId, change, key);
    if (change.type === "HTML") return applyHtmlChange(experimentId, change, key, rank);
    const part = partOf(change);
    for (const el of query(change.selector)) {
      if (applied.get(el)?.has(key)) continue; // 同一要素へは 1 回だけ(§10.4)
      if (part !== null && blocked(owners, el, part, rank)) continue; // 決定 51: 後ろのエクスペリエンスが書いた部分は上書きしない(印を付けない)
      if (!applyChangeTo(el, change)) continue;
      mark(el, key);
      if (part !== null) claim(owners, el, part, rank);
      appliedNow(experimentId, key);
    }
  }

  function scan(): void {
    if (stopped) return;
    for (const { experimentId, variantId, change, rank } of active) {
      try {
        applyOne(experimentId, variantId, change, rank ?? 0);
      } catch (e) {
        // Change 単位の例外境界(§10.7)。要素生成や <style> 挿入の例外(Trusted Types 等)で後続の Change と対照 watch を止めない。
        // CUSTOM_JS / HTML <script> / CSS は試行前に executed へ入るので MutationObserver の再スキャンで繰り返さない
        console.debug("wtt: change failed", change.id, e);
      }
    }
    // 対照 watch(§10.5)は発火したら退役させる。Exposure は Experiment ごとに 1 回で(exposure.ts の exposed Set)、
    // 発火後も毎 scan で全 selector を querySelector し続ける理由が無い(SPA の変異が多いページでは純粋なコスト。Plan 10 B2)。
    // 退役状態はエンジン寿命でよい: 再許可の新世代は start(changes, watches) で watch を渡し直し、§16 の Exposure 再発火を保つ
    watches = watches.filter((w) => {
      const seen = w.selectors.some((s) => {
        try {
          return doc.querySelector(s) !== null;
        } catch {
          return false;
        }
      });
      if (seen) cbs.onControlSeen(w.experimentId);
      return !seen;
    });
  }

  function schedule(): void {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      scan(); // 変異の嵐を 1 バッチにまとめる
    });
  }

  return {
    start(changes, controlWatches) {
      active = changes;
      watches = controlWatches;
      scan();
      observer = new MutationObserver(schedule); // §10.4: SPA の差替・遅延要素への再適用
      // attributes も監視する: 既存要素に class / id / data-* が後から付いて selector に一致する
      // hydration・SPA が実在するため(r1 CX-Medium-5)。selector は任意なので attributeFilter は使えない。
      // 自前の setAttribute / style 変更も通知を生むが、scan は WeakMap で冪等なので収束する(コストは microtask バッチで抑制)
      observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
    },
    stop() {
      stopped = true;
      observer?.disconnect();
    },
  };
}
