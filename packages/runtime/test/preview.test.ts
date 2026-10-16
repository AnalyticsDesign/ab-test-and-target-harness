import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createPreviewEngine, parsePreviewHash } from "../src/preview";
import { createRuntime, type RuntimeDeps } from "../src/runtime";
import { baseConfig, baseSettings } from "./fixtures";
import { executableDocument, spyPageConsoleError } from "./dom";

/**
 * preview の engine は「1 ページ = 1 engine」なので MutationObserver を外さない(§10.8)。
 * unit は 1 つの document を共有するため、テストが作った observer をここで後始末する
 * (残ると次のテストの body 差し替えに古い engine が反応してしまう)
 */
const RealMutationObserver = MutationObserver;
const observers: MutationObserver[] = [];
class TrackedMutationObserver extends RealMutationObserver {
  constructor(cb: MutationCallback) {
    super(cb);
    observers.push(this);
  }
}
beforeEach(() => {
  vi.stubGlobal("MutationObserver", TrackedMutationObserver);
});
afterEach(() => {
  for (const o of observers) o.disconnect();
  observers.length = 0;
  vi.unstubAllGlobals();
});
// 決定 50: プレビューの処理は別ファイル(preview-entry.ts が self.__WTT_PREVIEW__ に置く)。
// 下書きの bootstrap は先頭に埋め込むので、起動時には読み込み口が既にある。単体テストもその状態から始める
beforeEach(() => {
  (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__ = createPreviewEngine;
});
afterEach(() => {
  delete (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__;
});

describe("parsePreviewHash (spec §12.3 (a) / 決定 39 (4) (9))", () => {
  it("フラグメントの先頭が __ab_preview のときだけ preview になる", () => {
    expect(parsePreviewHash("#__ab_preview=exp_hero:vB")).toEqual({
      preview: true,
      requests: [{ experimentId: "exp_hero", variantId: "vB" }],
    });
    expect(parsePreviewHash("#__ab_preview=exp_a:B,exp_b:A")).toEqual({
      preview: true,
      requests: [
        { experimentId: "exp_a", variantId: "B" },
        { experimentId: "exp_b", variantId: "A" },
      ],
    });
    // URL エンコードは解く(ID は core では任意文字列)
    expect(parsePreviewHash("#__ab_preview=exp%20a:v%2FB")).toEqual({ preview: true, requests: [{ experimentId: "exp a", variantId: "v/B" }] });
    // Experiment ID に ":" があっても最後の ":" で割る
    expect(parsePreviewHash("#__ab_preview=ns:exp:vB")).toEqual({ preview: true, requests: [{ experimentId: "ns:exp", variantId: "vB" }] });
    // preview ではないもの
    expect(parsePreviewHash("")).toEqual({ preview: false, requests: [] });
    expect(parsePreviewHash("#section")).toEqual({ preview: false, requests: [] });
    expect(parsePreviewHash("#foo&__ab_preview=exp:v")).toEqual({ preview: false, requests: [] }); // 先頭でなければ preview にしない
  });

  it("不正な入力でも preview に入り(fail-closed)、要求は error 行になる", () => {
    // 決定 39 (9): #__ab_preview で始まれば常に隔離モード。空でも「何も適用しない preview」
    expect(parsePreviewHash("#__ab_preview")).toEqual({
      preview: true,
      requests: [{ experimentId: "", variantId: "", error: "invalid preview request" }],
    });
    expect(parsePreviewHash("#__ab_preview=")).toEqual({
      preview: true,
      requests: [{ experimentId: "", variantId: "", error: "invalid preview request" }],
    });
    // ":" が無い / 片側が空の項目は適用しない
    expect(parsePreviewHash("#__ab_preview=exp_only")).toEqual({
      preview: true,
      requests: [{ experimentId: "exp_only", variantId: "", error: "invalid preview request" }],
    });
    expect(parsePreviewHash("#__ab_preview=exp_a:B,:vX")).toEqual({
      preview: true,
      requests: [
        { experimentId: "exp_a", variantId: "B" },
        { experimentId: ":vX", variantId: "", error: "invalid preview request" },
      ],
    });
    // "=" で始まらない残りも 1 つの不正な要求として扱う
    expect(parsePreviewHash("#__ab_previewX")).toEqual({
      preview: true,
      requests: [{ experimentId: "X", variantId: "", error: "invalid preview request" }],
    });
    // 同一 Experiment の 2 つ目以降は duplicate(最初の指定だけを採用する)
    expect(parsePreviewHash("#__ab_preview=exp_a:B,exp_a:A")).toEqual({
      preview: true,
      requests: [
        { experimentId: "exp_a", variantId: "B" },
        { experimentId: "exp_a", variantId: "A", error: "duplicate experiment" },
      ],
    });
  });
});

/** preview は通信も Cookie も使わないので、fetch は「呼ばれたら失敗」にする */
const forbiddenFetch = ((..._a: unknown[]) => {
  throw new Error("preview must not fetch");
}) as unknown as typeof fetch;

function previewDeps(hash: string): RuntimeDeps {
  window.location.hash = hash;
  return { win: window as RuntimeDeps["win"], doc: document, fetchFn: forbiddenFetch, scriptSrc: "https://edge.test/s/site_unit.js", nonce: null };
}

/** exp_hero(vB は .hero-title への TEXT)+ 当たらない selector と CSS を足した config */
const previewConfig = {
  ...baseConfig,
  experiments: [
    baseConfig.experiments[0]!,
    {
      id: "exp_preview",
      name: "Preview",
      urlMatch: { op: "contains", value: "/" },
      trafficPercentage: 100,
      persistAssignment: false,
      variants: [
        { id: "vA", name: "A", weight: 50, changes: [] },
        {
          id: "vB",
          name: "B",
          weight: 50,
          changes: [
            { id: "c_hit", type: "TEXT", selector: ".preview-title", payload: { text: "適用" } },
            { id: "c_miss", type: "TEXT", selector: ".no-such-title", payload: { text: "never" } },
            { id: "c_css", type: "CSS", payload: { css: ".preview-title{color:red}" } },
          ],
        },
      ],
    },
  ],
  prehide: { ...baseConfig.prehide, exp_preview: [".preview-title", ".no-such-title"] },
  exposureSelectors: { ...baseConfig.exposureSelectors, exp_preview: [".preview-title", ".no-such-title", ":root"] },
} as typeof baseConfig;

describe("preview mode (spec §12.3 (a) / §10.8)", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<h1 class="hero-title">元</h1><h2 class="preview-title">元</h2>`;
    (window as unknown as { dataLayer?: unknown[] }).dataLayer = [];
    for (const c of document.cookie.split(/;\s*/)) if (c) document.cookie = `${c.split("=")[0]}=; Path=/; Max-Age=0`;
    window.location.hash = "";
  });

  it("preview_applies_only_listed_experiments", () => {
    const api = createRuntime(previewDeps("#__ab_preview=exp_preview:vB"), { config: previewConfig, settings: baseSettings });
    expect(document.querySelector(".preview-title")!.textContent).toBe("適用");
    expect(document.querySelector(".hero-title")!.textContent).toBe("元"); // 指定外の exp_hero は動かない
    expect(document.head.querySelector("style[data-ab-change='c_css']")).not.toBeNull();
    expect(document.getElementById("__ab_prehide")).toBeNull(); // prehide は張って剥がす
    expect((window as unknown as { dataLayer: unknown[] }).dataLayer).toHaveLength(0); // Exposure なし
    expect(document.cookie).toBe(""); // Identity を作らない
    expect(api.getAssignments()).toEqual({ exp_preview: "vB" });
  });

  it("preview_applies_in_config_order", () => {
    // 決定 51: 指定の順(優先の高い方を先に書いた)に関係なく、config の並び(後ろほど優先)の順に適用する
    const config = {
      ...baseConfig,
      experiments: [
        { id: "exp_low", name: "Low", urlMatch: { op: "contains", value: "/" }, trafficPercentage: 100, persistAssignment: false, variants: [{ id: "a", name: "A", weight: 100, changes: [{ id: "c", type: "TEXT", selector: ".hero-title", payload: { text: "S" } }] }] },
        { id: "exp_high", name: "High", urlMatch: { op: "contains", value: "/" }, trafficPercentage: 100, persistAssignment: false, variants: [{ id: "vA", name: "A", weight: 50, changes: [] }, { id: "vB", name: "B", weight: 50, changes: [{ id: "c", type: "TEXT", selector: ".hero-title", payload: { text: "T" } }] }] },
      ],
      prehide: { exp_low: [".hero-title"], exp_high: [".hero-title"] },
      exposureSelectors: { exp_low: [".hero-title"], exp_high: [".hero-title"] },
    } as typeof baseConfig;
    createRuntime(previewDeps("#__ab_preview=exp_high:vB,exp_low:a"), { config, settings: baseSettings });
    expect(document.querySelector(".hero-title")!.textContent).toBe("T");
  });

  it("preview の report は外れた selector を matched 0 / applied false で返す", () => {
    // §18.1 の同名テストは E2E(Task 8)。ここは同じ判定を unit で先に固定する
    const api = createRuntime(previewDeps("#__ab_preview=exp_preview:vB"), { config: previewConfig, settings: baseSettings });
    const report = api.getPreviewReport()!;
    expect(report).toHaveLength(1);
    expect(report[0]!.experimentId).toBe("exp_preview");
    expect(report[0]!.changes).toEqual([
      { changeId: "c_hit", type: "TEXT", selector: ".preview-title", matched: 1, applied: true },
      { changeId: "c_miss", type: "TEXT", selector: ".no-such-title", matched: 0, applied: false },
      { changeId: "c_css", type: "CSS", matched: 1, applied: true },
    ]);
  });

  it("preview_report_updates_on_reapplication", async () => {
    const api = createRuntime(previewDeps("#__ab_preview=exp_preview:vB"), { config: previewConfig, settings: baseSettings });
    expect(api.getPreviewReport()![0]!.changes[1]).toMatchObject({ matched: 0, applied: false });
    const el = document.createElement("p");
    el.className = "no-such-title";
    document.body.appendChild(el); // 後から現れる(§10.4 の再適用)
    await new Promise((r) => setTimeout(r, 0));
    expect(api.getPreviewReport()![0]!.changes[1]).toMatchObject({ matched: 1, applied: true });
    expect(el.textContent).toBe("never");
  });

  it("preview_reports_unknown_experiment", () => {
    const api = createRuntime(previewDeps("#__ab_preview=exp_nope:vB,exp_preview:vZ"), { config: previewConfig, settings: baseSettings });
    expect(api.getPreviewReport()).toEqual([
      { experimentId: "exp_nope", variantId: "vB", changes: [], error: "unknown experiment or variant" },
      { experimentId: "exp_preview", variantId: "vZ", changes: [], error: "unknown experiment or variant" },
    ]);
  });

  it("preview_enters_isolation_for_malformed_hash", () => {
    // 決定 39 (9): 空でも ":" 無しでも隔離モードのまま。何も適用せず error 行だけを返す
    const empty = createRuntime(previewDeps("#__ab_preview="), { config: previewConfig, settings: baseSettings });
    expect(empty.getPreviewReport()).toEqual([{ experimentId: "", variantId: "", changes: [], error: "invalid preview request" }]);
    expect(document.querySelector(".preview-title")!.textContent).toBe("元");
    expect(document.querySelector(".hero-title")!.textContent).toBe("元");
    expect(empty.getAssignments()).toEqual({});
    expect((window as unknown as { dataLayer: unknown[] }).dataLayer).toHaveLength(0); // Exposure なし
    expect(document.cookie).toBe(""); // Identity を作らない

    const bad = createRuntime(previewDeps("#__ab_preview=exp_only"), { config: previewConfig, settings: baseSettings });
    expect(bad.getPreviewReport()).toEqual([{ experimentId: "exp_only", variantId: "", changes: [], error: "invalid preview request" }]);
    expect(document.querySelector(".hero-title")!.textContent).toBe("元");
    expect((window as unknown as { dataLayer: unknown[] }).dataLayer).toHaveLength(0);
    expect(document.cookie).toBe("");
  });

  it("preview_reports_duplicate_experiment", () => {
    // 同一 Experiment の 2 つ目以降は適用も割当への反映もしない(決定 39 (9))
    const api = createRuntime(previewDeps("#__ab_preview=exp_preview:vB,exp_preview:vA"), { config: previewConfig, settings: baseSettings });
    expect(document.querySelector(".preview-title")!.textContent).toBe("適用"); // 最初の指定(vB)が勝つ
    expect(api.getAssignments()).toEqual({ exp_preview: "vB" });
    const report = api.getPreviewReport()!;
    expect(report).toHaveLength(2);
    expect(report[0]!.experimentId).toBe("exp_preview");
    expect(report[0]!.variantId).toBe("vB");
    expect(report[1]).toEqual({ experimentId: "exp_preview", variantId: "vA", changes: [], error: "duplicate experiment" });
  });

  it("通常モードの getPreviewReport は null(§10.8)", () => {
    const api = createRuntime(previewDeps(""), { config: previewConfig, settings: baseSettings });
    expect(api.getPreviewReport()).toBeNull();
  });
});

/** HTML が挿入した部分木に自分の selector が含まれる config(自己再適用の連鎖を作る形) */
const loopConfig = {
  ...baseConfig,
  prehide: {},
  exposureSelectors: {},
  experiments: [
    {
      id: "exp_loop",
      name: "Loop",
      urlMatch: { op: "contains", value: "/" },
      trafficPercentage: 100,
      persistAssignment: false,
      variants: [
        { id: "vA", name: "A", weight: 50, changes: [] },
        {
          id: "vB",
          name: "B",
          weight: 50,
          changes: [
            { id: "c_loop", type: "HTML", selector: ".loop", payload: { html: '<section><div class="loop"></div></section>', position: "append", runScripts: false } },
          ],
        },
      ],
    },
  ],
} as typeof baseConfig;

/** IMAGE / HTML の <script> / CUSTOM_JS の失敗を report に載せることを見る config(§10.8) */
const errorConfig = {
  ...baseConfig,
  prehide: {},
  exposureSelectors: {},
  experiments: [
    {
      id: "exp_err",
      name: "Errors",
      urlMatch: { op: "contains", value: "/" },
      trafficPercentage: 100,
      persistAssignment: false,
      variants: [
        { id: "vA", name: "A", weight: 50, changes: [] },
        {
          id: "vB",
          name: "B",
          weight: 50,
          changes: [
            { id: "c_img", type: "IMAGE", selector: "img.pic", payload: { src: "https://img.test/new.png" } },
            { id: "c_inline", type: "HTML", selector: ".slot-inline", payload: { html: `<scr${"ipt"}>throw new Error('boom')</scr${"ipt"}>`, position: "append", runScripts: true } },
            { id: "c_src", type: "HTML", selector: ".slot-src", payload: { html: `<scr${"ipt"} src="https://img.test/missing.js"></scr${"ipt"}>`, position: "append", runScripts: true } },
            // 読込には成功するが、後から(タイマーで)throw する src スクリプト(§10.8 の非同期な帰属)
            {
              id: "c_async",
              type: "HTML",
              selector: ".slot-async",
              payload: {
                html: `<scr${"ipt"} src="data:text/javascript,setTimeout(()=>{throw new Error('late')})"></scr${"ipt"}>`,
                position: "append",
                runScripts: true,
              },
            },
            { id: "c_js_throw", type: "CUSTOM_JS", selector: ".slot-js", payload: { code: "throw new Error('custom boom')" } },
            { id: "c_js_blocked", type: "CUSTOM_JS", selector: ".slot-blocked", payload: { code: "this is not javascript(" } },
          ],
        },
      ],
    },
  ],
} as typeof baseConfig;

describe("preview の適用結果(spec §10.8 / §10.4)", () => {
  it("preview_html_does_not_reapply_to_inserted_descendants", async () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<div class="loop"></div>`;
    const engine = createPreviewEngine(document, loopConfig, [{ experimentId: "exp_loop", variantId: "vB" }], null);
    engine.start();
    expect(document.querySelectorAll(".loop")).toHaveLength(2); // 元の 1 つ + 挿入した 1 つ
    // 別の DOM 変異で再スキャンが走っても増えない(挿入した子孫を適用済みにしているため)
    for (let i = 0; i < 3; i++) {
      document.body.appendChild(document.createElement("span"));
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(document.querySelectorAll(".loop")).toHaveLength(2);
    expect(engine.reports()[0]!.changes[0]!.applied).toBe(true);
  });
});

