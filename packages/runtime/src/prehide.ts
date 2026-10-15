import { matchesUrl } from "@wtt/core";
import type { CompiledConfig } from "@wtt/core";
import { setNonce } from "./code";

const STYLE_ID = "__ab_prehide"; // spec §10.3

/** 指定した Experiment の prehide セレクタを重複なく集める(preview は URL ではなく要求で選ぶ。§12.3 (a)) */
export function prehideSelectorsFor(config: CompiledConfig, experimentIds: string[]): string[] {
  const out: string[] = [];
  for (const id of experimentIds) {
    for (const sel of config.prehide[id] ?? []) if (!out.includes(sel)) out.push(sel);
  }
  return out;
}

export function prehideSelectors(config: CompiledConfig, url: string): string[] {
  return prehideSelectorsFor(
    config,
    config.experiments.filter((exp) => matchesUrl(url, exp.urlMatch)).map((exp) => exp.id),
  );
}

/**
 * 各 selector をブラウザの selector parser で個別に検証してから連結する。
 * compiled config の selector 検証は長さのみ(core schema)なので、`.x{display:block}body` のような値が
 * prehide 経由で任意の CSS ルールになるのを防ぐ(fail-closed。r1 CX-Medium-2)
 */
function safeSelectors(doc: Document, selectors: string[]): string[] {
  return selectors.filter((s) => {
    try {
      doc.querySelector(s);
      return true;
    } catch {
      return false; // 不正 selector は 1 つだけ落とし、他は prehide する
    }
  });
}

export function injectPrehide(doc: Document, selectors: string[], nonce: string | null): void {
  const safe = safeSelectors(doc, selectors);
  if (safe.length === 0 || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  setNonce(style, nonce); // style-src の nonce 方式でも prehide が通るように(spec §11、決定 38)
  style.textContent = `${safe.join(",")}{opacity:0 !important}`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function removePrehide(doc: Document): void {
  doc.getElementById(STYLE_ID)?.remove();
}
