import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bucketOf, uuidToVisitorId } from "@wtt/core";
import type { Change, CompiledConfig, ResultsEventResponse } from "@wtt/core";
import { createApplyEngine, createPageState, type ActiveChange, type ControlWatch } from "../src/apply";
import { createResultsSender, type ResultsSender } from "../src/results";
import { createRuntime, type AbApi, type RuntimeDeps } from "../src/runtime";
import { executableDocument } from "./dom";
import { baseConfig, baseSettings } from "./fixtures";

// D9 ②(設計書 §6.1・§6.2・K9): 送信済みの印(localStorage)と、参加・後から失敗・回復・CV の送信

const RUN_A = "a".repeat(22);
const RUN_B = "b".repeat(22);
const RUN_C = "c".repeat(22);
const H = "hashAAAAAAA"; // 訪問者 ID の短いハッシュ(印の i)
const NOW = Date.UTC(2026, 9, 17, 12);
const KEY = "_ab_vid_r";

type Body = Record<string, unknown>;
type Reply = ResultsEventResponse | null | Promise<ResultsEventResponse | null>;

/** 既定の応答: 参加は stored、CV は runId ごとに stored */
const stored = (b: Body): ResultsEventResponse =>
  b.type === "conversion" ? { result: "stored", runs: Object.fromEntries((b.runIds as string[]).map((r) => [r, { result: "stored" as const }])) } : { result: "stored" };

const cfg = (runs: Record<string, string> = { exp_a: RUN_A, exp_b: RUN_B }): CompiledConfig => ({ ...baseConfig, results: { forget: true, runs } });

/** 1 ページ分の送信側。send は本文を記録して reply を返す偽物 */
function page(o: { runs?: Record<string, string>; storage?: Storage | null; now?: number; reply?: (b: Body) => Reply } = {}) {
  const sent: Body[] = [];
  const reply = o.reply ?? stored;
  const s = createResultsSender({
    config: cfg(o.runs),
    settings: baseSettings,
    storage: o.storage === undefined ? localStorage : o.storage,
    send: async (b) => {
      sent.push({ ...b });
      return reply(b);
    },
    now: () => o.now ?? NOW,
  });
  return { s, sent };
}
const join = (s: ResultsSender, exp = "exp_a", variant = "vB"): void => {
  s.participant(exp, variant, "desktop");
  s.endScan();
};
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const marks = (): { v: number; i: string; p: Record<string, string>; c: Record<string, string[]>; s?: number } | null => JSON.parse(localStorage.getItem(KEY) ?? "null");
const deferred = () => {
  let resolve!: (r: ResultsEventResponse | null) => void;
  const promise = new Promise<ResultsEventResponse | null>((r) => (resolve = r));
  return { promise, resolve };
};
const participantBody = (runId: string, variantId: string, applied: string, extra: Body = { device: "desktop" }): Body => ({ type: "participant", v: 1, runId, variantId, ...extra, applied });
const late = (runId: string, variantId: string, applied: "failed_later" | "recovered"): Body => ({ type: "participant", v: 1, runId, variantId, applied });

beforeEach(() => {
  localStorage.clear();
});

it("sends participant once per run and marks on stored", async () => {
  const { s, sent } = page();
  s.begin(H);
  join(s);
  await flush();
  expect(sent).toEqual([participantBody(RUN_A, "vB", "ok")]);
  expect(marks()).toMatchObject({ v: 1, i: H, p: { [RUN_A]: "vB:o" } });
  join(s); // 同じページでもう一度
  await flush();
  expect(sent).toHaveLength(1);
  const next = page(); // 次のページ
  next.s.begin(H);
  join(next.s);
  await flush();
  expect(next.sent).toEqual([]);
});

it("ignored_participant_is_not_marked_as_recorded", async () => {
  // 一時的な ignored(config が古い: 一時停止中など)→ 印を付けず、次のページで送り直す
  const first = page({ reply: () => ({ result: "ignored" }) });
  first.s.begin(H);
  join(first.s);
  await flush();
  expect(first.sent).toHaveLength(1);
  expect(marks()!.p).toEqual({});
  const next = page();
  next.s.begin(H);
  join(next.s);
  await flush();
  expect(next.sent).toEqual([participantBody(RUN_A, "vB", "ok")]);
});

