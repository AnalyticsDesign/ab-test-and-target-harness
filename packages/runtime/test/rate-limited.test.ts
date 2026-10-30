import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uuidToVisitorId } from "@wtt/core";
import { createRuntime, type AbApi, type RuntimeDeps } from "../src/runtime";
import { baseConfig, baseSettings, dliteSettings, goalsConfig, namedSettings, remoteConfig, renamedAnalytics } from "./fixtures";

// Plan 12 K11: edge が 429 を返したら、そのページで 1 回だけ dataLayer に ab_error を積む(適用と送信は止めない)

const VB = uuidToVisitorId("00000000-0000-4000-8000-000000000001")!;
const RATE_LIMITED = { event: "ab_error", ab_error_type: "rate_limited" };

/** 最小のスタブ応答(実 Response の body 読み出しのマイクロタスク数に依存させない) */
const res = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

type Handler = (url: string, body: Record<string, unknown>) => Response | Promise<Response>;
/** URL の末尾(decision / event)と本文で応答を決める fetch。呼び出しも記録する */
function routedFetch(handler: Handler) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = ((url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return Promise.resolve(handler(String(url), body));
  }) as typeof fetch;
  return { fn, calls };
}

function makeDeps(fetchFn: typeof fetch): RuntimeDeps {
  return { win: window as RuntimeDeps["win"], doc: document, fetchFn, scriptSrc: "https://edge.test/s/site_unit.js", nonce: null };
}

function dataLayer(): Array<Record<string, unknown>> {
  return ((window as unknown as { dataLayer?: Array<Record<string, unknown>> }).dataLayer ?? []);
}
const abErrors = (dl: Array<Record<string, unknown>>) => dl.filter((e) => e.event === "ab_error");

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `<h1 class="hero-title">orig</h1>`;
  document.head.querySelectorAll("style[data-ab-change]").forEach((s) => s.remove());
  for (const part of document.cookie.split(/;\s*/)) {
    const name = part.split("=")[0];
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).dataLayer;
  delete (window as unknown as Record<string, unknown>).myDL;
  delete (window as unknown as Record<string, unknown>).__ab;
  document.cookie = `_ab_vid=${VB}; Path=/`;
});
afterEach(() => {
  ((window as RuntimeDeps["win"]).AB as AbApi | undefined)?.consent(false); // engine を止める(runtime.test.ts と同じ分離)
  delete (window as unknown as Record<string, unknown>).AB;
  vi.useRealTimers();
});

it("rate_limited_response_pushes_ab_error_once_per_page", async () => {
  // decision が 429 → 1 回積み、元の表示のまま。同じページで event も 429 でも増えない
  const f = routedFetch(() => res(429));
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  expect(abErrors(dataLayer())).toEqual([RATE_LIMITED]);
  expect(document.querySelector(".hero-title")!.textContent).toBe("orig"); // Change を適用しない
  api.track("g_cta"); // /event へ送る(これも 429)
  await flush();
  expect(f.calls.some((c) => c.url.endsWith("/event") && c.body.type === "goal")).toBe(true);
  expect(abErrors(dataLayer())).toEqual([RATE_LIMITED]); // 増えない
});

it("event だけが 429 のときも積む(decision は成功)", async () => {
  const f = routedFetch((url) => (url.endsWith("/event") ? res(429) : res(200, { v: 3, experiments: [] })));
  const api = createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: baseSettings });
  await flush();
  expect(abErrors(dataLayer())).toEqual([]);
  api.track("g_cta");
  await flush();
  expect(abErrors(dataLayer())).toEqual([RATE_LIMITED]);
});

it("D-lite の decision が 429 でも積む", async () => {
  const f = routedFetch(() => res(429));
  createRuntime(makeDeps(f.fn), { config: baseConfig, settings: dliteSettings });
  await flush();
  expect(f.calls[0]!.url).toBe("/__ab/decision");
  expect(abErrors(dataLayer())).toEqual([RATE_LIMITED]);
});

it("503 は積まない", async () => {
  const f = routedFetch(() => res(503));
  const api = createRuntime(makeDeps(f.fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  api.track("g_cta");
  await flush();
  expect(f.calls.length).toBeGreaterThan(1);
  expect(abErrors(dataLayer())).toEqual([]);
});

it("通信の失敗(fetch の reject)は積まない", async () => {
  const fn = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
  const api = createRuntime(makeDeps(fn), { config: goalsConfig, settings: baseSettings });
  await flush();
  api.track("g_cta");
  await flush();
  expect(abErrors(dataLayer())).toEqual([]);
});

it("dataLayerName がサイトの設定の名前なら、その配列に入る", async () => {
  const f = routedFetch(() => res(429));
  const settings = { ...namedSettings, analytics: { ...renamedAnalytics, dataLayerName: "myDL" } };
  createRuntime(makeDeps(f.fn), { config: remoteConfig, settings });
  await flush();
  expect((window as unknown as { myDL?: unknown[] }).myDL).toEqual([RATE_LIMITED]);
  expect("dataLayer" in window).toBe(false);
});

it("その名前の値に push が無くても例外を出さず、値も壊さない", async () => {
  const occupied = { site: "owned" };
  (window as unknown as Record<string, unknown>).myDL = occupied;
  const f = routedFetch(() => res(429));
  const settings = { ...namedSettings, analytics: { ...renamedAnalytics, dataLayerName: "myDL" } };
  createRuntime(makeDeps(f.fn), { config: remoteConfig, settings });
  await expect(flush()).resolves.toBeUndefined();
  expect(f.calls.length).toBe(1);
  expect(occupied).toEqual({ site: "owned" });
});

it("同意が無い(required で未許可)ときは送信そのものが無いので積まない", async () => {
  const f = routedFetch(() => res(429));
  createRuntime(makeDeps(f.fn), { config: remoteConfig, settings: { ...baseSettings, consentMode: "required" } });
  await flush();
  expect(f.calls.length).toBe(0);
  expect(dataLayer()).toEqual([]);
});

it("撤回の送信(kind: consent)が 429 でも積まない", async () => {
  const f = routedFetch((_url, body) => (body.kind === "consent" ? res(429) : res(200, { v: 3, experiments: [] })));
  const api = createRuntime(makeDeps(f.fn), { config: baseConfig, settings: dliteSettings });
  await flush();
  api.consent(false);
  await flush();
  expect(f.calls.some((c) => c.body.kind === "consent")).toBe(true);
  expect(abErrors(dataLayer())).toEqual([]);
});

it("撤回の後に届いた 429 は積まない", async () => {
  let resolve!: (r: Response) => void;
  const pending = new Promise<Response>((r) => (resolve = r));
  const fn = (() => pending) as typeof fetch;
  const api = createRuntime(makeDeps(fn), { config: remoteConfig, settings: baseSettings });
  await flush();
  api.consent(false);
  resolve(res(429));
  await flush();
  expect(abErrors(dataLayer())).toEqual([]);
});
