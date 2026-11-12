import { Content } from "@/components/ui/AppShell";
import { TopBar } from "@/components/ui/TopBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageMark } from "@/components/ui/PageMark";
import { ProductVersion } from "@/components/settings-personal/ProductVersion";
import { loadCapabilities } from "@/lib/loaders";
import { requireUser } from "@/lib/control";
import { RELEASE_VERSION } from "@/generated/release";

export default async function AboutPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // 守る値(管理画面の版)が手元の定数で、loadCapabilities は 401 でも既定値を返すので、/w の layout の守りだけに頼らずページでも確かめる。
  // requireUser は React の cache 付きで、layout と同じ描画の中では /me を 1 回にまとめる(往復は増えない)
  await requireUser();
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
