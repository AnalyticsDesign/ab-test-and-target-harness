import { beforeEach, expect, it, vi } from "vitest";
import type { Change } from "@wtt/core";
import { createApplyEngine, createPageState, type ActiveChange, type ControlWatch, type EngineCallbacks } from "../src/apply";

// D9 ②(設計書 §6.1): 参加の契機(onTargetSeen)と適用の失敗(onApplyFailed)の通知。
// 送信と重複の除き方は runtime.ts 側(Task 9)が持つので、ここではエンジンが呼ぶかどうかと順序だけを見る

const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};
const text = (id: string, selector: string, t: string): Change => ({ id, type: "TEXT", selector, payload: { text: t } }) as Change;
const ac = (experimentId: string, rank: number, change: Change, variantId = "v"): ActiveChange => ({ experimentId, variantId, change, rank });
/** 呼び出しの順を 1 本の記録に残す(onTargetSeen が適用より先か、を見るため) */
const recorder = () => {
  const log: string[] = [];
  const cbs: EngineCallbacks = {
    onApplied: (id) => log.push(`applied:${id}`),
    onControlSeen: (id) => log.push(`control:${id}`),
    onTargetSeen: (id) => log.push(`seen:${id}`),
    onApplyFailed: (id) => log.push(`failed:${id}`),
    onScanEnd: () => log.push("end"),
  };
  return { log, cbs };
};
const start = (changes: ActiveChange[], targets?: ControlWatch[]) => {
  const r = recorder();
  const engine = createApplyEngine(document, r.cbs, { state: createPageState() });
  engine.start(changes, [], targets);
  return { ...r, engine };
};

beforeEach(() => {
  document.body.innerHTML = `<button id="cta">orig</button><div id="box">box</div><img id="img" src="/a.png" srcset="/a2.png 2x">`;
  document.head.querySelectorAll("style[data-ab-change]").forEach((s) => s.remove());
});

it("overridden_test_change_counts_as_apply_failure", () => {
  // 並びで後ろの T2(順位 1)が先に #cta を書き、前の T1(順位 0)は同じ部分なので行わない → T1 の失敗
  const { log, engine } = start([ac("t2", 1, text("c", "#cta", "T2")), ac("t1", 0, text("c", "#cta", "T1"))]);
  expect(document.getElementById("cta")!.textContent).toBe("T2");
  expect(log).toContain("failed:t1");
  expect(log).not.toContain("failed:t2");
  engine.stop();
});

it("overwritten_after_success_counts_as_late_failure", async () => {
  // T1 が先に書いて成功した後、後から一致した T2(順位が後ろ)が同じ部分を上書きする → T1 の「後から失敗」
  const { log, engine } = start([ac("t1", 0, text("c", "#cta", "T1")), ac("t2", 1, text("c", ".late", "T2"))]);
  expect(log).toContain("applied:t1");
  expect(log).not.toContain("failed:t1");
  document.getElementById("cta")!.classList.add("late");
  await tick();
  expect(document.getElementById("cta")!.textContent).toBe("T2");
  expect(log).toContain("failed:t1");
  expect(log).not.toContain("failed:t2");
  engine.stop();
});

it("missing element is not a failure", async () => {
  // 要素がまだ無いのは待ち(設計書 §6.1)。TEXT・IMAGE・HTML・CUSTOM_JS のどれも、要素が無い間は失敗にしない
  const { log, engine } = start([
    ac("t", 0, text("a", "#later", "x")),
    ac("t", 0, { id: "b", type: "IMAGE", selector: "#later-img", payload: { src: "https://cdn.test/b.png" } } as Change),
    ac("t", 0, { id: "c", type: "HTML", selector: "#later", payload: { html: "<i>x</i>", position: "append", runScripts: false } } as Change),
    ac("t", 0, { id: "d", type: "CUSTOM_JS", selector: "#later", payload: { code: "" } } as Change),
  ]);
  document.body.append(Object.assign(document.createElement("p"), { className: "noise" })); // 再 scan を起こす
  await tick();
  expect(log.some((l) => l.startsWith("failed:"))).toBe(false);
  expect(log).toContain("end");
  engine.stop();
});

