"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, describeError } from "@/lib/client";
import { expandAssetList, type ImageFieldMode } from "@/lib/images";
import { createFieldUploader, createSiteAssetsStore, type FieldUploadResult, type FieldUploader, type SiteAssetsSnapshot, type SiteAssetsStore } from "@/lib/site-assets-store";
import { describeUploadError, sendUpload } from "@/lib/use-upload-queue";
import { BusyScope } from "@/components/ui/BusyScope";
import type { AssetListResponse, SiteAsset } from "@/lib/types";
import { ImagePicker } from "./ImagePicker";

type SiteAssetsContextValue = {
  siteId: string;
  mode: ImageFieldMode;
  store: SiteAssetsStore;
  snapshot: SiteAssetsSnapshot;
  /** 選ぶ窓を開く。選んだ画像(キャンセルは null)で解ける。initialSrc = 今の画像の URL(開いたときに選んでおく) */
  pick: (initialSrc: string) => Promise<SiteAsset | null>;
  /** IMAGE の欄に落とした 1 枚を送る(provider の層で送るので、欄が外れても一覧に入り、離れる前の確認も残る)。一覧を読み終わってから積む */
  uploadOne: (file: File) => Promise<FieldUploadResult>;
};

const IDLE: SiteAssetsSnapshot = { status: "idle", list: null, error: null };
const SiteAssetsContext = createContext<SiteAssetsContextValue | null>(null);

/** provider の外(使わない画面)では null */
export function useSiteAssets(): SiteAssetsContextValue | null {
  return useContext(SiteAssetsContext);
}

/**
 * パターンの画面のサイトの画像の一覧(B68。spec §9.3・§9.4 の Q12)。エクスペリエンスの画面(ExperimentEditor の外枠)に 1 つ置く。
 * preload(マウントの時点の下書きに IMAGE の変更がある)ときだけ、マウントの後に BFF で一覧を 1 回読む。無ければ窓を初めて開いたときに読む。
 * 読んだ後は窓・IMAGE の欄・窓の中のアップロードが共有し、読み直さない。描画(サーバー)では読まない。
 * 選ぶ窓はここに 1 つだけ置く(パターンを切り替えても、窓の中のアップロードの待ち行列が消えないように)
 */
export function SiteAssetsProvider({ siteId, mode, preload, children }: { siteId: string; mode: ImageFieldMode; preload: boolean; children: ReactNode }) {
  const storeRef = useRef<SiteAssetsStore | null>(null);
  storeRef.current ??= createSiteAssetsStore({ load: async () => expandAssetList(await api<AssetListResponse>("GET", `/sites/${siteId}/assets`)), describe: describeError });
  const store = storeRef.current;
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, () => IDLE);

  // 欄のドロップの待ち行列(窓の待ち行列と同じく、パターン・タブを切り替えても消えない層に置く)
  const uploaderRef = useRef<FieldUploader<File> | null>(null);
  uploaderRef.current ??= createFieldUploader<File>({ send: (file) => sendUpload(siteId, file), store, describe: describeUploadError });
  const uploader = uploaderRef.current;
  const uploading = useSyncExternalStore(uploader.subscribe, uploader.active, () => false);
  // 画面を離れたら待っている分は送らない(離れる前の確認の文言のとおり)。StrictMode のマウントのやり直しでは取り消す
  useEffect(() => {
    uploader.revive();
    return () => uploader.dispose();
  }, [uploader]);
  const uploadOne = useCallback(
    async (file: File): Promise<FieldUploadResult> => {
      // 上限の判定は手元の usage を使うので、一覧を読み終わってから積む(読みは 1 回。もう読んでいればすぐ解ける)
      await store.ensure();
      const s = store.snapshot();
      if (s.status !== "ready") return { ok: false, error: `画像の一覧を読めませんでした: ${s.error ?? ""}` };
      return uploader.upload(file);
    },
    [store, uploader],
  );

  // マウントの時点の下書きだけを見る(後から IMAGE を足したときは、窓を開いたときに読む)
  const preloadRef = useRef(preload && mode === "picker");
  useEffect(() => {
    if (preloadRef.current) void store.ensure();
  }, [store]);

  const [picking, setPicking] = useState<{ initialSrc: string; resolve: (a: SiteAsset | null) => void } | null>(null);
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const pick = useCallback(
    (initialSrc: string) =>
      new Promise<SiteAsset | null>((resolve) => {
        if (mode !== "picker") return resolve(null);
        pickingRef.current?.resolve(null); // 開いたままの前の呼び出しは取り消す
        void store.ensure();
        setPicking({ initialSrc, resolve });
      }),
    [mode, store],
  );
  const finish = (a: SiteAsset | null) => {
    picking?.resolve(a);
    setPicking(null);
  };

  const value = useMemo(() => ({ siteId, mode, store, snapshot, pick, uploadOne }), [siteId, mode, store, snapshot, pick, uploadOne]);
  return (
    <SiteAssetsContext.Provider value={value}>
      {children}
      {/* 欄のドロップを送っている間だけ、離れる前の確認に「アップロードの途中です」を載せる(覆わない) */}
      <BusyScope id="image-field-uploads" prompt={uploading ? "uploading" : undefined}>
        {null}
      </BusyScope>
      {mode === "picker" ? <ImagePicker siteId={siteId} open={picking !== null} initial={picking?.initialSrc ?? ""} onPick={(a) => finish(a)} onClose={() => finish(null)} /> : null}
    </SiteAssetsContext.Provider>
  );
}