it("permanently_ignored_participant_is_not_resent", async () => {
  // retry: false → 印 x。以後その run には参加も CV も送らない
  const first = page({ reply: () => ({ result: "ignored", retry: false }) });
  first.s.begin(H);
  join(first.s);
  await flush();
  expect(marks()!.p).toEqual({ [RUN_A]: "vB:x" });
  const next = page();
  next.s.begin(H);
  join(next.s);
  next.s.conversion("g_cta");
  await flush();
  expect(next.sent).toEqual([]);
});

it("participant_stop_response_does_not_mark_sent", async () => {
  const until = NOW + 3_600_000;
  const p0 = page(); // exp_b は参加済み(CV の送り先になる)
  p0.s.begin(H);
  join(p0.s, "exp_b", "vA");
  await flush();
  const p1 = page({ reply: () => ({ result: "stopped", until }) });
  p1.s.begin(H);
  join(p1.s);
  await flush();
  expect(marks()).toMatchObject({ p: { [RUN_B]: "vA:o" }, s: until });
  expect(marks()!.p[RUN_A]).toBeUndefined();
  // 停止の期限(edge が決めた until)まで参加も CV も送らない
  const p2 = page({ now: until - 1 });
  p2.s.begin(H);
  join(p2.s);
  p2.s.conversion("g_cta");
  await flush();
  expect(p2.sent).toEqual([]);
  // 期限を過ぎたら s を消して送り直す
  const p3 = page({ now: until });
  p3.s.begin(H);
  join(p3.s);
  await flush();
  expect(p3.sent).toEqual([participantBody(RUN_A, "vB", "ok")]);
  expect(marks()!.s).toBeUndefined();
  // forget は送信側を通らない(runtime の撤回の経路。停止中でも送る。runtime.test.ts の revoke のテスト)
});

it("participant_d1_failure_resends_on_next_page", async () => {
  for (const reply of [(): Reply => ({ result: "failed" }), (): Reply => null]) {
    localStorage.clear();
    const first = page({ reply });
    first.s.begin(H);
    join(first.s);
    await flush();
    expect(marks()!.p).toEqual({});
    const next = page();
    next.s.begin(H);
    join(next.s);
    await flush();
    expect(next.sent).toEqual([participantBody(RUN_A, "vB", "ok")]);
  }
});

it("conversion_waits_for_participant", async () => {
  const a = deferred();
  const b = deferred();
  const { s, sent } = page({ reply: (body) => (body.type === "conversion" ? stored(body) : body.runId === RUN_A ? a.promise : b.promise) });
  s.begin(H);
  s.participant("exp_a", "vB", "desktop");
  s.participant("exp_b", "vA", "mobile");
  s.endScan();
  s.conversion("g_cta");
  await flush();
  expect(sent.map((x) => x.type)).toEqual(["participant", "participant"]); // CV は参加の settle を待つ
  a.resolve({ result: "stored" });
  await flush();
  expect(sent).toHaveLength(2);
  b.resolve({ result: "failed" }); // 保存されなかった run は送り先から外す
  await flush();
  expect(sent[2]).toEqual({ type: "conversion", v: 1, goalId: "g_cta", runIds: [RUN_A] });
  expect(marks()!.c).toEqual({ [RUN_A]: ["g_cta"] });
});

it("conversion_during_pending_participant_is_preserved", async () => {
  // 送信の準備(begin)の前・scan の途中(参加の保留中)に起きた CV も、参加が保存された後に送る
  const { s, sent } = page();
  s.participant("exp_a", "vB", "desktop");
  s.conversion("g_cta");
  s.endScan();
  await flush();
  expect(sent).toEqual([]); // begin の前は溜める
  s.begin(H);
  await flush();
  expect(sent).toEqual([participantBody(RUN_A, "vB", "ok"), { type: "conversion", v: 1, goalId: "g_cta", runIds: [RUN_A] }]);
});

it("conversion splits runIds into chunks of 20", async () => {
  const runs: Record<string, string> = {};
  const p: Record<string, string> = {};
  for (let i = 0; i < 45; i++) {
    const run = String(i).padStart(22, "r");
    runs[`exp_${i}`] = run;
    p[run] = "vA:o";
  }
  localStorage.setItem(KEY, JSON.stringify({ v: 1, i: H, p, c: {} }));
  const { s, sent } = page({ runs });
  s.begin(H);
  s.conversion("g_cta");
  await flush();
  expect(sent.map((b) => (b.runIds as string[]).length)).toEqual([20, 20, 5]);
  expect(new Set(sent.flatMap((b) => b.runIds as string[]))).toEqual(new Set(Object.keys(p)));
  expect(Object.keys(marks()!.c)).toHaveLength(45);
});

