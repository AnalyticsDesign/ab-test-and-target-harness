import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageMark } from "@/components/ui/PageMark";
import { ProductVersion } from "@/components/settings-personal/ProductVersion";
import { loadCapabilities } from "@/lib/loaders";
import { RELEASE_VERSION } from "@/generated/release";

export default async function AboutPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const caps = await loadCapabilities();
  return (
    <>
      <PageMark path={`/w/me/about`} search={await searchParams} />
      <TopBar crumbs={[{ label: "設定" }, { label: "この導入について" }]} scope={{ wid: null, sid: null }} />
      <Content>
        <PageHeader title="この導入について" />
        <ProductVersion admin={RELEASE_VERSION} control={caps.productVersion} apiVersion={caps.apiVersion} />
      </Content>
    </>
  );
}
