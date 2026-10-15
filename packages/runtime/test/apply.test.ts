import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Change } from "@wtt/core";
import { applyChangeTo, applyHtml, changeKey, createApplyEngine, createPageState } from "../src/apply";

beforeEach(() => {
  document.body.innerHTML = `<h1 class="hero-title">orig</h1><img class="hero-img" src="/a.png" srcset="/a2.png 2x"><p class="old-banner">old</p><a class="cta" href="/lp/">go</a>`;
  document.head.querySelectorAll("style[data-ab-change]").forEach((s) => s.remove()); // CSS テストの <style> は head に残る(r1 CL-Medium-3)
});

const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0)); // observer 発火 + microtask バッチ
};

it("applies TEXT / IMAGE / HIDE / ATTRIBUTE (spec §11)", () => {
  const el = document.querySelector(".hero-title")!;
  expect(applyChangeTo(el, { id: "c1", type: "TEXT", selector: ".hero-title", payload: { text: "B!" } } as Change)).toBe(true);
  expect(el.textContent).toBe("B!");
  const img = document.querySelector(".hero-img")!;
  applyChangeTo(img, { id: "c2", type: "IMAGE", selector: ".hero-img", payload: { src: "https://cdn.test/b.png" } } as Change);
  expect(img.getAttribute("src")).toBe("https://cdn.test/b.png");
  expect(img.hasAttribute("srcset")).toBe(false); // §11: srcset は除去
  const banner = document.querySelector<HTMLElement>(".old-banner")!;
  applyChangeTo(banner, { id: "c3", type: "HIDE", selector: ".old-banner", payload: {} } as Change);
  expect(banner.style.getPropertyValue("display")).toBe("none");
  expect(banner.style.getPropertyPriority("display")).toBe("important");
  const cta = document.querySelector(".cta")!;
  applyChangeTo(cta, { id: "c4", type: "ATTRIBUTE", selector: ".cta", payload: { name: "href", value: "/lp2/" } } as Change);
  expect(cta.getAttribute("href")).toBe("/lp2/");
});

it("applyChangeTo は Code Change を扱わない(エンジンが code.ts 経由で適用する)", () => {
  const el = document.querySelector(".hero-title")!;
  expect(applyChangeTo(el, { id: "c5", type: "HTML", selector: ".hero-title", payload: { html: "<b>x</b>", position: "replace", runScripts: false } } as Change)).toBe(false);
  expect(applyChangeTo(el, { id: "c6", type: "CUSTOM_JS", selector: ".hero-title", payload: { code: "element.remove()" } } as Change)).toBe(false);
  expect(el.textContent).toBe("orig");
});

it("IMAGE targets img elements only and reports no apply otherwise (spec §11, r1 CX-Medium-6)", () => {
  // 非 img で true を返すと Exposure が発火し、画像が変わっていないのに「提示された」と計上される
  const notImg = document.querySelector(".hero-title")!;
  expect(applyChangeTo(notImg, { id: "c7", type: "IMAGE", selector: ".hero-title", payload: { src: "https://cdn.test/b.png" } } as Change)).toBe(false);
  expect(notImg.hasAttribute("src")).toBe(false);
});

it("applies each change once per element and reapplies after replacement (spec §10.4)", async () => {
  const onApplied = vi.fn();
  const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() });
  engine.start(
    [
      { experimentId: "exp_hero", variantId: "vB", change: { id: "c_text", type: "TEXT", selector: ".hero-title", payload: { text: "B!" } } as Change },
      { experimentId: "exp_hero", variantId: "vB", change: { id: "c_attr", type: "ATTRIBUTE", selector: ".hero-title", payload: { name: "data-mark", value: "1" } } as Change },
    ],
    [],
  );
  expect(document.querySelector(".hero-title")!.textContent).toBe("B!");
  expect(onApplied).toHaveBeenCalledTimes(2); // 2 Change × 1 要素 × 1 回ずつ
  // MutationObserver の再スキャンでも再適用されない(WeakMap 管理)
  await new Promise((r) => setTimeout(r, 0));
  expect(onApplied).toHaveBeenCalledTimes(2);
  // SPA 的差替: 要素を作り直すと新要素にだけ再適用される
  document.body.innerHTML = `<h1 class="hero-title">re-rendered</h1>`;
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0)); // observer 発火 + microtask バッチ
  expect(document.querySelector(".hero-title")!.textContent).toBe("B!");
  expect(onApplied).toHaveBeenCalledTimes(4);
});