it("conversion marks only stored or final runs", async () => {
  localStorage.setItem(KEY, JSON.stringify({ v: 1, i: H, p: { [RUN_A]: "vA:o", [RUN_B]: "vA:o", [RUN_C]: "vB:f" }, c: {} }));
  const runs = { exp_a: RUN_A, exp_b: RUN_B, exp_c: RUN_C };
  const first = page({ runs, reply: () => ({ result: "stored", runs: { [RUN_A]: { result: "stored" }, [RUN_B]: { result: "ignored", retry: false }, [RUN_C]: { result: "failed" } } }) });
  first.s.begin(H);
  first.s.conversion("g_cta");
  await flush();
  expect(marks()!.c).toEqual({ [RUN_A]: ["g_cta"], [RUN_B]: ["g_cta"] });
  const next = page({ runs });
  next.s.begin(H);
  next.s.conversion("g_cta");
  await flush();
  expect(next.sent).toEqual([{ type: "conversion", v: 1, goalId: "g_cta", runIds: [RUN_C] }]);
});

it("late failure is sent once and switches the mark to f", async () => {
  const { s, sent } = page();
  s.begin(H);
  join(s);
  await flush();
  for (let i = 0; i < 3; i++) {
    s.applyFailed("exp_a");
    await flush();
  }
  expect(sent).toEqual([participantBody(RUN_A, "vB", "ok"), late(RUN_A, "vB", "failed_later")]);
  expect(marks()!.p[RUN_A]).toBe("vB:f");
});

it("recovery is sent once after a failure", async () => {
  // 1 ページ目: 適用に失敗して参加(印 f)。同じページの後の成功は回復にしない(回復はエクスペリエンス単位)
  const p1 = page();
  p1.s.begin(H);
  p1.s.participant("exp_a", "vB", "desktop");
  p1.s.applyFailed("exp_a");
  p1.s.endScan();
  await flush();
  p1.s.applied("exp_a");
  await flush();
  expect(p1.sent).toEqual([participantBody(RUN_A, "vB", "failed")]);
  expect(marks()!.p[RUN_A]).toBe("vB:f");
  // 2 ページ目: すべての Change が成功 → 回復を 1 回だけ
  const p2 = page();
  p2.s.begin(H);
  p2.s.participant("exp_a", "vB", "desktop");
  for (let i = 0; i < 3; i++) p2.s.applied("exp_a"); // Change ごとに呼ばれる
  p2.s.endScan();
  await flush();
  p2.s.applied("exp_a");
  await flush();
  p2.s.applyFailed("exp_a"); // 回復の後の失敗は送らない(後から失敗は ok の人だけ)
  await flush();
  expect(p2.sent).toEqual([late(RUN_A, "vB", "recovered")]);
  expect(marks()!.p[RUN_A]).toBe("vB:r");
});

it("partial_failure_does_not_count_as_recovery", async () => {
  // 2 ページ目に TEXT は成功・IMAGE(img でない要素)は失敗: onApplied が先に来ても、同じ scan の失敗があるので回復ではない
  localStorage.setItem(KEY, JSON.stringify({ v: 1, i: H, p: { [RUN_A]: "v:f" }, c: {} }));
  document.body.innerHTML = `<p id="t">orig</p><div id="pic"></div>`;
  const { s, sent } = page();
  s.begin(H);
  const engine = wire(
    document,
    s,
    [
      { experimentId: "exp_a", variantId: "v", change: { id: "c1", type: "TEXT", selector: "#t", payload: { text: "new" } }, rank: 0 },
      { experimentId: "exp_a", variantId: "v", change: { id: "c2", type: "IMAGE", selector: "#pic", payload: { src: "/b.png" } }, rank: 0 },
    ],
    { exp_a: "v" },
    [{ experimentId: "exp_a", selectors: ["#t", "#pic"] }],
  );
  await flush();
  document.body.appendChild(document.createElement("span")); // 再 scan
  await flush();
  engine.stop();
  expect(document.getElementById("t")!.textContent).toBe("new");
  expect(sent).toEqual([]);
  expect(marks()!.p[RUN_A]).toBe("v:f");
});

