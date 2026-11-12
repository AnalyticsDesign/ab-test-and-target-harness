// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IssueKeyForm } from "@/components/api-keys/IssueKeyForm";

vi.mock("@/components/ui/BusyScope", () => ({ useBusyAction: () => ({ busy: false, run: vi.fn() }) }));
// 必須項目による disabled と独立に、hydration による送信の抑止を確かめる。
// 必須項目の判定自体は api-keys.test.ts で実際の関数を検査する。
vi.mock("@/lib/api-keys", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api-keys")>(),
  issueMissing: () => null,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const element = () => createElement(IssueKeyForm, {
  workspaces: [{ id: "test-workspace", name: "Test", role: "owner" }],
  amInstanceAdmin: false,
  onIssued: vi.fn(),
});

describe("API key issuance native form safety", () => {
  const ssr = () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(element());
    return host;
  };
  it("uses POST for native form submission", () => {
    const form = ssr().querySelector("form")!;
    expect(form).not.toBeNull();
    expect(form.getAttribute("method")).toBe("post");
  });
  it("disables submission in the server-rendered HTML", () => {
    const button = ssr().querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
  });
  it("enables submission after the component mounts when required fields allow it", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    document.body.append(host);
    try {
      act(() => root.render(element()));
      expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
