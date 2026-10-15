/**
 * Code Change の実行機構(spec §11、決定 38 (3))。`new Function` / `eval` は使わず、`<script>` 要素を作って DOM に挿入する。
 * 理由: 企業サイトの CSP は nonce + 'strict-dynamic' が標準で、runtime が nonce を引き継げば追加の許可なしに動く
 * ('unsafe-eval' は審査で断られやすい)。CSP3 §6.7.3.3 により 'strict-dynamic' 下の non-parser-inserted な
 * インライン <script> は Chrome / Firefox / Safari 15.4+ で許可される。
 * Trusted Types(require-trusted-types-for 'script')強制下では textContent 代入が拒否される — 非対応(導入ガイド)。
 * その例外も runCustomJs の中で捕捉し、他の Change を止めない(§10.7)
 */

export type CodeCtx = { experimentId: string; variantId: string; changeId: string };
export type RunResult = { ok: true } | { ok: false; error: unknown };

type RegistrationScript = HTMLScriptElement & { __abFn?: unknown };

/** 生成した要素を挿す場所。<head> が無い(壊れた文書)なら documentElement */
function mountPoint(doc: Document): Element {
  return doc.head ?? doc.documentElement;
}

/** apply.ts / prehide.ts と共有(final review finding 3)。CSP が参照するのは IDL の `nonce`(内部スロット)であり、
 * content 属性は挿入後にブラウザが隠す(nonce hiding)ので、両方に入れておく — 属性は happy-dom でのテスト・可読性のため */
export function setNonce(el: HTMLScriptElement | HTMLStyleElement, nonce: string | null): void {
  if (!nonce) return;
  el.setAttribute("nonce", nonce);
  el.nonce = nonce;
}

/** 属性と本文をコピーした新しい <script>(未挿入)。inline / src 両対応。type はコピーするだけでブラウザが実行可否を決める */
export function cloneScript(doc: Document, from: HTMLScriptElement, nonce: string | null): HTMLScriptElement {
  const s = doc.createElement("script");
  for (const a of Array.from(from.attributes)) s.setAttribute(a.name, a.value);
  setNonce(s, nonce);
  s.textContent = from.textContent;
  return s;
}

/**
 * CUSTOM_JS を 1 回実行する。登録用 <script> は `document.currentScript.__abFn` に関数を登録するだけで、
 * 呼び出しは runtime 側の try/catch で行う(挿入した <script> 内の例外は appendChild では捕捉できないため)。
 * 登録が無ければ CSP ブロックか構文エラー — どちらも「適用失敗」(Exposure なし)。
 * **この関数は例外を投げない**: 要素生成・nonce・本文設定(Trusted Types で拒否され得る)・挿入・呼出のすべてを try 内で行う
 */
export function runCustomJs(doc: Document, code: string, element: Element, ctx: CodeCtx, nonce: string | null): RunResult {
  let s: RegistrationScript | null = null;
  try {
    s = doc.createElement("script") as RegistrationScript;
    setNonce(s, nonce);
    s.textContent = `document.currentScript.__abFn=function(element,ctx){\n${code}\n};`;
    mountPoint(doc).appendChild(s); // 接続時に同期実行される(classic・src なし)
  } catch (e) {
    s?.remove();
    return { ok: false, error: e };
  }
  s.remove(); // 登録専用なので残さない
  const fn = s.__abFn;
  if (typeof fn !== "function") return { ok: false, error: new Error("custom js was not registered (blocked by CSP or syntax error)") };
  try {
    (fn as (this: Element, el: Element, c: CodeCtx) => void).call(element, element, ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * 挿入済み HTML の中の <script> を作り直して差し替える(spec §11)。innerHTML / template 由来の <script> は
 * "already started" で決して走らないため、同じ属性・本文の新しい要素に置き換えることで実行させる。
 * inline は同期実行、src は非同期ロード。1 つが失敗しても残りは続ける(§10.7)。
 * 返り値は差し替え後の <script> 要素(実行成功の証明ではない)。呼び手はこれを適用済みマークの対象に含める(Plan 10 B2)
 */
export function activateScripts(doc: Document, roots: Element[], nonce: string | null): HTMLScriptElement[] {
  const clones: HTMLScriptElement[] = [];
  for (const old of scriptsIn(roots)) {
    try {
      const next = cloneScript(doc, old, nonce);
      old.replaceWith(next);
      clones.push(next);
    } catch (e) {
      console.debug("wtt: script activation failed", e);
    }
  }
  return clones;
}

/** 挿入した部分木に含まれる <script>(最上位が <script> の場合も含む)。preview の差し替え(§10.8)と共有する */
export function scriptsIn(roots: Element[]): HTMLScriptElement[] {
  const targets: HTMLScriptElement[] = [];
  for (const root of roots) {
    if (root.tagName === "SCRIPT") targets.push(root as HTMLScriptElement);
    targets.push(...Array.from(root.querySelectorAll("script")));
  }
  return targets;
}
