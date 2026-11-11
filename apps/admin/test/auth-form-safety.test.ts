// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PasswordLoginForm } from "@/app/(auth)/login/PasswordLoginForm";
import { AcceptInviteForm } from "@/app/(auth)/invite/[id]/AcceptInviteForm";
import ResetPage from "@/app/(auth)/reset/page";
import SetupPage from "@/app/(auth)/setup/page";
import { MembersPanel } from "@/components/MembersPanel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams("token=test-reset-token") }));
vi.mock("@/components/ConfirmProvider", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/ui/BusyScope", () => ({ BusyScope: ({ children }: { children: ReactElement }) => children, useBusyAction: () => ({ busy: false, run: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cases: Array<[string, () => ReactElement]> = [
  ["emergency login", () => createElement(PasswordLoginForm)],
  ["emergency invitation acceptance", () => createElement(AcceptInviteForm, { id: "test-invite", email: "invited@example.test", role: "editor", workspaceName: "Test", view: "sign-in-or-password", signedInEmail: null })],
  ["password reset", () => createElement(ResetPage)],
  ["initial setup", () => createElement(SetupPage)],
  ["member invitation", () => createElement(MembersPanel, { workspaceId: "test-workspace", myRole: "owner", myUserId: "test-user", members: [], invitations: [], canIssueResetLink: false, amInstanceAdmin: false, scopeText: "Test" })],
];

for (const [label, element] of cases) {
  describe(label, () => {
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
    it("enables submission after the component mounts", () => {
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
}
