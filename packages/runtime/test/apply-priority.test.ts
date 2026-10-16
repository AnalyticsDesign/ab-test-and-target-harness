import { beforeEach, expect, it, vi } from "vitest";
import type { Change } from "@wtt/core";
import { spyPageConsoleError } from "./dom";
import { createApplyEngine, createPageState, type ActiveChange } from "../src/apply";

const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};
const text = (id: string, selector: string, t: string): Change => ({ id, type: "TEXT", selector, payload: { text: t } }) as Change;
const ac = (experimentId: string, rank: number, change: Change): ActiveChange => ({ experimentId, variantId: "v", change, rank });
const start = (changes: ActiveChange[]) => {
  const engine = createApplyEngine(document, { onApplied: vi.fn(), onControlSeen: vi.fn() }, { state: createPageState() });
  engine.start(changes, []);
  return engine;
};

beforeEach(() => {
  document.body.innerHTML = `<button id="cta">orig</button><div id="box">box</div><img id="img" src="/a.png">`;
  document.head.querySelectorAll("style[data-ab-change]").forEach((s) => s.remove());
});

it("late_match_single_does_not_override_test", async () => {
  // 設計書 §3.2 のレビュー r1 の再現手順: 初回に #cta へテストを適用 → 同じ要素に後から .fixed が付き、再 scan でパーソナライズが一致する
  const engine = start([ac("exp_s", 0, text("s1", ".fixed", "S")), ac("exp_t", 1, text("t1", "#cta", "T"))]);
  expect(document.getElementById("cta")!.textContent).toBe("T");
  document.getElementById("cta")!.classList.add("fixed");
  await tick();
  expect(document.getElementById("cta")!.textContent).toBe("T");
  engine.stop();
});

it("earlier_started_test_wins_over_newer_test", async () => {
  // 並び = [T2(後に開始, rank 0), T1(先に開始, rank 1)]。T1 が #cta を書いた後に、T2 のセレクタ .x が後から一致しても T1 のまま
  const engine = start([ac("exp_t2", 0, text("c", ".x", "T2")), ac("exp_t1", 1, text("c", "#cta", "T1"))]);
  document.getElementById("cta")!.classList.add("x");
  await tick();
  expect(document.getElementById("cta")!.textContent).toBe("T1");
  engine.stop();
});

it("baseline_without_changes_shows_lower_priority", () => {
  // テストの基準(変更なし)の人には、並びで前のパーソナライズが見える
  start([ac("exp_s", 0, text("s1", "#cta", "S"))]).stop();
  expect(document.getElementById("cta")!.textContent).toBe("S");
});

it("different attributes both apply, the same attribute goes to the later one", () => {
  const attr = (id: string, name: string, value: string): Change => ({ id, type: "ATTRIBUTE", selector: "#cta", payload: { name, value } }) as Change;
  start([ac("exp_s", 0, attr("a1", "title", "S")), ac("exp_s", 0, attr("a2", "aria-label", "S")), ac("exp_t", 1, attr("a3", "TITLE", "T"))]).stop();
  const el = document.getElementById("cta")!;
  expect(el.getAttribute("title")).toBe("T");
  expect(el.getAttribute("aria-label")).toBe("S");
});

it("hide and text are different parts and both apply", () => {
  start([ac("exp_s", 0, { id: "h", type: "HIDE", selector: "#cta", payload: {} } as Change), ac("exp_t", 1, text("t", "#cta", "T"))]).stop();
  const el = document.getElementById("cta") as HTMLElement;
  expect(el.textContent).toBe("T");
  expect(el.style.getPropertyValue("display")).toBe("none");
});

it("html inserts from both experiments go in, in priority order", () => {
  const ins = (id: string, html: string): Change => ({ id, type: "HTML", selector: "#box", payload: { html, position: "append", runScripts: false } }) as Change;
  start([ac("exp_s", 0, ins("i1", "<i>S</i>")), ac("exp_t", 1, ins("i2", "<i>T</i>"))]).stop();
  expect(Array.from(document.querySelectorAll("#box i")).map((n) => n.textContent)).toEqual(["S", "T"]);
});

it("late_html_replace_preserves_higher_priority_hide", async () => {
  // 後ろ(優先)のテストが #box を隠した後、前のパーソナライズの replace が一致しても置き換えない
  const engine = start([
    ac("exp_s", 0, { id: "r", type: "HTML", selector: ".late", payload: { html: "<p id='box' class='late'>S</p>", position: "replace", runScripts: false } } as Change),
    ac("exp_t", 1, { id: "h", type: "HIDE", selector: "#box", payload: {} } as Change),
  ]);
  document.getElementById("box")!.classList.add("late");
  await tick();
  const box = document.getElementById("box") as HTMLElement;
  expect(box.textContent).toBe("box");
  expect(box.style.getPropertyValue("display")).toBe("none");
  engine.stop();
});