/** 実際のエンジンを送信側につなぐ(runtime.ts と同じ配線) */
function wire(doc: Document, s: ResultsSender, changes: ActiveChange[], assigned: Record<string, string>, targets: ControlWatch[]) {
  const engine = createApplyEngine(
    doc,
    {
      onApplied: (id) => s.applied(id),
      onControlSeen: () => {},
      onTargetSeen: (id) => s.participant(id, assigned[id]!, "desktop"),
      onApplyFailed: (id) => s.applyFailed(id),
      onScanEnd: () => s.endScan(),
    },
    { state: createPageState() },
  );
  engine.start(changes, [], targets);
  return engine;
}

it("participant_reports_failed_when_apply_fails_in_same_scan", async () => {
  // 上書きで負けるテスト(exp_lo)と false を返す IMAGE(exp_img)。参加は 1 回で applied: "failed"、後から失敗は送らない
  document.body.innerHTML = `<p id="t">orig</p><div id="pic"></div>`;
  const { s, sent } = page({ runs: { exp_lo: RUN_A, exp_hi: RUN_B, exp_img: RUN_C } });
  s.begin(H);
  const text = (t: string): Change => ({ id: "c", type: "TEXT", selector: "#t", payload: { text: t } });
  const engine = wire(
    document,
    s,
    [
      { experimentId: "exp_lo", variantId: "v", change: text("lo"), rank: 0 },
      { experimentId: "exp_hi", variantId: "v", change: text("hi"), rank: 1 },
      { experimentId: "exp_img", variantId: "v", change: { id: "c", type: "IMAGE", selector: "#pic", payload: { src: "/b.png" } }, rank: 2 },
    ],
    { exp_lo: "v", exp_hi: "v", exp_img: "v" },
    [
      { experimentId: "exp_lo", selectors: ["#t"] },
      { experimentId: "exp_hi", selectors: ["#t"] },
      { experimentId: "exp_img", selectors: ["#pic"] },
    ],
  );
  await flush();
  for (let i = 0; i < 3; i++) {
    document.body.appendChild(document.createElement("span")); // 関係のない変化で再 scan
    await flush();
  }
  engine.stop();
  // run ごとに直列なので、run をまたいだ送信の順は決まらない(run で並べて比べる)
  const byRun = [...sent].sort((x, y) => String(x.runId).localeCompare(String(y.runId)));
  expect(byRun).toEqual([participantBody(RUN_A, "v", "failed"), participantBody(RUN_B, "v", "ok"), participantBody(RUN_C, "v", "failed")]);
});

it("initial_apply_failure_is_stored_as_failed", async () => {
  const { s, sent } = page();
  s.begin(H);
  s.participant("exp_a", "vB", "tablet");
  s.applyFailed("exp_a");
  s.endScan();
  await flush();
  expect(sent).toEqual([participantBody(RUN_A, "vB", "failed", { device: "tablet" })]);
  expect(marks()!.p[RUN_A]).toBe("vB:f");
});

