import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { DisplaySettings } from "@/components/settings-personal/DisplaySettings";
import { PageMark } from "@/components/ui/PageMark";

export default async function DisplayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <>
      <PageMark path={`/w/me/display`} search={await searchParams} />
      <TopBar crumbs={[{ label: "設定" }, { label: "画面表示" }]} scope={{ wid: null, sid: null }} />
      <Content>
        <PageHeader title="画面表示" />
        <DisplaySettings />
      </Content>
    </>
  );
}