it("image change failing on non-img reports failure", () => {
  // applyChangeTo が false(IMAGE の対象が img でない)
  const { log, engine } = start([ac("t", 0, { id: "i", type: "IMAGE", selector: "#cta", payload: { src: "https://cdn.test/b.png" } } as Change)]);
  expect(log).toContain("failed:t");
  expect(log).not.toContain("applied:t");
  engine.stop();
});

it("css and custom js failures report failure", () => {
  // CSS の挿入の例外(Trusted Types などで <style> の挿入が拒まれる)
  const append = vi.spyOn(document.head, "appendChild").mockImplementationOnce(() => {
    throw new Error("blocked");
  });
  const css = start([ac("t_css", 0, { id: "s", type: "CSS", payload: { css: "#cta{color:red}" } } as Change)]);
  expect(css.log).toContain("failed:t_css");
  css.engine.stop();
  append.mockRestore();
  // CUSTOM_JS の ok: false(既定の happy-dom は <script> を実行しないので、登録が無く失敗になる)
  const js = start([ac("t_js", 0, { id: "j", type: "CUSTOM_JS", selector: "#cta", payload: { code: "" } } as Change)]);
  expect(js.log).toContain("failed:t_js");
  js.engine.stop();
});

it("target is seen before the change removes the element", () => {
  // participant_is_observed_before_selector_is_removed: HIDE ではなく HTML の replace で #cta が消えても、参加の契機は適用より先に見つける
  const { log, engine } = start(
    [ac("t", 0, { id: "r", type: "HTML", selector: "#cta", payload: { html: "<p id='gone'>B</p>", position: "replace", runScripts: false } } as Change)],
    [{ experimentId: "t", selectors: ["#cta"] }],
  );
  expect(document.getElementById("cta")).toBeNull();
  expect(log.indexOf("seen:t")).toBeGreaterThanOrEqual(0);
  expect(log.indexOf("seen:t")).toBeLessThan(log.indexOf("applied:t"));
  expect(log.at(-1)).toBe("end"); // onScanEnd は scan の適用がすべて終わった後
  engine.stop();
});

it("participant_trigger_is_symmetric_across_variants", () => {
  // exposureSelectors = X と Y。ページには Y だけ。X を書くパターンでも、変更の無い基準でも同じく参加になる
  document.body.innerHTML = `<p id="y">y</p>`;
  const targets = [{ experimentId: "t", selectors: ["#x", "#y"] }];
  for (const changes of [[ac("t", 0, text("c", "#x", "B"), "vB")], []]) {
    const { log, engine } = start(changes, targets);
    expect(log.filter((l) => l === "seen:t")).toHaveLength(1);
    expect(log.some((l) => l.startsWith("failed:"))).toBe(false);
    engine.stop();
  }
});

it("participant_trigger_css_and_selector_mix", () => {
  // A = 基準、B = CSS、C = X の TEXT。X の無いページ。和集合は ["#x", ":root"](CSS が selector を持たないので compile が :root を足す)
  document.body.innerHTML = `<p>no x</p>`;
  const targets = [{ experimentId: "t", selectors: ["#x", ":root"] }];
  const variants: ActiveChange[][] = [
    [],
    [ac("t", 0, { id: "s", type: "CSS", payload: { css: "p{color:red}" } } as Change, "vB")],
    [ac("t", 0, text("c", "#x", "C"), "vC")],
  ];
  for (const changes of variants) {
    const { log, engine } = start(changes, targets);
    expect(log[0]).toBe("seen:t"); // どのパターンも起動の最初の scan で、適用より先に
    expect(log.filter((l) => l === "seen:t")).toHaveLength(1);
    engine.stop();
  }
});