it("successful_changes_do_not_report_failure_on_rescan", async () => {
  // 成功した TEXT / IMAGE / 自分に一致する HTML の replace / CSS / CUSTOM_JS は、関係のない変化の再 scan でも失敗を報告しない
  // (誤った failed は結果を壊す)。CUSTOM_JS を実行するため <script> を評価する Window を使う
  const { win, doc } = executableDocument();
  vi.stubGlobal("MutationObserver", win.MutationObserver);
  try {
    doc.body.innerHTML = `<p id="t">orig</p><img id="i" src="/a.png"><div class="box">old</div><div id="js"></div>`;
    const runs = { e_text: "1".repeat(22), e_img: "2".repeat(22), e_html: "3".repeat(22), e_css: "4".repeat(22), e_js: "5".repeat(22) };
    const { s, sent } = page({ runs });
    s.begin(H);
    const changes: ActiveChange[] = [
      { experimentId: "e_text", variantId: "v", change: { id: "c", type: "TEXT", selector: "#t", payload: { text: "new" } }, rank: 0 },
      { experimentId: "e_img", variantId: "v", change: { id: "c", type: "IMAGE", selector: "#i", payload: { src: "/b.png" } }, rank: 1 },
      { experimentId: "e_html", variantId: "v", change: { id: "c", type: "HTML", selector: ".box", payload: { html: `<div class="box">new</div>`, position: "replace" } } as Change, rank: 2 },
      { experimentId: "e_css", variantId: "v", change: { id: "c", type: "CSS", payload: { css: ".x{color:red}" } } as Change, rank: 3 },
      { experimentId: "e_js", variantId: "v", change: { id: "c", type: "CUSTOM_JS", selector: "#js", payload: { code: "element.setAttribute('data-x','1')" } } as Change, rank: 4 },
    ].map((c) => ({ ...c, change: c.change as Change }));
    const sel = { e_text: ["#t"], e_img: ["#i"], e_html: [".box"], e_css: [":root"], e_js: ["#js"] } as Record<string, string[]>;
    const engine = wire(doc, s, changes, { e_text: "v", e_img: "v", e_html: "v", e_css: "v", e_js: "v" }, Object.keys(runs).map((id) => ({ experimentId: id, selectors: sel[id]! })));
    await flush();
    expect(doc.getElementById("js")!.getAttribute("data-x")).toBe("1"); // CUSTOM_JS は実際に走った
    for (let i = 0; i < 4; i++) {
      doc.body.appendChild(doc.createElement("section"));
      doc.body.setAttribute("data-n", String(i));
      await flush();
    }
    engine.stop();
    expect(sent).toHaveLength(5);
    expect(sent.every((b) => b.applied === "ok")).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("late_failure_waits_for_participant", async () => {
  const p = deferred();
  const { s, sent } = page({ reply: (b) => (b.applied === "ok" ? p.promise : stored(b)) });
  s.begin(H);
  join(s);
  await flush();
  s.applyFailed("exp_a"); // 参加の応答待ちの間の失敗
  await flush();
  expect(sent).toHaveLength(1);
  p.resolve({ result: "stored" });
  await flush();
  expect(sent).toEqual([participantBody(RUN_A, "vB", "ok"), late(RUN_A, "vB", "failed_later")]);
});

it("recovery_during_pending_failure_is_preserved", async () => {
  // failed_later の応答待ちの間の成功は、その応答の後に確かめる。同じページで失敗を受けたので回復にはせず、印 f を保つ。
  // 回復は次のページで(すべての Change が成功したとき)送り、印の最後の状態は r
  const f = deferred();
  const { s, sent } = page({ reply: (b) => (b.applied === "failed_later" ? f.promise : stored(b)) });
  s.begin(H);
  join(s);
  await flush();
  s.applyFailed("exp_a");
  await flush();
  s.applied("exp_a"); // failed_later の応答待ちの間の成功
  await flush();
  expect(sent).toHaveLength(2);
  f.resolve({ result: "stored" });
  await flush();
  expect(sent).toEqual([participantBody(RUN_A, "vB", "ok"), late(RUN_A, "vB", "failed_later")]);
  expect(marks()!.p[RUN_A]).toBe("vB:f");
  const next = page();
  next.s.begin(H);
  join(next.s);
  next.s.applied("exp_a");
  await flush();
  expect(next.sent).toEqual([late(RUN_A, "vB", "recovered")]);
  expect(marks()!.p[RUN_A]).toBe("vB:r");
});

it("same_identity_variant_change_resends_participant", async () => {
  const p1 = page();
  p1.s.begin(H);
  p1.s.participant("exp_a", "vA", "desktop");
  p1.s.applyFailed("exp_a");
  p1.s.endScan();
  p1.s.conversion("g_cta");
  await flush();
  expect(marks()!.p[RUN_A]).toBe("vA:f");
  const p2 = page(); // 同じ i・同じパターン → 送らない
  p2.s.begin(H);
  join(p2.s, "exp_a", "vA");
  await flush();
  expect(p2.sent).toEqual([]);
  const p3 = page(); // 同じ i・違うパターン → 新しい参加として送る(D1 は混在として数える)
  p3.s.begin(H);
  join(p3.s, "exp_a", "vB");
  await flush();
  expect(p3.sent).toEqual([participantBody(RUN_A, "vB", "ok")]);
  // 印は新しいパターンに書き換え、適用の状態(D1 の行の状態)と CV の印は引き継ぐ
  expect(marks()!.p[RUN_A]).toBe("vB:f");
  expect(marks()!.c).toEqual({ [RUN_A]: ["g_cta"] });
});

it("id_change_resends_participant", async () => {
  localStorage.setItem(KEY, JSON.stringify({ v: 1, i: "otherHash00", p: { [RUN_A]: "vB:o" }, c: { [RUN_A]: ["g_cta"] } }));
  const { s, sent } = page();
  s.begin(H);
  join(s);
  await flush();
  expect(sent).toEqual([participantBody(RUN_A, "vB", "ok")]);
  expect(marks()).toEqual({ v: 1, i: H, p: { [RUN_A]: "vB:o" }, c: {} });
});

it("marks_fall_back_to_memory_without_storage", async () => {
  const boom = (): never => {
    throw new Error("SecurityError");
  };
  const storage = { getItem: boom, setItem: boom, removeItem: boom } as unknown as Storage;
  const { s, sent } = page({ storage });
  s.begin(H);
  join(s);
  await flush();
  join(s); // ページの中のメモリで重複を防ぐ
  s.conversion("g_cta");
  s.conversion("g_cta");
  await flush();
  expect(sent).toEqual([participantBody(RUN_A, "vB", "ok"), { type: "conversion", v: 1, goalId: "g_cta", runIds: [RUN_A] }]);
  expect(() => s.clear()).not.toThrow();
});

it("marks_not_persisted_without_crypto_subtle", async () => {
  // i を計算できない(crypto.subtle が無い・D-lite の vh が無い)ときは、localStorage を読みも書きもしない
  localStorage.setItem(KEY, JSON.stringify({ v: 1, i: H, p: { [RUN_A]: "vB:o" }, c: {} }));
  const { s, sent } = page();
  s.begin(null);
  join(s);
  await flush();
  expect(sent).toEqual([participantBody(RUN_A, "vB", "ok")]);
  expect(marks()).toEqual({ v: 1, i: H, p: { [RUN_A]: "vB:o" }, c: {} }); // 書き換えていない
  localStorage.clear();
  const next = page();
  next.s.begin(null);
  join(next.s);
  await flush();
  join(next.s);
  await flush();
  expect(next.sent).toHaveLength(1); // メモリでは重複を防ぐ
  expect(localStorage.getItem(KEY)).toBeNull();
});

it("marks for runs missing from results.runs are pruned", async () => {
  const OLD = "o".repeat(22);
  localStorage.setItem(KEY, JSON.stringify({ v: 1, i: H, p: { [RUN_A]: "vB:o", [OLD]: "vA:o" }, c: { [RUN_A]: ["g_cta"], [OLD]: ["g_cta"] } }));
  const { s } = page();
  s.begin(H);
  await flush();
  expect(marks()).toEqual({ v: 1, i: H, p: { [RUN_A]: "vB:o" }, c: { [RUN_A]: ["g_cta"] } });
});

it("corrupted_marks_fall_back_to_empty", async () => {
  // i は合っているが形の壊れた印(p が文字列・項目が数・c が null)で止まらない: 壊れた所は捨て、送り直して書き直す
  for (const bad of [{ p: "oops", c: {} }, { p: { [RUN_A]: 5 }, c: { [RUN_A]: "g_cta" } }, { p: { [RUN_A]: "vB:o" }, c: null }]) {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, i: H, ...bad }));
    const { s, sent } = page();
    s.begin(H);
    join(s);
    s.conversion("g_cta");
    await flush();
    expect(sent[0]).toEqual(participantBody(RUN_A, "vB", "ok"));
    expect(marks()!.p).toEqual({ [RUN_A]: "vB:o" });
    expect(marks()!.c).toEqual({ [RUN_A]: ["g_cta"] });
    localStorage.clear();
  }
});

