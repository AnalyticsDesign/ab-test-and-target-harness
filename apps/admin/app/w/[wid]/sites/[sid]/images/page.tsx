import { controlFetch, requireUser } from "@/lib/control";
import { allInOrder, loadCapabilities, loadWorkspaces } from "@/lib/loaders";
import { imagesPageMode, initialAssets, readListParams } from "@/lib/images";
import type { AssetListResponse } from "@/lib/types";
import { ImageLibrary } from "@/components/images/ImageLibrary";
import { ErrorBox } from "@/components/ErrorBox";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageMark } from "@/components/ui/PageMark";

/**
 * サイトの画像(B68。spec §9.1・§9.2)。R2 があればライブラリ、R2 なしで画像アップローダーがあればその画面の差し込み場所、どちらも無ければ案内だけ。
 * 一覧の GET は R2 の有無によらず同じ並列の段で呼ぶ(capabilities を待ってから呼び分けると直列の段が 1 つ増えるため。R2 なしの応答は空)。
 * capabilities は外枠(app/w/layout.tsx)と同じ GET なので、同じ描画の中でまとまり、control への往復は増えない。
 * 一覧が INLINE_ASSETS_MAX を超えるサイトでは、ImageLibrary がマウントの後に BFF で全件を 1 回読む(この画面の描画の往復には入らない。
 * 1,000 枚の全件を描画で渡すと、RSC の直列化と HTML への埋め込みで admin の CPU が大きく増えたため。Q331)
 */
export default async function ImagesPage({ params, searchParams }: { params: Promise<{ wid: string; sid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { wid, sid } = await params;
  const search = await searchParams;
  const [, workspaces, listRes, caps] = await allInOrder([requireUser(), loadWorkspaces(), controlFetch<AssetListResponse>(`/sites/${sid}/assets`), loadCapabilities()]);
  const ws = workspaces.find((w) => w.id === wid);
  const mode = imagesPageMode(caps);
  const mark = <PageMark path={`/w/${wid}/sites/${sid}/images`} search={search} />;

  if (mode === "guide") {
    return (
      <>
        {mark}
        <PageHeader title="画像" />
        <section className="card">
          <h2>この導入では画像のアップロードを使えません</h2>
          <p>画像を置く場所(R2)を使わない構成で導入されています。パターンで画像を差し替えるときは、変更の種類「ATTRIBUTE」で src に画像の URL を書いてください。</p>
          <p className="muted">画像のアップロードを有効にするには、R2 のバケットの binding と公開ベース URL(AB_ASSET_PUBLIC_BASE)を設定して再デプロイします。</p>
        </section>
      </>
    );
  }

  if (mode === "uploader") {
    // R2 なしの画像アップローダーの画面を差し込む場所。部品はアップローダーの作業が作るので、それまでは案内だけを出す
    return (
      <>
        {mark}
        <PageHeader title="画像" />
        <section className="card">
          <h2>この導入では、画像はアップローダーで扱います</h2>
          <p>画像を置く場所(R2)を使わない構成で導入されています。この画面にアップローダーが入るまでは、画像の URL を ATTRIBUTE の src に書いて差し替えてください。</p>
        </section>
      </>
    );
  }

  if (listRes.status !== 200) {
    return (
      <>
        {mark}
        <PageHeader title="画像" />
        <ErrorBox message={`画像の一覧を取得できませんでした(HTTP ${listRes.status})。再読み込みしてください`} />
      </>
    );
  }

  // クライアントの部品には今表示するページの分だけを渡す(全件が少なければ全件)。残りは部品がマウントの後に BFF で 1 回読む
  const listParams = readListParams(search);
  return (
    <>
      {mark}
      <ImageLibrary wid={wid} siteId={sid} initial={initialAssets(listRes.data, listParams)} canEdit={ws?.role !== "viewer"} initialParams={listParams} />
    </>
  );
}