describe("preview の report は適用の失敗を載せる(spec §10.8)", () => {
  const rowOf = (engine: { reports(): Array<{ changes: Array<{ changeId: string }> }> }, id: string) =>
    engine.reports()[0]!.changes.find((c) => c.changeId === id)! as {
      changeId: string;
      matched: number;
      applied: boolean;
      error?: string;
    };

  /** <script> を実行できる Document で engine を起動する(MutationObserver もその Window のものを使う) */
  function startErrors(): { win: ReturnType<typeof executableDocument>["win"]; doc: Document; engine: ReturnType<typeof createPreviewEngine> } {
    const { win, doc } = executableDocument();
    doc.body.innerHTML =
      `<img class="pic" src="https://img.test/old.png" /><div class="slot-inline"></div><div class="slot-src"></div>` +
      `<div class="slot-async"></div><div class="slot-js"></div><div class="slot-blocked"></div>`;
    vi.stubGlobal("MutationObserver", win.MutationObserver); // engine は global の MutationObserver を使う
    const engine = createPreviewEngine(doc, errorConfig, [{ experimentId: "exp_err", variantId: "vB" }], null);
    engine.start();
    return { win, doc, engine };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("IMAGE の読込失敗は applied: false / error に落ちる(非同期の更新)", () => {
    const { win, doc, engine } = startErrors();
    expect(rowOf(engine, "c_img")).toMatchObject({ matched: 1, applied: true }); // src 差し替えは同期的に成功
    doc.querySelector("img.pic")!.dispatchEvent(new win.Event("error") as unknown as Event); // 実ブラウザでは読込失敗で発火
    expect(rowOf(engine, "c_img")).toMatchObject({ applied: false, error: "image load failed" });
  });

  it("HTML 内の inline <script> の例外が error に入る", () => {
    const { engine } = startErrors();
    expect(rowOf(engine, "c_inline").applied).toBe(true); // DOM 挿入自体は成功している
    expect(rowOf(engine, "c_inline").error).toContain("boom");
  });

  it("HTML 内の <script src> の読込失敗が error に入る(非同期の更新)", () => {
    const { win, doc, engine } = startErrors();
    const s = doc.querySelector(".slot-src script") as HTMLScriptElement;
    expect(s.getAttribute("src")).toBe("https://img.test/missing.js");
    s.dispatchEvent(new win.Event("error") as unknown as Event);
    expect(rowOf(engine, "c_src").error).toContain("script load failed");
  });

  it("preview_reports_async_html_script_exception", () => {
    // §10.8 / CX-High-3: 読込に成功した src スクリプトが**後から**投げた例外も、その Change の行に反映する。
    // window の error リスナはページ寿命で 1 つ保持しているので、差し替えが終わった後の例外も届く
    const { win, doc, engine } = startErrors();
    expect(rowOf(engine, "c_async")).toMatchObject({ matched: 1, applied: true }); // 挿入と差し替えは成功している
    const fresh = doc.querySelector(".slot-async script") as HTMLScriptElement;
    expect(fresh.src).toContain("data:text/javascript,"); // 帰属の鍵になる絶対 URL
    // 実ブラウザではタイマーの throw が window の error として上がる。filename は当該スクリプトの URL
    const fire = (message: string, filename: string): void =>
      void (win as unknown as EventTarget).dispatchEvent(new win.ErrorEvent("error", { message, filename }) as unknown as Event);
    fire("Uncaught Error: late", fresh.src);
    expect(rowOf(engine, "c_async")).toMatchObject({ applied: false });
    expect(rowOf(engine, "c_async").error).toContain("late");
    // 帰属できない例外(inline のタイマー等 = filename がページ自身)は report を汚さない
    fire("unrelated", doc.location.href);
    expect(rowOf(engine, "c_inline").error).not.toContain("unrelated");
    expect(rowOf(engine, "c_async").error).toContain("late");
  });

  it("CUSTOM_JS の例外が error に入る", () => {
    const { engine } = startErrors();
    expect(rowOf(engine, "c_js_throw")).toMatchObject({ matched: 1, applied: false });
    expect(rowOf(engine, "c_js_throw").error).toContain("custom boom");
  });

  it("CUSTOM_JS が登録されない(CSP ブロック / 構文エラー)と error に入る", () => {
    const { engine } = startErrors();
    expect(rowOf(engine, "c_js_blocked")).toMatchObject({ matched: 1, applied: false });
    expect(rowOf(engine, "c_js_blocked").error).toContain("not registered");
  });
});

/** nonce の引継ぎを見る config: <style> を作る CSS と、clone した <script> が残る HTML(§11) */
const nonceConfig = {
  ...baseConfig,
  prehide: {},
  exposureSelectors: {},
  experiments: [
    {
      id: "exp_nonce",
      name: "Nonce",
      urlMatch: { op: "contains", value: "/" },
      trafficPercentage: 100,
      persistAssignment: false,
      variants: [
        { id: "vA", name: "A", weight: 50, changes: [] },
        {
          id: "vB",
          name: "B",
          weight: 50,
          changes: [
            { id: "c_css", type: "CSS", payload: { css: ".preview-title{color:red}" } },
            {
              id: "c_html",
              type: "HTML",
              selector: ".nonce-slot",
              payload: { html: `<scr${"ipt"} src="https://img.test/x.js"></scr${"ipt"}>`, position: "append", runScripts: true },
            },
          ],
        },
      ],
    },
  ],
} as typeof baseConfig;

describe("preview の起動 lifecycle(§13.10 レシピ 2 の addInitScript 注入)", () => {
  /**
   * 読込中(readyState: loading)の Document。`hasDom: false` なら documentElement / head も未生成にする
   * (Playwright の addInitScript 直後の状態。Chromium では空の <html><head> が既にあることもある)
   */
  function pendingDocument(body: string, hasDom = false): { doc: Document; ready: () => void } {
    const doc = document.implementation.createHTMLDocument("t");
    const root = doc.documentElement;
    const head = doc.head;
    doc.body.innerHTML = body; // getter を差す前に用意する(documentElement を隠すと body も辿れなくなる)
    const bodyEl = doc.body;
    let ready = false;
    Object.defineProperty(doc, "documentElement", { configurable: true, get: () => (ready || hasDom ? root : null) });
    Object.defineProperty(doc, "head", { configurable: true, get: () => (ready || hasDom ? head : null) });
    Object.defineProperty(doc, "body", { configurable: true, get: () => bodyEl });
    Object.defineProperty(doc, "readyState", { configurable: true, get: () => (ready ? "complete" : "loading") });
    return {
      doc,
      ready: () => {
        ready = true;
        doc.dispatchEvent(new Event("readystatechange"));
      },
    };
  }

  it("documentElement が無い時点で注入されても readystatechange の後に適用する", () => {
    // addInitScript はページのどのスクリプトより先に走る = documentElement も head もまだ無い
    const { doc, ready } = pendingDocument(`<h2 class="preview-title">元</h2>`);
    const deps = { ...previewDeps("#__ab_preview=exp_preview:vB"), doc };
    const api = createRuntime(deps, { config: previewConfig, settings: baseSettings });
    expect(doc.querySelector(".preview-title")!.textContent).toBe("元"); // まだ何も適用していない(例外も出ていない)
    expect(api.getPreviewReport()).toEqual([]); // engine は begin() で作る(nonce を DOM 準備後に解決するため)。preview なので非 null

    ready();
    expect(doc.querySelector(".preview-title")!.textContent).toBe("適用");
    expect(api.getPreviewReport()![0]!.changes[0]).toMatchObject({ matched: 1, applied: true });
  });

  it("二重起動は no-op(先に走った下書きの bootstrap が勝つ)", async () => {
    const g = globalThis as unknown as { __WTT_BOOT__?: unknown; __WTT_BOOTED__?: boolean };
    delete g.__WTT_BOOTED__;
    document.head.innerHTML = "";
    document.body.innerHTML = `<h1 class="hero-title">元</h1><h2 class="preview-title">元</h2>`;
    window.location.hash = "#__ab_preview=exp_preview:vB";

    // 1 回目 = addInitScript で注入した下書きの bootstrap
    g.__WTT_BOOT__ = { config: previewConfig, settings: baseSettings };
    vi.resetModules();
    await import("../src/index");
    const first = (window as unknown as { AB: { getPreviewReport(): Array<{ experimentId: string; changes: unknown[] }> | null } }).AB;
    expect(first.getPreviewReport()![0]!.experimentId).toBe("exp_preview");

    // 2 回目 = ページの設置タグ(下書きを含まない公開 config)。AB も report も上書きされない
    g.__WTT_BOOT__ = { config: baseConfig, settings: baseSettings };
    vi.resetModules();
    await import("../src/index");
    expect((window as unknown as { AB: unknown }).AB).toBe(first);
    expect(first.getPreviewReport()![0]!.changes[0]).toMatchObject({ matched: 1, applied: true });
    delete g.__WTT_BOOTED__;
  });

  it("後から設置タグが残した __WTT_NONCE__ を begin 時に引き継ぐ", () => {
    // CX-High-6: 注入した下書きには currentScript が無く nonce が取れない。<head> が既にあっても
    // 読込中(readyState: loading)なら設置タグの実行を待ち、begin() はそれが置いた __WTT_NONCE__ を使う
    const g = window as unknown as { __WTT_NONCE__?: string | null };
    delete g.__WTT_NONCE__;
    const { doc, ready } = pendingDocument(`<h2 class="preview-title">元</h2><div class="nonce-slot"></div>`, true); // <head> は最初からある

    // 1 回目 = 注入した下書き(nonce なしで起動する)。readyState: loading なのでまだ適用しない
    const deps = { ...previewDeps("#__ab_preview=exp_nonce:vB"), doc };
    createRuntime(deps, { config: nonceConfig, settings: baseSettings });
    expect(doc.head.querySelector("style[data-ab-change='c_css']")).toBeNull();
    // 2 回目 = ページの設置タグ。起動はしないが nonce だけ置いていく(index.ts Step 5)
    g.__WTT_NONCE__ = "wttE2E";

    // vitest の happy-dom は外部スクリプトを読まず、接続した時点でページの console.error に記録して error を出す。
    // 記録を握って出力を汚さず、差し替えた <script> が実際に読込を試みた(= 有効な clone になった)ことを確かめる
    const consoleError = spyPageConsoleError();
    try {
      ready();
      expect(consoleError.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('Failed to load script "https://img.test/x.js"')]);
    } finally {
      consoleError.mockRestore();
    }
    const style = doc.head.querySelector("style[data-ab-change='c_css']")!;
    expect(style.getAttribute("nonce")).toBe("wttE2E");
    expect((style as HTMLStyleElement).nonce).toBe("wttE2E");
    const script = doc.querySelector(".nonce-slot script")!;
    expect(script.getAttribute("nonce")).toBe("wttE2E");
    delete g.__WTT_NONCE__;
  });
});

