import { addAsset, applyUsage } from "./images";
import { createUploadQueue } from "./use-upload-queue";
import type { AssetList, AssetUsage, UploadedAsset } from "./types";

/**
 * B68(spec §9.3・§9.4 の Q12): パターンの画面で、サイトの画像の一覧を 1 回だけ読んで、選ぶ窓・IMAGE の欄・窓の中のアップロードが共有する。
 * ensure() は何度呼んでも(欄が複数・StrictMode の effect の 2 回目・窓の開き直し)読みは 1 回(読んでいる間は同じ約束を返す)。
 * 読みに失敗したときだけ、次の ensure() で読み直す(何も読めていないので「読み直し」にならない)。
 * アップロードの応答(1 件と usage)で手元を直し、読み直さない(spec §11 の K3)。
 * React に依らない形にして単体テストする(test/image-picker.test.ts)。画面の側は components/images/SiteAssetsProvider.tsx
 */

export type SiteAssetsStatus = "idle" | "loading" | "ready" | "error";
export type SiteAssetsSnapshot = { status: SiteAssetsStatus; list: AssetList | null; error: string | null };

export type SiteAssetsStore = {
  snapshot(): SiteAssetsSnapshot;
  /** 一覧をまだ読んでいなければ読む(読み終わるか失敗したら解ける。投げない) */
  ensure(): Promise<void>;
  /** 上がった 1 件を手元の一覧の先頭に足す(読む前なら何もしない) */
  uploaded(asset: UploadedAsset): void;
  /** 応答の usage で置き換える(読む前なら何もしない) */
  setUsage(usage: AssetUsage): void;
  /** 今の手元の usage(読む前は null) */
  usage(): AssetUsage | null;
  subscribe(fn: () => void): () => void;
};

export function createSiteAssetsStore(deps: { load: () => Promise<AssetList>; describe: (e: unknown) => string }): SiteAssetsStore {
  let snap: SiteAssetsSnapshot = { status: "idle", list: null, error: null };
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: SiteAssetsSnapshot) => {
    snap = next;
    for (const fn of [...listeners]) fn();
  };
  return {
    snapshot: () => snap,
    ensure() {
      if (snap.status === "ready") return Promise.resolve();
      if (inflight) return inflight;
      set({ status: "loading", list: null, error: null });
      inflight = deps
        .load()
        .then(
          (list) => set({ status: "ready", list, error: null }),
          (e: unknown) => set({ status: "error", list: null, error: deps.describe(e) }),
        )
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    uploaded(asset) {
      if (snap.list) set({ ...snap, list: addAsset(snap.list, asset) });
    },
    setUsage(usage) {
      if (snap.list) set({ ...snap, list: applyUsage(snap.list, usage) });
    },
    usage: () => snap.list?.usage ?? null,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** 一覧を読む前の上限(送るのは一覧を読んだ後だけなので使われない。型のために上限なしの値で埋める) */
export const UNLIMITED_USAGE: AssetUsage = { count: 0, bytes: 0, pendingCount: 0, pendingBytes: 0, maxCount: Infinity, maxBytes: Infinity, maxFileBytes: Infinity };

export type FieldUploadResult = { ok: true; asset: UploadedAsset } | { ok: false; error: string };

export type FieldUploader<F> = {
  /** 1 枚を送る。上がった画像は欄の有無によらず手元の一覧に足す。欄は約束が解けたときにまだマウントされていれば、その画像にする */
  upload(file: F): Promise<FieldUploadResult>;
  /** 待ち・送信中があるか(離れる前の確認の prompt="uploading") */
  active(): boolean;
  subscribe(fn: () => void): () => void;
  /** 画面を離れた(待っている分は送らない) */
  dispose(): void;
  revive(): void;
};

/**
 * IMAGE の欄へのドロップを、欄ではなく provider の層で送る(B68)。欄はタブ・パターンの切り替えで外れるので、
 * 欄の中に待ち行列を置くと、外れたときに上がった画像が手元の一覧に入らず、離れる前の確認も消える。
 * 待ち行列は窓と同じ createUploadQueue(1 枚 1 回の POST。読み直さない)
 */
export function createFieldUploader<F extends { name: string; size: number }>(deps: { send: (file: F) => Promise<UploadedAsset>; store: SiteAssetsStore; describe: (e: unknown) => string }): FieldUploader<F> {
  // 同じファイルを続けて積んでも、積んだ順に解く
  const waiting = new Map<F, Array<(r: FieldUploadResult) => void>>();
  const settle = (file: F, r: FieldUploadResult) => {
    const list = waiting.get(file);
    const resolve = list?.shift();
    if (list && list.length === 0) waiting.delete(file);
    resolve?.(r);
  };
  const queue = createUploadQueue<F>({
    send: deps.send,
    usage: () => deps.store.usage() ?? UNLIMITED_USAGE,
    onUploaded: (asset, file) => {
      deps.store.uploaded(asset);
      settle(file, { ok: true, asset });
    },
    onUsage: (u) => deps.store.setUsage(u),
    onFailed: (file, error) => settle(file, { ok: false, error }),
    describe: deps.describe,
  });
  return {
    upload(file) {
      return new Promise<FieldUploadResult>((resolve) => {
        waiting.set(file, [...(waiting.get(file) ?? []), resolve]);
        queue.enqueue([file]);
      });
    },
    active: () => queue.active(),
    subscribe: (fn) => queue.subscribe(fn),
    dispose: () => queue.dispose(),
    revive: () => queue.revive(),
  };
}