it("waits for missing elements via MutationObserver (spec §10.4)", async () => {
  const engine = createApplyEngine(document, { onApplied: vi.fn(), onControlSeen: vi.fn() });
  engine.start([{ experimentId: "e", variantId: "vB", change: { id: "c", type: "TEXT", selector: ".late", payload: { text: "late!" } } as Change }], []);
  const late = document.createElement("div");
  late.className = "late";
  document.body.appendChild(late);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(late.textContent).toBe("late!");
});

it("applies when an existing element gains the selector by attribute change (r1 CX-Medium-5)", async () => {
  // hydration で既存要素に class が後付けされる場合、childList 変化は起きない
  const onControlSeen = vi.fn();
  const engine = createApplyEngine(document, { onApplied: vi.fn(), onControlSeen });
  engine.start(
    [{ experimentId: "e", variantId: "vB", change: { id: "c", type: "TEXT", selector: ".hydrated", payload: { text: "hi!" } } as Change }],
    [{ experimentId: "ctrl", selectors: [".watched"] }],
  );
  const el = document.querySelector(".old-banner")!;
  el.classList.add("hydrated");
  el.setAttribute("data-x", "1");
  document.querySelector("a.cta")!.classList.add("watched");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(el.textContent).toBe("hi!");
  expect(onControlSeen).toHaveBeenCalledWith("ctrl");
});

it("notifies control watches when an exposure selector exists (spec §10.5)", () => {
  const onControlSeen = vi.fn();
  const engine = createApplyEngine(document, { onApplied: vi.fn(), onControlSeen });
  engine.start([], [{ experimentId: "exp_hero", selectors: [".nope", ".hero-title"] }, { experimentId: "exp_ghost", selectors: [".nope"] }]);
  expect(onControlSeen).toHaveBeenCalledWith("exp_hero");
  expect(onControlSeen).not.toHaveBeenCalledWith("exp_ghost");
  engine.stop(); // 次のテストの querySelector spy にこのエンジンの observer が混ざらないよう止める
});

it("control watch retires after it has fired: no re-query and no re-notify on later scans (Plan 10 B2)", async () => {
  const onControlSeen = vi.fn();
  const engine = createApplyEngine(document, { onApplied: vi.fn(), onControlSeen });
  engine.start([], [{ experimentId: "exp_hero", selectors: [".hero-title"] }, { experimentId: "exp_late", selectors: [".late-ctl"] }]);
  expect(onControlSeen).toHaveBeenCalledTimes(1); // 起動時の scan で exp_hero
  // 変異 → 再 scan: 発火済みの exp_hero は再 query も再通知もしない。未発火の exp_late は要素が現れた時点で 1 回だけ通知する
  const qs = vi.spyOn(document, "querySelector");
  const el = document.createElement("div");
  el.className = "late-ctl";
  document.body.appendChild(el);
  await tick();
  expect(onControlSeen).toHaveBeenCalledTimes(2);
  expect(onControlSeen).toHaveBeenLastCalledWith("exp_late");
  expect(qs.mock.calls.map((c) => c[0])).toContain(".late-ctl");
  expect(qs.mock.calls.map((c) => c[0])).not.toContain(".hero-title"); // 退役済み watch は querySelector されない(r1 CX-Medium-2)
  // さらに変異しても両方とも退役済みなので query も通知も無い
  qs.mockClear();
  document.body.appendChild(document.createElement("span"));
  await tick();
  expect(onControlSeen).toHaveBeenCalledTimes(2);
  expect(qs).not.toHaveBeenCalled();
  qs.mockRestore();
  engine.stop();
});

it("stop() disconnects and prevents further applies", async () => {
  const onApplied = vi.fn();
  const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() });
  engine.start([{ experimentId: "e", variantId: "vB", change: { id: "c", type: "TEXT", selector: ".late2", payload: { text: "x" } } as Change }], []);
  engine.stop();
  const el = document.createElement("div");
  el.className = "late2";
  document.body.appendChild(el);
  await new Promise((r) => setTimeout(r, 0));
  expect(el.textContent).toBe("");
});