it("image and attribute srcset share the srcset part", async () => {
  // ① の Minor 4: IMAGE は src と srcset(除去)の両方を書く。優先の低い ATTRIBUTE srcset は、優先の高い IMAGE が書いた要素で行わない
  const { log, engine } = start([
    ac("exp_s", 0, { id: "a", type: "ATTRIBUTE", selector: ".late", payload: { name: "srcset", value: "https://cdn.test/S.png 2x" } } as Change),
    ac("exp_t", 1, { id: "i", type: "IMAGE", selector: "#img", payload: { src: "https://cdn.test/T.png" } } as Change),
  ]);
  document.getElementById("img")!.classList.add("late");
  await tick();
  expect(document.getElementById("img")!.hasAttribute("srcset")).toBe(false);
  expect(log).toContain("failed:exp_s");
  engine.stop();
  // 逆向き: 優先の高い ATTRIBUTE srcset が書いた要素に、優先の低い IMAGE は src も書かない
  document.body.innerHTML = `<img id="img" src="/a.png">`;
  const rev = start([
    ac("exp_s", 0, { id: "i", type: "IMAGE", selector: ".late", payload: { src: "https://cdn.test/S.png" } } as Change),
    ac("exp_t", 1, { id: "a", type: "ATTRIBUTE", selector: "#img", payload: { name: "srcset", value: "https://cdn.test/T.png 2x" } } as Change),
  ]);
  document.getElementById("img")!.classList.add("late");
  await tick();
  const img = document.getElementById("img")!;
  expect(img.getAttribute("srcset")).toBe("https://cdn.test/T.png 2x");
  expect(img.getAttribute("src")).toBe("/a.png");
  expect(rev.log).toContain("failed:exp_s");
  rev.engine.stop();
});

it("html insert failure, body replace and a blocked replace report failure", async () => {
  // HTML の挿入の例外・replace が body を指した・後ろの順位が書いた要素への replace(行わない)はどれも失敗。上書きされた側にも知らせる
  const tpl = vi.spyOn(document, "createElement").mockImplementationOnce(() => {
    throw new Error("blocked");
  });
  const ins = start([ac("t_ins", 0, { id: "h", type: "HTML", selector: "#box", payload: { html: "<i>x</i>", position: "append", runScripts: false } } as Change)]);
  expect(ins.log).toContain("failed:t_ins");
  ins.engine.stop();
  tpl.mockRestore();
  const body = start([ac("t_body", 0, { id: "h", type: "HTML", selector: "body", payload: { html: "<i>x</i>", position: "replace", runScripts: false } } as Change)]);
  expect(body.log).toContain("failed:t_body");
  body.engine.stop();
  const rep = start([
    ac("exp_s", 0, { id: "r", type: "HTML", selector: ".late", payload: { html: "<p>S</p>", position: "replace", runScripts: false } } as Change),
    ac("exp_t", 1, text("t", "#cta", "T")),
  ]);
  document.getElementById("cta")!.classList.add("late");
  await tick();
  expect(document.getElementById("cta")!.textContent).toBe("T");
  expect(rep.log).toContain("failed:exp_s");
  rep.engine.stop();
  // 後ろの順位の replace が、前の順位が書いた要素を置き換える → 前の順位の「後から失敗」
  document.body.innerHTML = `<button id="cta">orig</button>`;
  const over = start([
    ac("exp_s", 0, text("s", "#cta", "S")),
    ac("exp_t", 1, { id: "r", type: "HTML", selector: ".late", payload: { html: "<p>T</p>", position: "replace", runScripts: false } } as Change),
  ]);
  expect(over.log).not.toContain("failed:exp_s");
  document.getElementById("cta")!.classList.add("late");
  await tick();
  expect(document.body.textContent).toBe("T");
  expect(over.log).toContain("failed:exp_s");
  over.engine.stop();
});