it("late_attribute_src_does_not_override_higher_priority_image", async () => {
  const engine = start([
    ac("exp_s", 0, { id: "a", type: "ATTRIBUTE", selector: ".late", payload: { name: "src", value: "https://cdn.test/S.png" } } as Change),
    ac("exp_t", 1, { id: "i", type: "IMAGE", selector: "#img", payload: { src: "https://cdn.test/T.png" } } as Change),
  ]);
  document.getElementById("img")!.classList.add("late");
  await tick();
  expect(document.getElementById("img")!.getAttribute("src")).toBe("https://cdn.test/T.png");
  engine.stop();
});

it("late_image_does_not_override_higher_priority_attribute_src", async () => {
  const engine = start([
    ac("exp_s", 0, { id: "i", type: "IMAGE", selector: ".late", payload: { src: "https://cdn.test/S.png" } } as Change),
    ac("exp_t", 1, { id: "a", type: "ATTRIBUTE", selector: "#img", payload: { name: "src", value: "https://cdn.test/T.png" } } as Change),
  ]);
  document.getElementById("img")!.classList.add("late");
  await tick();
  expect(document.getElementById("img")!.getAttribute("src")).toBe("https://cdn.test/T.png");
  engine.stop();
});

it("html_replace_preserves_priority_on_activated_script_descendant", async () => {
  // runScripts: true の replace は <script> を clone に差し替える。clone(子孫と最上位の両方)にも記録が付いている(レビュー r2 CX-High-2)。
  // 外部 <script src> の読込の失敗がページの console に出るので spyPageConsoleError()(test/dom.ts)で握る
  const consoleError = spyPageConsoleError();
  const engine = start([
    ac("exp_s", 0, { id: "a", type: "ATTRIBUTE", selector: ".late", payload: { name: "src", value: "https://cdn.test/S.js" } } as Change),
    ac("exp_t", 1, { id: "r", type: "HTML", selector: "#box", payload: { html: "<div id='wrap'><script id='owned' src='https://cdn.test/T.js'></script></div><script id='top' src='https://cdn.test/T2.js'></script>", position: "replace", runScripts: true } } as Change),
  ]);
  await tick();
  for (const id of ["owned", "top"]) document.getElementById(id)!.classList.add("late");
  await tick();
  expect(document.getElementById("owned")!.getAttribute("src")).toBe("https://cdn.test/T.js");
  expect(document.getElementById("top")!.getAttribute("src")).toBe("https://cdn.test/T2.js");
  engine.stop();
  consoleError.mockRestore();
});

it("html_replace_preserves_priority_on_matching_descendant", async () => {
  const engine = start([
    ac("exp_s", 0, text("s", "#cta", "S")),
    ac("exp_t", 1, { id: "r", type: "HTML", selector: "#cta", payload: { html: "<div id='wrap'><button id='cta'>T</button></div>", position: "replace", runScripts: false } } as Change),
  ]);
  await tick();
  document.getElementById("wrap")!.setAttribute("data-x", "1"); // 再 scan を起こす
  await tick();
  expect(document.getElementById("cta")!.textContent).toBe("T");
  engine.stop();
});

it("a replace by the later experiment hands its claim to the new element", async () => {
  const engine = start([
    ac("exp_s", 0, text("s", "#cta", "S")),
    ac("exp_t", 1, { id: "r", type: "HTML", selector: "#cta", payload: { html: "<button id='cta'>T</button>", position: "replace", runScripts: false } } as Change),
  ]);
  await tick();
  // 置き換えた後の新しい #cta は後ろのテストのもの。前のパーソナライズの TEXT は再 scan でも書かない
  expect(document.getElementById("cta")!.textContent).toBe("T");
  engine.stop();
});

it("a change blocked on one element still applies to a new element nobody has written", async () => {
  // 後ろのテストは .t だけに効く。前のパーソナライズは .late に効く。テストが書いた要素では止まり、
  // SPA が作り直した .t の無い要素には効く(部分の記録は要素ごとで、セレクタや変更の単位で止めない)
  document.body.innerHTML = `<button id="cta" class="t">orig</button>`;
  const engine = start([ac("exp_s", 0, text("s", ".late", "S")), ac("exp_t", 1, text("t", ".t", "T"))]);
  document.getElementById("cta")!.classList.add("late");
  await tick();
  expect(document.getElementById("cta")!.textContent).toBe("T"); // 止まった
  document.getElementById("cta")!.replaceWith(Object.assign(document.createElement("button"), { id: "cta", className: "late", textContent: "orig" }));
  await tick();
  expect(document.getElementById("cta")!.textContent).toBe("S"); // 新しい要素は誰も書いていない
  engine.stop();
});

it("changes inside the same experiment keep the last-change-wins rule", () => {
  start([ac("exp_t", 1, text("c1", "#cta", "first")), ac("exp_t", 1, text("c2", "#cta", "second"))]).stop();
  expect(document.getElementById("cta")!.textContent).toBe("second");
});