it("oversized marks are discarded", async () => {
  // 4,096 文字を超えた印は読まずに捨てる(送り直す)
  localStorage.setItem(KEY, JSON.stringify({ v: 1, i: H, p: { [RUN_A]: "vB:o" }, c: { [RUN_A]: ["g".repeat(4100)] } }));
  const { s, sent } = page();
  s.begin(H);
  join(s);
  await flush();
  expect(sent).toEqual([participantBody(RUN_A, "vB", "ok")]);
  expect(marks()).toEqual({ v: 1, i: H, p: { [RUN_A]: "vB:o" }, c: {} });
  // 書くときも 4,096 文字を超えるなら書かない(キーを消す)。メモリでは持ち続ける
  s.conversion("x".repeat(4100));
  await flush();
  expect(localStorage.getItem(KEY)).toBeNull();
});

// ---- runtime を通すもの(Mode A は crypto.subtle のハッシュを待つので本物のタイマーで待つ) ----

function findVisitor(variant: "vA" | "vB"): string {
  for (let i = 0; i < 5000; i++) {
    const id = uuidToVisitorId(`00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`)!;
    if ((bucketOf(id, "exp_hero") >= 5000) === (variant === "vB")) return id;
  }
  throw new Error("visitor not found");
}
const VB = findVisitor("vB");