describe("CSS (spec §11 / 決定 38)", () => {
  it("injects one <style> per change into <head> with ids and nonce, and exposes once", async () => {
    const onApplied = vi.fn();
    const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() }, { nonce: "n1" });
    engine.start([{ experimentId: "exp_css", variantId: "vB", change: { id: "c_css", type: "CSS", payload: { css: ".hero-title{color:red}" } } as Change }], []);
    const st = document.head.querySelector("style[data-ab-change='c_css']")!;
    expect(st.getAttribute("data-ab-experiment")).toBe("exp_css");
    expect(st.getAttribute("data-ab-variant")).toBe("vB");
    expect(st.getAttribute("nonce")).toBe("n1");
    expect(st.textContent).toBe(".hero-title{color:red}");
    expect(onApplied).toHaveBeenCalledTimes(1);
    document.body.innerHTML = `<p>mutate</p>`;
    await tick();
    expect(document.head.querySelectorAll("style[data-ab-change='c_css']")).toHaveLength(1); // 再スキャンで二重注入しない
    expect(onApplied).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  it("re-attaches its own removed <style> without exposing again", async () => {
    const onApplied = vi.fn();
    const state = createPageState();
    const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() }, { state });
    engine.start([{ experimentId: "exp_css", variantId: "vB", change: { id: "c_css", type: "CSS", payload: { css: ".x{}" } } as Change }], []);
    const mine = state.styles.get(changeKey("exp_css", "vB", "c_css"))!; // この engine が注入した要素に限定して消す(r1 CL-Medium-3)
    expect(mine.isConnected).toBe(true);
    mine.remove();
    document.body.appendChild(document.createElement("div")); // 何かの変異で再スキャン
    await tick();
    expect(mine.isConnected).toBe(true); // 同じ要素が戻る
    expect(document.head.querySelectorAll("style[data-ab-change='c_css']")).toHaveLength(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
    engine.stop();
  });
});

describe("HTML (spec §10.4 / §11)", () => {
  const html = (id: string, selector: string, position: "replace" | "before" | "after" | "append", h: string, runScripts = false): Change =>
    ({ id, type: "HTML", selector, payload: { html: h, position, runScripts } }) as Change;

  it("applyHtml supports the four positions and returns inserted top-level elements", () => {
    document.body.innerHTML = `<div id="w"><p class="t">orig</p></div>`;
    const p = () => document.querySelector("#w p.t")!;
    expect(applyHtml(p(), html("c1", ".t", "before", "<i>b</i>") as never)!.map((e) => e.tagName)).toEqual(["I"]);
    expect(applyHtml(p(), html("c2", ".t", "after", "<u>a</u>text") as never)!.map((e) => e.tagName)).toEqual(["U"]); // テキストノードは返さないが挿入はする
    expect(applyHtml(p(), html("c3", ".t", "append", "<b>in</b>") as never)!.map((e) => e.tagName)).toEqual(["B"]);
    expect(document.querySelector("#w")!.innerHTML).toBe(`<i>b</i><p class="t">orig<b>in</b></p><u>a</u>text`);
    expect(applyHtml(p(), html("c4", ".t", "replace", "<h2 class=\"t2\">new</h2>") as never)!.map((e) => e.tagName)).toEqual(["H2"]);
    expect(document.querySelector("#w p.t")).toBeNull();
    expect(document.querySelector("#w h2.t2")!.textContent).toBe("new");
  });

  it("applyHtml skips replace on html / head / body", () => {
    expect(applyHtml(document.body, html("c", "body", "replace", "<div>x</div>") as never)).toBeNull();
    expect(applyHtml(document.documentElement, html("c", "html", "replace", "<div>x</div>") as never)).toBeNull();
    expect(applyHtml(document.head, html("c", "head", "replace", "") as never)).toBeNull();
    expect(document.body).not.toBeNull();
  });

  it("does not re-apply to its own inserted subtree (self-matching selector)", async () => {
    document.body.innerHTML = `<ul><li class="item">1</li></ul>`;
    const onApplied = vi.fn();
    const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() });
    engine.start([{ experimentId: "e", variantId: "vB", change: html("c_self", ".item", "after", `<li class="item">2</li>`) }], []);
    await tick();
    await tick();
    expect(document.querySelectorAll("li.item")).toHaveLength(2); // 無限に増えない
    expect(onApplied).toHaveBeenCalledTimes(1);
    engine.stop();
    // replace で自分と同じ selector を持つ要素に置き換えても 1 回で止まる
    document.body.innerHTML = `<div class="hero">old</div>`;
    const engine2 = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() });
    engine2.start([{ experimentId: "e2", variantId: "vB", change: html("c_rep", ".hero", "replace", `<div class="hero">new</div>`) }], []);
    await tick();
    await tick();
    expect(document.querySelectorAll(".hero")).toHaveLength(1);
    expect(document.querySelector(".hero")!.textContent).toBe("new");
    engine2.stop();
  });

  it("runScripts:false leaves inserted <script> untouched; runScripts:true recreates it once per page (spec §10.4)", async () => {
    // 既定の happy-dom は <script> を実行しないので、ここで見るのは「作り直されたか」(cloneScript は nonce を付ける)という代理指標。
    // false なら本当に走らないことの証明は E2E 側(Task 5、`__wttInert`)が持つ(r1 CL-Medium-5)
    document.body.innerHTML = `<div id="w"><div class="slot"></div></div><template id="tpl"><div class="slot"></div></template>`;
    const onApplied = vi.fn();
    const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() }, { nonce: "n1" });
    engine.start(
      [
        { experimentId: "e", variantId: "vB", change: html("c_inert", ".slot", "append", `<script data-k="inert">window.__x=1</script>`) },
        { experimentId: "e", variantId: "vB", change: html("c_run", ".slot", "append", `<script data-k="run">window.__y=1</script>`, true) },
      ],
      [],
    );
    expect(document.querySelector("script[data-k='inert']")!.hasAttribute("nonce")).toBe(false);
    expect(document.querySelector("script[data-k='run']")!.getAttribute("nonce")).toBe("n1");
    expect(onApplied).toHaveBeenCalledTimes(2);
    // SPA 再描画: DOM は再挿入されるが <script> は作り直されない(不活性のまま)。実行済み Set は changeKey 単位で 1 回のまま
    const tpl = document.getElementById("tpl") as HTMLTemplateElement;
    document.getElementById("w")!.replaceChildren(tpl.content.cloneNode(true));
    await tick();
    expect(document.querySelectorAll("script[data-k='run']")).toHaveLength(1);
    expect(document.querySelector("script[data-k='run']")!.hasAttribute("nonce")).toBe(false); // 再適用では activateScripts を呼ばない
    engine.stop();
  });

  it("marks the recreated <script> so a self-matching selector does not re-apply (Plan 10 B2: mark after activateScripts)", async () => {
    // selector が挿入した <script> 自身に一致するケース。activateScripts は <script> を新要素に差し替えるため、
    // 差し替え前にマークすると新要素が未マークのまま残り、次の scan で同じ Change がもう 1 本挿入される
    document.body.innerHTML = `<div id="w"><script class="hook" data-k="orig"></script></div>`;
    const onApplied = vi.fn();
    const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() }, { nonce: "n1" });
    engine.start([{ experimentId: "e", variantId: "vB", change: html("c_hook", "script.hook", "after", `<script class="hook" data-k="added">window.__z=1</script>`, true) }], []);
    document.body.appendChild(document.createElement("span")); // observer 登録後の変異で再 scan を起こす(起動時 scan 中の差し替えは observer 登録前なので、これが無いと再 scan が走らず修正前でも通る。r1 CX-High-1)
    await tick();
    await tick();
    expect(document.querySelectorAll("script.hook")).toHaveLength(2); // 元 1 + 挿入 1(差し替え後のクローン)。修正前は 3 本に増える
    expect(document.querySelector("script[data-k='added']")!.getAttribute("nonce")).toBe("n1"); // 残っているのはクローン
    expect(onApplied).toHaveBeenCalledTimes(1);
    engine.stop();
  });
});

