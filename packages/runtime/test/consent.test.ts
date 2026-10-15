import { expect, it, vi } from "vitest";
import { createConsent } from "../src/consent";

function hooks() {
  return { onGrant: vi.fn(), onRevoke: vi.fn() };
}

it("implicit mode starts granted (spec §16)", () => {
  const h = hooks();
  expect(createConsent("implicit", undefined, h).state).toBe("granted");
  expect(h.onGrant).not.toHaveBeenCalled(); // 初期状態はフックを発火しない(起動側が state を見て開始する)
});

it("implicit mode honors an explicit denied preset and ignores the rest (spec §16、2026-09-01 決定)", () => {
  // preset だけを出力し AB.consent() を呼ばないサイトで、拒否がまったく効かない状態を避ける
  expect(createConsent("implicit", "denied", hooks()).state).toBe("denied");
  expect(createConsent("implicit", "pending", hooks()).state).toBe("granted"); // implicit に「待ち」は持ち込まない
  expect(createConsent("implicit", "granted", hooks()).state).toBe("granted");
  expect(createConsent("implicit", "bogus", hooks()).state).toBe("granted");
});

it("required without preset starts pending; granted/denied presets are honored (spec §16)", () => {
  expect(createConsent("required", undefined, hooks()).state).toBe("pending");
  expect(createConsent("required", "granted", hooks()).state).toBe("granted");
  expect(createConsent("required", "denied", hooks()).state).toBe("denied");
  expect(createConsent("required", "bogus", hooks()).state).toBe("pending"); // 未知値は pending(fail-closed)
});

it("fires onGrant only on transitions into granted (spec §16 起動処理は 1 回)", () => {
  const h = hooks();
  const c = createConsent("required", undefined, h);
  c.set(true);
  c.set(true); // granted -> granted は no-op
  expect(h.onGrant).toHaveBeenCalledTimes(1);
});

it("fires onRevoke on transition into denied, and onGrant again after re-grant (spec §16)", () => {
  const h = hooks();
  const c = createConsent("required", "granted", h);
  c.set(false);
  expect(h.onRevoke).toHaveBeenCalledTimes(1);
  c.set(false); // denied -> denied は no-op
  expect(h.onRevoke).toHaveBeenCalledTimes(1);
  c.set(true); // revoke 後の再 grant は再び onGrant(新 ID 発行は起動側の責務)
  expect(h.onGrant).toHaveBeenCalledTimes(1);
});