/** /event の本文を記録し、結果のイベントには stored を返す fetch */
function eventFetch(reply: (b: Body) => unknown = stored) {
  const bodies: Body[] = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    if (String(url).includes("/event")) bodies.push(body);
    const out = body.type === "participant" || body.type === "conversion" ? reply(body) : null;
    return { ok: true, status: out ? 200 : 204, json: async () => (out ? out : Promise.reject(new SyntaxError("empty"))) } as unknown as Response;
  }) as typeof fetch;
  return { fn, bodies };
}
const deps = (fetchFn: typeof fetch): RuntimeDeps => ({ win: window as RuntimeDeps["win"], doc: document, fetchFn, scriptSrc: "https://edge.test/s/site_unit.js", nonce: null });

afterEach(() => {
  ((window as RuntimeDeps["win"]).AB as AbApi | undefined)?.consent(false); // エンジンを止める(runtime.test.ts と同じ)
  delete (window as unknown as Record<string, unknown>).AB;
  document.cookie = "_ab_vid=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

it("participant_is_sent_only_after_scan_end", async () => {
  // 送信側だけ: 契機を受けても scan の終わりまでは送らない
  const unit = page();
  unit.s.begin(H);
  unit.s.participant("exp_a", "vB", "desktop");
  unit.s.applyFailed("exp_a");
  await flush();
  expect(unit.sent).toEqual([]);
  unit.s.endScan();
  await flush();
  expect(unit.sent).toEqual([participantBody(RUN_A, "vB", "failed")]);

  // 実際のエンジンと runtime: IMAGE が img でない要素を指す(要素はあるのに適用できない)→ 初回の失敗を含む参加が 1 回だけ
  localStorage.clear();
  document.cookie = `_ab_vid=${VB}; Path=/`;
  document.body.innerHTML = `<h1 class="hero-title">orig</h1>`;
  const config: CompiledConfig = {
    ...baseConfig,
    results: { forget: true, runs: { exp_hero: RUN_A } },
    experiments: [{ ...baseConfig.experiments[0]!, variants: [baseConfig.experiments[0]!.variants[0]!, { id: "vB", name: "B", weight: 50, changes: [{ id: "c_img", type: "IMAGE", selector: ".hero-title", payload: { src: "/b.png" } }] }] }],
  };
  const f = eventFetch();
  createRuntime(deps(f.fn), { config, settings: baseSettings });
  await vi.waitFor(() => expect(f.bodies.filter((b) => b.type === "participant")).toHaveLength(1));
  document.body.appendChild(document.createElement("div")); // 再 scan(失敗はもう一度通知される)
  await flush();
  await flush();
  expect(f.bodies.filter((b) => b.type === "participant")).toEqual([participantBody(RUN_A, "vB", "failed", { device: "desktop", visitorId: VB })]);
});

it("participant_body_includes_visitor_id_in_mode_a", async () => {
  document.cookie = `_ab_vid=${VB}; Path=/`;
  document.body.innerHTML = `<h1 class="hero-title">orig</h1>`;
  const f = eventFetch();
  createRuntime(deps(f.fn), { config: { ...baseConfig, results: { forget: true, runs: { exp_hero: RUN_A } } }, settings: baseSettings });
  await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
  expect(f.bodies[0]).toEqual({ type: "participant", v: 1, runId: RUN_A, variantId: "vB", device: "desktop", applied: "ok", visitorId: VB });
});
