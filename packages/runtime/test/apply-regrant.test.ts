import { expect, it, vi } from "vitest";
import type { Change } from "@wtt/core";
import { runCustomJs } from "../src/code";
import { createApplyEngine, createPageState } from "../src/apply";

// 既定の happy-dom は <script> を実行しないので、CUSTOM_JS の「成功」をモックで作る(実行の実体は code.test.ts と E2E が持つ)
vi.mock("../src/code", () => ({ runCustomJs: vi.fn(() => ({ ok: true })), activateScripts: vi.fn(() => []) }));

it("succeeded_change_exposes_after_regrant_even_if_selector_changed", () => {
  // r2 CX-High-1: CUSTOM_JS が対象要素の class を変える(selector から外れる)。再許可の新世代は DOM を再発見できないが、
  // PageState.succeeded によって Exposure を 1 回出し、再実行はしない(§10.4 + §16)
  document.body.innerHTML = `<h1 class="hero-title">x</h1>`;
  const state = createPageState();
  const change = { id: "c_js", type: "CUSTOM_JS", selector: ".hero-title", payload: { code: "element.className='changed'" } } as Change;
  const onApplied1 = vi.fn();
  const gen1 = createApplyEngine(document, { onApplied: onApplied1, onControlSeen: vi.fn() }, { state });
  gen1.start([{ experimentId: "e", variantId: "vB", change }], []);
  document.querySelector(".hero-title")!.className = "changed"; // モックは DOM を触らないので、コードの効果をここで模す
  expect(onApplied1).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runCustomJs)).toHaveBeenCalledTimes(1);
  gen1.stop();

  const onApplied2 = vi.fn();
  const gen2 = createApplyEngine(document, { onApplied: onApplied2, onControlSeen: vi.fn() }, { state });
  gen2.start([{ experimentId: "e", variantId: "vB", change }], []);
  expect(onApplied2).toHaveBeenCalledTimes(1); // selector は一致しないが成功記録から Exposure
  expect(vi.mocked(runCustomJs)).toHaveBeenCalledTimes(1); // 再実行しない
  gen2.stop();
});
