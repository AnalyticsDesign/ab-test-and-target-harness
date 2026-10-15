import { describe, expect, it } from "vitest";
import { activateScripts, cloneScript, runCustomJs } from "../src/code";
import { executableDocument } from "./dom";

const ctx = { experimentId: "exp_1", variantId: "vB", changeId: "c_js" };

describe("runCustomJs (spec §11 / 決定 38: <script> 要素の関数登録型、new Function を使わない)", () => {
  it("runs the code with element / ctx / this and removes the registration script", () => {
    const { win, doc } = executableDocument();
    doc.body.innerHTML = `<h1 class="t">x</h1>`;
    const el = doc.querySelector(".t")!;
    const r = runCustomJs(doc, "element.dataset.ctx = ctx.experimentId + '/' + ctx.variantId + '/' + ctx.changeId; window.__self = this === element;", el, ctx, null);
    expect(r).toEqual({ ok: true });
    expect(el.getAttribute("data-ctx")).toBe("exp_1/vB/c_js");
    expect((win as unknown as { __self: boolean }).__self).toBe(true);
    expect(doc.querySelectorAll("script")).toHaveLength(0); // 登録用 <script> は実行後に除去
  });

  it("reports a thrown error as ok:false and leaves the page intact (spec §10.7)", () => {
    const { doc } = executableDocument();
    doc.body.innerHTML = `<h1 class="t">x</h1>`;
    const r = runCustomJs(doc, "throw new Error('boom')", doc.querySelector(".t")!, ctx, null);
    expect(r.ok).toBe(false);
    expect(String((r as { error: unknown }).error)).toContain("boom");
    expect(doc.querySelectorAll("script")).toHaveLength(0);
  });

  it("reports ok:false when nothing was registered (syntax error or CSP block)", () => {
    const { doc } = executableDocument();
    doc.body.innerHTML = `<h1 class="t">x</h1>`;
    const r = runCustomJs(doc, "this is not javascript(", doc.querySelector(".t")!, ctx, null);
    expect(r.ok).toBe(false);
    expect(doc.querySelectorAll("script")).toHaveLength(0);
  });

  it("never throws: a failing textContent setter (Trusted Types) becomes ok:false (r1 CX-High-3 / CL-High-2)", () => {
    // Trusted Types 強制下では HTMLScriptElement.textContent への文字列代入が TypeError になる。runCustomJs は投げずに失敗を返す
    const { doc } = executableDocument();
    doc.body.innerHTML = `<h1 class="t">x</h1>`;
    const orig = doc.createElement.bind(doc);
    doc.createElement = ((tag: string) => {
      const el = orig(tag);
      if (tag === "script") Object.defineProperty(el, "textContent", { set() { throw new TypeError("This document requires 'TrustedScript' assignment."); } });
      return el;
    }) as typeof doc.createElement;
    const r = runCustomJs(doc, "element.textContent = 'y'", doc.querySelector(".t")!, ctx, null);
    expect(r.ok).toBe(false);
    expect(String((r as { error: unknown }).error)).toContain("TrustedScript");
    expect(doc.querySelector(".t")!.textContent).toBe("x");
    expect(doc.querySelectorAll("script")).toHaveLength(0);
  });

  it("puts the runtime nonce on the registration script", () => {
    const { doc } = executableDocument();
    doc.body.innerHTML = `<h1 class="t">x</h1>`;
    const seen: string[] = [];
    // 挿入時点の属性を観察する(実行後は除去されるため)
    const orig = doc.head.appendChild.bind(doc.head);
    doc.head.appendChild = ((n: Node) => {
      seen.push((n as Element).getAttribute("nonce") ?? "");
      return orig(n);
    }) as typeof doc.head.appendChild;
    expect(runCustomJs(doc, "element.textContent = 'y'", doc.querySelector(".t")!, ctx, "abc123").ok).toBe(true);
    expect(seen).toEqual(["abc123"]);
  });
});

describe("cloneScript / activateScripts (spec §11: 挿入した <script> を作り直して実行する)", () => {
  it("cloneScript copies attributes and text and adds the nonce", () => {
    const { doc } = executableDocument();
    const tpl = doc.createElement("template") as HTMLTemplateElement;
    tpl.innerHTML = `<script type="text/javascript" data-x="1">window.__ran = 1</script>`;
    const from = tpl.content.querySelector("script")!;
    const s = cloneScript(doc, from, "n1");
    expect(s.getAttribute("type")).toBe("text/javascript");
    expect(s.getAttribute("data-x")).toBe("1");
    expect(s.getAttribute("nonce")).toBe("n1");
    expect(s.textContent).toBe("window.__ran = 1");
    expect(s.isConnected).toBe(false);
  });

  it("activateScripts executes inline scripts under the roots exactly once and returns the recreated elements", () => {
    const { win, doc } = executableDocument();
    const tpl = doc.createElement("template") as HTMLTemplateElement;
    tpl.innerHTML = `<div class="a"><script>window.__n = (window.__n || 0) + 1</script><p>x</p></div><script>window.__n = (window.__n || 0) + 10</script>`;
    const roots = Array.from(tpl.content.childNodes).filter((n): n is Element => n.nodeType === 1);
    doc.body.append(...roots); // template 由来の <script> は adopt しても不活性(already started)
    expect((win as unknown as { __n?: number }).__n).toBeUndefined();
    expect(activateScripts(doc, roots, null)).toHaveLength(2);
    expect((win as unknown as { __n?: number }).__n).toBe(11);
    expect(doc.querySelectorAll("script")).toHaveLength(2); // 差し替え後も要素数は同じ
  });

  it("activateScripts leaves data scripts inert (browser decides by type)", () => {
    const { doc } = executableDocument();
    const tpl = doc.createElement("template") as HTMLTemplateElement;
    tpl.innerHTML = `<script type="application/ld+json">{"@type":"Thing"}</script>`;
    const roots = Array.from(tpl.content.childNodes).filter((n): n is Element => n.nodeType === 1);
    doc.body.append(...roots);
    expect(activateScripts(doc, roots, "n1")).toHaveLength(1);
    const s = doc.querySelector("script")!;
    expect(s.getAttribute("type")).toBe("application/ld+json");
    expect(s.textContent).toBe('{"@type":"Thing"}');
  });
});
