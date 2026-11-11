// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

function render(over: { single?: boolean; emphasizeCancel?: boolean } = {}) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(ConfirmDialog, {
    open: true, title: "移動しますか?", confirmLabel: "移動する", cancelLabel: "とどまる",
    onConfirm: () => {}, onCancel: () => {}, ...over,
  }));
  const button = (name: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === name)!;
  return { host, button };
}

describe("ConfirmDialog のボタン配置", () => {
  it.each([false, true])("キャンセルから実行へ DOM・Tab の順が続く(emphasizeCancel=%s)", (emphasizeCancel) => {
    const { button } = render({ emphasizeCancel });
    const cancel = button("とどまる");
    const confirm = button("移動する");
    expect(cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cancel.tabIndex).toBe(0);
    expect(confirm.tabIndex).toBe(0);
  });

  it("知らせるだけの確認は実行のボタンだけを出す", () => {
    const { host, button } = render({ single: true });
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(button("移動する")).toBeDefined();
  });
});
