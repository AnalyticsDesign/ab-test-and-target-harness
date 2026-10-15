import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { DisplaySettings } from "@/components/settings-personal/DisplaySettings";

export default function DisplayPage() {
  return (
    <>
      <TopBar crumbs={[{ label: "設定" }, { label: "画面表示" }]} />
      <Content>
        <PageHeader title="画面表示" />
        <DisplaySettings />
      </Content>
    </>
  );
}
