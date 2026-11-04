import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dialogCloseEvent } from "@/lib/dialog-close";

/**
 * 確認のモーダル(components/ui/ConfirmDialog.tsx)の close イベントの判定(B173 第 1 段 最終レビュー FR-Medium-3・台帳 117)。
 * close イベントは close() の後のタスクで届く。閉じた直後に次の確認を開くと、前の close() のイベントが、次の確認の open=true の後・
 * showModal() の前に届きうる。DOM の今の open だけでは古いイベントと見分けられないので、自分で呼んだ close() の数で見分ける
 */
describe("dialogCloseEvent", () => {
  it("ignores the event of its own close() even when it lands before the next showModal()", () => {
    // 次の確認の open=true が描かれた後、effect の showModal() の前(要素はまだ閉じている)に古いイベントが届く
    expect(dialogCloseEvent({ open: true, elementOpen: false, selfClosePending: 1 })).toEqual({ cancel: false, reopen: false, selfClosePending: 0 });
  });

  it("ignores the event of its own close() after the next showModal()", () => {
    expect(dialogCloseEvent({ open: true, elementOpen: true, selfClosePending: 1 })).toEqual({ cancel: false, reopen: false, selfClosePending: 0 });
  });

  it("cancels when the browser closed the dialog without our close()", () => {
    expect(dialogCloseEvent({ open: true, elementOpen: false, selfClosePending: 0 })).toEqual({ cancel: true, reopen: false, selfClosePending: 0 });
  });

  it("does nothing for an event while the confirm is not open", () => {
    expect(dialogCloseEvent({ open: false, elementOpen: false, selfClosePending: 0 })).toEqual({ cancel: false, reopen: false, selfClosePending: 0 });
  });

  it("reopens instead of cancelling when the browser closed the dialog while it holds (a second Esc under the overlay)", () => {
    expect(dialogCloseEvent({ open: true, elementOpen: false, selfClosePending: 0, holding: true })).toEqual({ cancel: false, reopen: true, selfClosePending: 0 });
  });

  it("its own close() is still consumed first while it holds", () => {
    expect(dialogCloseEvent({ open: true, elementOpen: false, selfClosePending: 1, holding: true })).toEqual({ cancel: false, reopen: false, selfClosePending: 0 });
  });

  it("the component counts its own close() right before calling it and judges events with dialogCloseEvent", () => {
    const src = readFileSync(path.join(import.meta.dirname, "../components/ui/ConfirmDialog.tsx"), "utf8");
    expect(src).toMatch(/selfClosePending\.current \+= 1;\s*d\.close\(\)/);
    expect(src).toContain("dialogCloseEvent(");
    // 覆いの間に閉じられたら開き直す
    expect(src).toMatch(/if \(r\.reopen\)[\s\S]{0,80}show\(d\)/);
    expect(src).toMatch(/const show = \(d: HTMLDialogElement\) => \{\s*d\.showModal\(\);/);
  });
});
