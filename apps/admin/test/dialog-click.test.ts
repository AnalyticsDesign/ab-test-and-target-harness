import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DIALOG_CLICK_GUARD_MS, dialogEffectStep, ignoreDialogClick } from "@/lib/dialog-click";
import { cancelCurrent, confirmCurrent, emptyQueue, enqueue, failHold, finishCurrent, releaseAll, releaseOwner, type ConfirmQueue } from "@/lib/confirm-queue";

/**
 * 確認のモーダルの、開いた直後のクリックの無視(B173 第 2 段 Task 2)。
 * ダブルクリックの 2 回目が、1 回目で開いた確認の背面・ボタンの上に落ちても、確認を閉じたり確定したりしない。キーボードの押下は無視しない
 */
describe("ignoreDialogClick", () => {
  it("ignores pointer clicks within 500 ms after open", () => {
    expect(ignoreDialogClick({ openedAt: 1000, now: 1499, pointer: true })).toBe(true);
    expect(ignoreDialogClick({ openedAt: 1000, now: 1500, pointer: true })).toBe(false);
  });
  it("never ignores keyboard activation", () => {
    expect(ignoreDialogClick({ openedAt: 1000, now: 1001, pointer: false })).toBe(false);
  });
  it("does nothing before the dialog opened", () => {
    expect(ignoreDialogClick({ openedAt: null, now: 0, pointer: true })).toBe(false);
  });
  it("the guard is 500 ms", () => {
    expect(DIALOG_CLICK_GUARD_MS).toBe(500);
  });
  it("ConfirmDialog checks the guard at the head of the backdrop, confirm and cancel handlers and reads the clock through lib", () => {
    const src = readFileSync(path.join(import.meta.dirname, "../components/ui/ConfirmDialog.tsx"), "utf8");
    expect(src.match(/ignored\(e\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src).toContain("dialogNow()");
    expect(src).not.toMatch(/performance\.now\(\)/);
  });
});

/**
 * 確認の待ち行列(components/ConfirmProvider.tsx が持つ。B173 第 2 段 Task 2)。
 * 要求は持ち主(BusyScope の id。範囲の外は null)を持つ。持ち続ける間(holding / failed)に来た要求は後に回す
 */
type Req = { name: string; owner: string | null; hold: boolean };
const req = (name: string, owner: string | null = null, hold = false): Req => ({ name, owner, hold });
const names = (rs: Req[]) => rs.map((r) => r.name);
const shown = (q: ConfirmQueue<Req>) => (q.current ? `${q.current.req.name}:${q.current.phase}` : null);

describe("confirm queue", () => {
  it("shows a request at once when nothing is open", () => {
    const r = enqueue(emptyQueue<Req>(), req("a"));
    expect(shown(r.queue)).toBe("a:shown");
    expect(r.cancelled).toEqual([]);
  });

  it("a new request replaces a shown confirm and cancels it (as before)", () => {
    const q = enqueue(emptyQueue<Req>(), req("a")).queue;
    const r = enqueue(q, req("b"));
    expect(shown(r.queue)).toBe("b:shown");
    expect(names(r.cancelled)).toEqual(["a"]);
  });

  it("a request that comes while a hold is holding waits until it closes", () => {
    let q = enqueue(emptyQueue<Req>(), req("h", "scope", true)).queue;
    const c = confirmCurrent(q);
    expect(c.held).toBe(true);
    q = c.queue;
    expect(shown(q)).toBe("h:holding");
    const r = enqueue(q, req("leave"));
    expect(r.cancelled).toEqual([]);
    expect(shown(r.queue)).toBe("h:holding");
    expect(names(r.queue.waiting)).toEqual(["leave"]);
    expect(shown(finishCurrent(r.queue))).toBe("leave:shown");
  });

  it("a failed hold still holds: new requests wait, a retry goes back to holding, a cancel lets the next one in", () => {
    let q = confirmCurrent(enqueue(emptyQueue<Req>(), req("h", "scope", true)).queue).queue;
    q = failHold(q);
    expect(shown(q)).toBe("h:failed");
    q = enqueue(q, req("leave")).queue;
    expect(shown(q)).toBe("h:failed");
    const retry = confirmCurrent(q);
    expect(retry.held).toBe(true);
    expect(shown(retry.queue)).toBe("h:holding");
    const back = cancelCurrent(failHold(retry.queue));
    expect(names(back.cancelled)).toEqual(["h"]);
    expect(shown(back.queue)).toBe("leave:shown");
  });

  it("confirming a plain ask closes it and shows the next waiting request", () => {
    const q: ConfirmQueue<Req> = { current: { req: req("a"), phase: "shown" }, waiting: [req("b")] };
    const c = confirmCurrent(q);
    expect(c.held).toBe(false);
    expect(shown(c.queue)).toBe("b:shown");
  });

  it("a cancel while holding is ignored (the write is still running)", () => {
    const q = confirmCurrent(enqueue(emptyQueue<Req>(), req("h", "scope", true)).queue).queue;
    const r = cancelCurrent(q);
    expect(r.cancelled).toEqual([]);
    expect(shown(r.queue)).toBe("h:holding");
  });

  it("releasing an owner closes its shown hold and drops its waiting requests, other owners stay", () => {
    let q = confirmCurrent(enqueue(emptyQueue<Req>(), req("h", "a", true)).queue).queue;
    q = enqueue(q, req("a2", "a")).queue;
    q = enqueue(q, req("b1", "b")).queue;
    q = enqueue(q, req("leave", null)).queue;
    const r = releaseOwner(q, "a");
    expect(names(r.cancelled)).toEqual(["h", "a2"]);
    expect(shown(r.queue)).toBe("b1:shown");
    expect(names(r.queue.waiting)).toEqual(["leave"]);
  });

  it("releasing an owner that is not shown only drops its waiting requests", () => {
    let q = confirmCurrent(enqueue(emptyQueue<Req>(), req("h", "a", true)).queue).queue;
    q = enqueue(q, req("b1", "b")).queue;
    const r = releaseOwner(q, "b");
    expect(names(r.cancelled)).toEqual(["b1"]);
    expect(shown(r.queue)).toBe("h:holding");
    expect(r.queue.waiting).toEqual([]);
  });

  it("releasing an owner twice (a reused BusyScope id) is harmless", () => {
    const q = enqueue(emptyQueue<Req>(), req("a", "x")).queue;
    const once = releaseOwner(q, "x");
    const twice = releaseOwner(once.queue, "x");
    expect(twice.cancelled).toEqual([]);
    expect(twice.queue).toEqual(emptyQueue());
  });

  it("releasing everything (page change) cancels the current one and all waiting requests", () => {
    let q = confirmCurrent(enqueue(emptyQueue<Req>(), req("h", "a", true)).queue).queue;
    q = enqueue(q, req("leave")).queue;
    const r = releaseAll(q);
    expect(names(r.cancelled)).toEqual(["h", "leave"]);
    expect(r.queue).toEqual(emptyQueue());
  });
});

/**
 * 確認のモーダルの effect の判定(レビュー r1 Important 2)。待ち行列から次の確認が出たとき、<dialog> は開いたままなので
 * showModal() をし直さない。前の確認の 0.5 秒の時計・フォーカスを持ち越さないよう、確認ごとの鍵(requestKey)の変化で取り直す
 */
describe("dialogEffectStep", () => {
  const base = { open: true, elementOpen: true, busy: false, wasBusy: false, keyChanged: false, neverOpened: false };
  it("opens a closed dialog, restarts the clock and focuses the initial button", () => {
    expect(dialogEffectStep({ ...base, elementOpen: false, neverOpened: true })).toEqual({ show: true, close: false, restartClock: true, focus: "initial" });
  });
  it("reopening under the overlay does not move focus (the content is inert)", () => {
    expect(dialogEffectStep({ ...base, elementOpen: false, busy: true, wasBusy: true })).toEqual({ show: true, close: false, restartClock: true, focus: null });
  });
  it("a new confirm in a dialog that stays open restarts the clock and focuses the initial button", () => {
    expect(dialogEffectStep({ ...base, keyChanged: true, wasBusy: true })).toEqual({ show: false, close: false, restartClock: true, focus: "initial" });
  });
  it("when the overlay comes off (hold.fail) focus goes back to the confirm button", () => {
    expect(dialogEffectStep({ ...base, wasBusy: true })).toEqual({ show: false, close: false, restartClock: false, focus: "confirm" });
  });
  it("closes an open dialog when the confirm is closed", () => {
    expect(dialogEffectStep({ ...base, open: false })).toEqual({ show: false, close: true, restartClock: false, focus: null });
  });
  it("does nothing on a re-render of the same confirm", () => {
    expect(dialogEffectStep(base)).toEqual({ show: false, close: false, restartClock: false, focus: null });
  });
  it("the provider gives each queued confirm its own key and ConfirmDialog resets on it", () => {
    const provider = readFileSync(path.join(import.meta.dirname, "../components/ConfirmProvider.tsx"), "utf8");
    expect(provider).toContain("requestKey={view?.entry.id}");
    expect(provider.match(/id: \+\+nextEntryId/g)?.length).toBe(2);
    const dialog = readFileSync(path.join(import.meta.dirname, "../components/ui/ConfirmDialog.tsx"), "utf8");
    expect(dialog).toContain("dialogEffectStep(");
    expect(dialog).toMatch(/requestKey !== seenKey/);
  });
});