describe("CUSTOM_JS (spec §10.4 / §11)", () => {
  it("attempts once per page on the first matching element and never retries after failure", async () => {
    // 既定の happy-dom は <script> を実行しないため登録が取れず ok:false になる — その場合でも試行済みとして再試行しない
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    document.body.innerHTML = `<p class="t">1</p><p class="t">2</p>`;
    const onApplied = vi.fn();
    const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() });
    engine.start([{ experimentId: "e", variantId: "vB", change: { id: "c_js", type: "CUSTOM_JS", selector: ".t", payload: { code: "element.textContent='x'" } } as Change }], []);
    expect(onApplied).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    document.body.appendChild(document.createElement("div"));
    await tick();
    expect(debug).toHaveBeenCalledTimes(1); // 再スキャンで再試行しない
    expect(document.querySelectorAll("script")).toHaveLength(0); // 登録用 <script> は残さない
    engine.stop();
    debug.mockRestore();
  });

  it("waits for the element before attempting", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const engine = createApplyEngine(document, { onApplied: vi.fn(), onControlSeen: vi.fn() });
    engine.start([{ experimentId: "e", variantId: "vB", change: { id: "c_js", type: "CUSTOM_JS", selector: ".late-js", payload: { code: "1" } } as Change }], []);
    expect(debug).not.toHaveBeenCalled(); // 要素が無い間は試行しない(試行済みにもしない)
    const el = document.createElement("div");
    el.className = "late-js";
    document.body.appendChild(el);
    await tick();
    expect(debug).toHaveBeenCalledTimes(1); // 要素が現れたら 1 回だけ試行
    engine.stop();
    debug.mockRestore();
  });
});

