import { notFound } from "next/navigation";
import { requireUser } from "@/lib/control";
import { loadCapabilities, loadSite, loadWorkspaces } from "@/lib/loaders";
import { readParam } from "@/lib/url-state";
import { PageHeader } from "@/components/ui/PageHeader";
import { SECTION_IDS } from "@/components/settings/sections";
import { SiteSettingsForm } from "@/components/settings/SiteSettingsForm";

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ wid: string; sid: string }>; searchParams: Promise<{ section?: string }> }) {
  await requireUser();
  const { wid, sid } = await params;
  const site = await loadSite(sid);
  const ws = (await loadWorkspaces()).find((w) => w.id === wid);
  if (site.status !== 200 || !ws) notFound();
  const caps = await loadCapabilities();
  const initialSection = readParam(`?section=${(await searchParams).section ?? ""}`, "section", SECTION_IDS, "general");
  return (
    <div>
      <PageHeader title="設定" meta={site.data.name} />
      <SiteSettingsForm site={site.data} canAdmin={ws.role === "owner" || ws.role === "admin"} canDelete={ws.role === "owner"} tagOrigin={caps.tagOrigin} initialSection={initialSection} />
    </div>
  );
}
