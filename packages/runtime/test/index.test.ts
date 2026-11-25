import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntime } from "../src/runtime";

vi.mock("../src/runtime", () => ({ createRuntime: vi.fn() }));

const bootPayload = {};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("__WTT_BOOT__", bootPayload);
  vi.stubGlobal("__WTT_BOOTED__", false);
  vi.stubGlobal("__WTT_NONCE__", null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("起動時に HTML の script 要素であることを確かめてから読み込み元を渡す", async () => {
  const script = document.createElement("script");
  const src = "https://edge.test/s/site-unit.js";
  script.src = src;
  script.nonce = "test-nonce";
  vi.spyOn(document, "currentScript", "get").mockReturnValue(script);
  const readSource = vi.spyOn(script, "src", "get");

  // 実際の型判定を使いつつ、src の読み出しより先に判定したことを確かめる。
  const NativeHTMLScriptElement = HTMLScriptElement;
  const checkScriptElement = vi.fn((element: unknown) => element instanceof NativeHTMLScriptElement);
  vi.stubGlobal("HTMLScriptElement", { [Symbol.hasInstance]: checkScriptElement });

  await import("../src/index");

  expect(checkScriptElement).toHaveBeenCalledWith(script);
  expect(checkScriptElement.mock.invocationCallOrder[0]).toBeLessThan(readSource.mock.invocationCallOrder[0]!);
  expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ scriptSrc: src, nonce: "test-nonce" }), bootPayload);
});

it("script 要素が無ければ読み込み元なしで起動する", async () => {
  vi.spyOn(document, "currentScript", "get").mockReturnValue(null);

  await import("../src/index");

  expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ scriptSrc: null, nonce: null }), bootPayload);
});