describe("状態のキーと例外境界(r1 CX-High-2 / CX-High-3)", () => {
  it("same_change_id_in_different_experiments_applies_independently", () => {
    // Change ID は Variant 内でしか一意でない(D1 PK)。ページ単位の状態は experiment/variant/change の組で引く
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const onApplied = vi.fn();
    const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() });
    engine.start(
      [
        { experimentId: "exp_a", variantId: "vB", change: { id: "c1", type: "CSS", payload: { css: ".a{}" } } as Change },
        { experimentId: "exp_b", variantId: "vB", change: { id: "c1", type: "CSS", payload: { css: ".b{}" } } as Change },
        { experimentId: "exp_c", variantId: "vB", change: { id: "c2", type: "CUSTOM_JS", selector: ".hero-title", payload: { code: "1" } } as Change },
        { experimentId: "exp_d", variantId: "vB", change: { id: "c2", type: "CUSTOM_JS", selector: ".cta", payload: { code: "1" } } as Change },
      ],
      [],
    );
    expect(document.head.querySelectorAll("style[data-ab-change='c1']")).toHaveLength(2);
    expect(document.head.querySelector("style[data-ab-experiment='exp_b']")!.textContent).toBe(".b{}");
    expect(onApplied.mock.calls.map((c) => c[0])).toEqual(["exp_a", "exp_b"]); // CSS は 2 つとも Exposure
    expect(debug).toHaveBeenCalledTimes(2); // CUSTOM_JS も 2 つとも試行(既定環境では登録が取れず失敗を記録)
    engine.stop();
    debug.mockRestore();
  });

  it("composite_key_does_not_collide_on_slash_in_ids", () => {
    // r2 CX-High-2: core の ID は min(1) だけなので "/" を含み得る。JSON 配列のキーなら e/x + vB と e + x/vB は別物
    const onApplied = vi.fn();
    const engine = createApplyEngine(document, { onApplied, onControlSeen: vi.fn() });
    engine.start(
      [
        { experimentId: "e/x", variantId: "vB", change: { id: "c", type: "CSS", payload: { css: ".a{}" } } as Change },
        { experimentId: "e", variantId: "x/vB", change: { id: "c", type: "CSS", payload: { css: ".b{}" } } as Change },
      ],
      [],
    );
    const sheets = Array.from(document.head.querySelectorAll("style[data-ab-change='c']"));
    expect(sheets.map((s) => s.textContent)).toEqual([".a{}", ".b{}"]);
    expect(onApplied.mock.calls.map((c) => c[0])).toEqual(["e/x", "e"]);
    engine.stop();
  });

  it("code_change_failure_does_not_stop_later_changes", async () => {
    // CUSTOM_JS の要素生成失敗(Trusted Types 相当)と CSS の注入失敗の後も、後続の TEXT と対照 watch は続き、再試行しない(§10.7)
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const orig = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      if (tag === "script" || tag === "style") throw new TypeError("blocked");
      return orig(tag);
    }) as typeof document.createElement);
    const onApplied = vi.fn();
    const onControlSeen = vi.fn();
    const engine = createApplyEngine(document, { onApplied, onControlSeen });
    engine.start(
      [
        { experimentId: "e1", variantId: "vB", change: { id: "c_js", type: "CUSTOM_JS", selector: ".hero-title", payload: { code: "1" } } as Change },
        { experimentId: "e2", variantId: "vB", change: { id: "c_css", type: "CSS", payload: { css: ".x{}" } } as Change },
        { experimentId: "e3", variantId: "vB", change: { id: "c_text", type: "TEXT", selector: ".hero-title", payload: { text: "after" } } as Change },
      ],
      [{ experimentId: "ctrl", selectors: [".cta"] }],
    );
    expect(document.querySelector(".hero-title")!.textContent).toBe("after"); // 後続の TEXT は適用される
    expect(onApplied.mock.calls.map((c) => c[0])).toEqual(["e3"]);
    expect(onControlSeen).toHaveBeenCalledWith("ctrl"); // 対照 watch も続く
    expect(debug).toHaveBeenCalledTimes(2); // CUSTOM_JS(runCustomJs 内で捕捉)と CSS(scan の境界で捕捉)の失敗を 1 回ずつ記録
    document.body.appendChild(orig("div"));
    await tick();
    expect(debug).toHaveBeenCalledTimes(2); // 再スキャンで再試行しない(試行済み)
    engine.stop();
    createSpy.mockRestore();
    debug.mockRestore();
  });
});