describe("プレビューの処理を別ファイルから読む(決定 50)", () => {
  const removeLoaders = (): void => document.querySelectorAll('script[src*="/s/preview/"]').forEach((el) => el.remove());
  // vitest の happy-dom は外部スクリプトを読まず、append した時点で同期にページの console.error へ記録して error を出す。
  // 記録を握って出力を汚さず、どの URL の読込を試みたかを確かめる(期待しない読込失敗も見逃さない)
  let consoleError: MockInstance<typeof console.error>;
  const loadFailures = (): string[] => consoleError.mock.calls.map((c) => String(c[0]));
  beforeEach(() => {
    consoleError = spyPageConsoleError();
  });
  afterEach(() => {
    removeLoaders();
    vi.restoreAllMocks();
  });
  /**
   * 期限のテスト用: <head> に入る <script> を挿入せずに握る(happy-dom が同期に error を出すと期限の分岐に届かないため)。
   * load / error はテストが握った要素に自分で発火させる。prehide の <style> などはそのまま挿入する
   */
  function holdScripts(): HTMLScriptElement[] {
    const held: HTMLScriptElement[] = [];
    const append = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        held.push(node);
        return node;
      }
      return append(node);
    });
    return held;
  }

  it("preview_url_is_under_documented_route_prefix(既定の Route の /s/* の下 = Route を増やさずに edge に届く)", () => {
    delete (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__;
    try {
      createRuntime(previewDeps("#__ab_preview=exp_hero:vB"), { config: baseConfig, settings: baseSettings });
      const script = document.querySelector<HTMLScriptElement>('script[src*="/preview/"]');
      expect(new URL(script!.src).pathname.startsWith("/s/")).toBe(true);
      expect(loadFailures()).toEqual([expect.stringContaining(script!.src)]);
    } finally {
      window.location.hash = "";
    }
  });

  it("preview_file_follows_script_src_not_api_base", () => {
    // 決定 52 (7): プレビューのファイルは配信専用の Worker(設置タグのホスト)の asset。apiBase(edge)には向けない
    delete (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__;
    try {
      createRuntime(previewDeps("#__ab_preview=exp_hero:vB"), { config: baseConfig, settings: baseSettings, apiBase: "https://api.example" });
      const script = document.querySelector<HTMLScriptElement>('script[src*="/s/preview/"]');
      expect(script?.src).toBe("https://edge.test/s/preview/test.js");
      expect(loadFailures()).toEqual([expect.stringContaining(script!.src)]);
    } finally {
      window.location.hash = "";
    }
  });
  it("読み込み口が無ければ edge の /s/preview/<hash>.js を設置タグの nonce 付きで読む。読めなければ prehide を外して何も適用しない", () => {
    delete (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__;
    document.body.innerHTML = `<h1 class="hero-title">orig</h1>`;
    try {
      const api = createRuntime({ ...previewDeps("#__ab_preview=exp_hero:vB"), nonce: "n0nce" }, { config: baseConfig, settings: baseSettings });
      const script = document.querySelector<HTMLScriptElement>('script[src*="/s/preview/"]');
      expect(script?.src).toBe("https://edge.test/s/preview/test.js"); // vitest.config.ts の define(__WTT_PREVIEW_HASH__ = "test")
      expect(script?.nonce).toBe("n0nce");
      expect(loadFailures()).toEqual([expect.stringContaining('Failed to load script "https://edge.test/s/preview/test.js"')]);
      script!.dispatchEvent(new Event("error")); // happy-dom は外部スクリプトを読まない(既に error を出していても冪等)
      expect(api.getPreviewReport()).toEqual([]);
      expect(document.getElementById("__ab_prehide")).toBeNull();
      expect(document.querySelector(".hero-title")?.textContent).toBe("orig");
    } finally {
      window.location.hash = "";
    }
  });
  it("読み込み口があれば同期で適用する(下書きの bootstrap)", () => {
    document.body.innerHTML = `<h1 class="hero-title">orig</h1>`;
    try {
      createRuntime(previewDeps("#__ab_preview=exp_hero:vB"), { config: baseConfig, settings: baseSettings });
      expect(document.querySelector('script[src*="/s/preview/"]')).toBeNull();
      expect(document.querySelector(".hero-title")?.textContent).toBe("B!");
      expect(loadFailures()).toEqual([]);
    } finally {
      window.location.hash = "";
    }
  });
  it("期限までに load が届けば、別ファイルが置いた読み込み口で適用して prehide を外す", () => {
    delete (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__;
    document.body.innerHTML = `<h1 class="hero-title">orig</h1>`;
    vi.useFakeTimers();
    try {
      const held = holdScripts();
      const api = createRuntime(previewDeps("#__ab_preview=exp_hero:vB"), { config: baseConfig, settings: baseSettings });
      expect(held.map((s) => s.src)).toEqual(["https://edge.test/s/preview/test.js"]);
      expect(document.getElementById("__ab_prehide")).not.toBeNull(); // 読み込みを待つ間は張る
      // 別ファイルが読めた(読み込み口が置かれ、load が届く)
      (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__ = createPreviewEngine;
      held[0]!.dispatchEvent(new Event("load"));
      expect(document.querySelector(".hero-title")?.textContent).toBe("B!");
      expect(api.getPreviewReport()![0]!.changes[0]).toMatchObject({ matched: 1, applied: true });
      expect(document.getElementById("__ab_prehide")).toBeNull();
      vi.advanceTimersByTime(baseSettings.decisionTimeoutMs); // 期限のタイマーは止まっている(2 回目の適用・解除は無い)
      expect(document.querySelector(".hero-title")?.textContent).toBe("B!");
      expect(loadFailures()).toEqual([]);
    } finally {
      vi.useRealTimers();
      window.location.hash = "";
    }
  });
  it("preview_loader_timeout_releases_prehide(load も error も起きなければ、期限 = decisionTimeoutMs の後に prehide を外す)", () => {
    delete (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__;
    document.body.innerHTML = `<h1 class="hero-title">orig</h1>`;
    vi.useFakeTimers();
    try {
      const held = holdScripts(); // 読み込みが返ってこない状態を作る(load も error も発火しない)
      const api = createRuntime(previewDeps("#__ab_preview=exp_hero:vB"), { config: baseConfig, settings: baseSettings });
      expect(held).toHaveLength(1);
      expect(document.getElementById("__ab_prehide")).not.toBeNull(); // 読み込みを待つ間は張る
      vi.advanceTimersByTime(baseSettings.decisionTimeoutMs - 1);
      expect(document.getElementById("__ab_prehide")).not.toBeNull(); // 期限の前は外さない
      vi.advanceTimersByTime(1);
      expect(document.getElementById("__ab_prehide")).toBeNull();
      expect(document.querySelector(".hero-title")?.textContent).toBe("orig");
      expect(api.getPreviewReport()).toEqual([]);
      expect(loadFailures()).toEqual([]);
    } finally {
      vi.useRealTimers();
      window.location.hash = "";
    }
  });
  it("preview_late_load_after_timeout_does_not_apply(期限の後に届いた load は適用しない)", () => {
    delete (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__;
    document.body.innerHTML = `<h1 class="hero-title">orig</h1>`;
    vi.useFakeTimers();
    try {
      const held = holdScripts();
      const api = createRuntime(previewDeps("#__ab_preview=exp_hero:vB"), { config: baseConfig, settings: baseSettings });
      const script = held[0]!;
      expect(document.getElementById("__ab_prehide")).not.toBeNull();
      vi.advanceTimersByTime(baseSettings.decisionTimeoutMs);
      expect(document.getElementById("__ab_prehide")).toBeNull(); // 期限の分岐を通った(load より先に)
      // 遅れて別ファイルが読めた(読み込み口が置かれ、load が届く)
      (window as unknown as { __WTT_PREVIEW__?: unknown }).__WTT_PREVIEW__ = createPreviewEngine;
      script.dispatchEvent(new Event("load"));
      expect(document.querySelector(".hero-title")?.textContent).toBe("orig");
      expect(api.getPreviewReport()).toEqual([]);
      expect(document.getElementById("__ab_prehide")).toBeNull();
      expect(loadFailures()).toEqual([]);
    } finally {
      vi.useRealTimers();
      window.location.hash = "";
    }
  });
});
