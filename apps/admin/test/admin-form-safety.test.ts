// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYTICS } from "@wtt/core";
import { SiteCreateForm } from "@/components/SiteForms";
import { WorkspaceCreateForm } from "@/components/WorkspaceForms";
import { ExperimentCreateForm } from "@/components/ExperimentCreateForm";
import { GoalsPanel } from "@/components/GoalsPanel";
import { InstanceAdminsPanel } from "@/components/InstanceAdminsPanel";
import { AuditLogPanel } from "@/components/audit/AuditLogPanel";
import { SiteSettingsForm } from "@/components/settings/SiteSettingsForm";
import { UsagePanel } from "@/components/usage/UsagePanel";
import { DEFAULT_AUDIT_FILTER } from "@/lib/audit-log";
import type { Site } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/w/w1/sites/s1/settings", useSearchParams: () => new URLSearchParams(), useParams: () => ({ wid: "w1", sid: "s1" }) }));
vi.mock("@/components/ConfirmProvider", () => ({ useConfirm: () => vi.fn(), useConfirmWithOption: () => vi.fn() }));
vi.mock("@/components/ui/BusyScope", () => ({ BusyScope: ({ children }: { children: ReactElement }) => children, useBusyAction: () => ({ busy: false, run: vi.fn() }) }));
vi.mock("@/lib/use-refresh-and-wait", () => ({ useRefreshAndWait: () => vi.fn() }));
// サイト追加の初回の使用状況取得だけを止め、フォーム自体は実際の部品を描画する。
vi.mock("@/lib/client", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/client")>(), api: () => Promise.resolve(null) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const site: Site = {
  id: "s1", workspaceId: "w1", name: "Test", mode: "A", idSource: "ab",
  domain: "www.example.test", domains: [{ value: "www.example.test", verdict: "outside", checkedAt: 1, triedAt: 1 }],
  allowedOrigins: ["https://www.example.test"], edgeDomains: [], outsideDomains: ["www.example.test"], uncheckedDomains: [],
  retentionDays: 90, consentMode: "implicit", forgetOnRevoke: true, resultsEnabled: false, resultsRetentionDays: 90, newProfileBudgetPerDay: null,
  timezone: "Asia/Tokyo", decisionTimeoutMs: 1000, visitorCookieName: "_wtt_vid", uuidCookieEnabled: false, uuidCookieName: "_wtt_uuid",
  previousCookieNames: [], shareSubdomains: false, cookieGroups: [], analytics: DEFAULT_ANALYTICS, ga4PropertyId: null, bigqueryDataset: null,
  activeVersion: null, activeKvStale: false, staticStale: false, staticRemoving: false, lastActivatedAt: null, contentUpdatedAt: 1, createdAt: 1, updatedAt: 1,
};
const audit = () => createElement(AuditLogPanel, { scope: "instance", apiPath: "/audit-events", initialFilter: { ...DEFAULT_AUDIT_FILTER, from: 1000, to: 2000 }, initialQuery: "since=1000&until=2000", initialPage: { events: [], nextCursor: null } });
const cases: Array<{ label: string; element: () => ReactElement; selector?: string; button?: string; disabledAfterMount?: boolean }> = [
  { label: "site creation", element: () => createElement(SiteCreateForm, { workspaceId: "w1", visibleSites: 0 }) },
  { label: "workspace creation", element: () => createElement(WorkspaceCreateForm) },
  { label: "experience creation", element: () => createElement(ExperimentCreateForm, { wid: "w1", sid: "s1" }) },
  { label: "goal addition", element: () => createElement(GoalsPanel, { siteId: "s1", goals: [], canEdit: true, names: DEFAULT_ANALYTICS }) },
  { label: "instance admin addition", element: () => createElement(InstanceAdminsPanel, { admins: [], candidates: [], workspaces: [], myUserId: "u1" }), disabledAfterMount: true },
  { label: "audit range", element: audit, selector: 'form[aria-label="期間の日時"]' },
  { label: "break glass range", element: audit, selector: '[data-testid="break-glass-window"] form' },
  { label: "site settings", element: () => createElement(SiteSettingsForm, { site, canAdmin: true, canDelete: true, tagOrigin: null, initialSection: "general", resultsStore: false, edgeOrigin: null, runningTests: 0, runningRecordedTests: 0 }), button: 'button[form="site-settings-form"]' },
  { label: "usage settings", element: () => createElement(UsagePanel, { settings: { usageVisibility: "members", cloudflarePlan: "free", showPaidReference: false }, usage: { ok: false, title: "Unavailable", hint: "Try later" }, controlCapacity: null }), disabledAfterMount: true },
];

for (const { label, element, selector = "form", button = `${selector} button[type="submit"]`, disabledAfterMount = false } of cases) {
  describe(label, () => {
    const ssr = () => {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(element());
      return host;
    };
    it("uses POST for native form submission", () => {
      const form = ssr().querySelector(selector)!;
      expect(form).not.toBeNull();
      expect(form.getAttribute("method")).toBe("post");
    });
    it("disables submission in the server-rendered HTML", () => {
      const submit = ssr().querySelector<HTMLButtonElement>(button)!;
      expect(submit).not.toBeNull();
      expect(submit.disabled).toBe(true);
    });
    it("removes the hydration block after mount and preserves existing eligibility rules", async () => {
      const host = document.createElement("div");
      const root = createRoot(host);
      document.body.append(host);
      try {
        await act(async () => root.render(element()));
        expect(host.querySelector<HTMLButtonElement>(button)!.disabled).toBe(disabledAfterMount);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    });
  });
}
