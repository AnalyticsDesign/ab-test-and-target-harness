"use client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { ApiClientError, api, describeError } from "./client";
import { formatCount, formatFileLimit, isAssetUsage } from "./images";
import type { AssetUsage, UploadedAsset } from "./types";

/**
 * B68: 画像のアップロードの待ち行列(spec §9.2・§11 の K2 = Q294 案 A)。
 * BusyScope の run に乗せず、自分で 1 枚ずつ BFF に POST する(run の前提 = 範囲ごとに 1 つ・30 秒・最短 300 ms・範囲を inert と合わないため)。
 * 送っている間も格子・詳細・名前の変更は使える。続けて積んだ分は同じ列の後ろに並ぶ(二度押しで捨てない)。
 * 手元の usage で 1 枚の上限・枚数の上限を先に見つけた行は、送らずに失敗にする(往復を省く。正は control)。
 * 201 の応答の 1 件は onUploaded で手元の一覧に足し、応答の usage で使用量を置き換える。409 asset_quota_exceeded の usage でも置き換える。
 * 読み直し(router.refresh)はしない(spec §11 の K3)。
 * 離れる前の確認は、待ち・送信中の行がある間(active)に画面が BusyScope の prompt="uploading" で出す。
 *
 * 中身(createUploadQueue)は React に依らず、送る関数を差し替えて単体テストする(test/use-upload-queue.test.ts)。useUploadQueue はその薄い包み
 */

export type QueueRowState = "waiting" | "uploading" | "done" | "failed";

export type QueueRow = {
  /** 行の通し番号(React の key) */
  key: number;
  /** 選んだファイルの名前 */
  fileName: string;
  size: number;
  state: QueueRowState;
  /** 上がった画像の名前(番号を付けたときは付けた後の名前)。上がるまで null */
  name: string | null;
  /** 名前が重なって番号を付けたときの元の名前 */
  renamedFrom: string | null;
  /** 失敗の理由 */
  error: string | null;
};

export type UploadQueueDeps<F extends { name: string; size: number }> = {
  /** 1 枚を送る。201 の本文を返す。失敗は throw(ApiClientError) */
  send: (file: F) => Promise<UploadedAsset>;
  /** 今の手元の usage(201・409 の後は onUsage で渡した値) */
  usage: () => AssetUsage;
  /** file = 積んだときのファイル(呼び出し元が自分の約束と結ぶため) */
  onUploaded: (asset: UploadedAsset, file: F) => void;
  onUsage: (usage: AssetUsage) => void;
  /** 失敗した(上限で送らなかった行も)。message は行に出す理由と同じ */
  onFailed?: (file: F, message: string) => void;
  /** 失敗を画面の 1 行にする */
  describe: (e: unknown) => string;
};

export type UploadQueue<F> = {
  /** ファイルを列の後ろに積む(上限を先に見て、超える行は送らずに失敗にする) */
  enqueue(files: F[]): void;
  rows(): QueueRow[];
  /** 待ち・送信中の行があるか */
  active(): boolean;
  /** 行を消す(結果のカードの「閉じる」)。待ち・送信中の間は何もしない */
  clear(): void;
  /** 画面を離れた。待っている行はもう送らない(送信中の 1 枚の結果は受けない) */
  dispose(): void;
  /** dispose の取り消し(StrictMode がマウントをやり直したとき。積む前なので待ちの行は無い) */
  revive(): void;
  subscribe(fn: () => void): () => void;
};

export function createUploadQueue<F extends { name: string; size: number }>(deps: UploadQueueDeps<F>): UploadQueue<F> {
  let rows: QueueRow[] = [];
  const files = new Map<number, F>();
  let seq = 0;
  let running = false;
  let disposed = false;
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const fn of [...listeners]) fn();
  };
  const update = (key: number, patch: Partial<QueueRow>) => {
    rows = rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
    publish();
  };
  const pendingCount = () => rows.filter((r) => r.state === "waiting" || r.state === "uploading").length;

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (;;) {
        if (disposed) return;
        const next = rows.find((r) => r.state === "waiting");
        if (!next) return;
        const file = files.get(next.key)!;
        update(next.key, { state: "uploading" });
        try {
          const asset = await deps.send(file);
          if (disposed) return;
          files.delete(next.key);
          update(next.key, { state: "done", name: asset.name, renamedFrom: asset.renamedFrom ?? null });
          deps.onUploaded(asset, file);
          deps.onUsage(asset.usage);
        } catch (e) {
          if (disposed) return;
          files.delete(next.key);
          // 上限の 409 は control が今の usage を添える。ほかの人の操作で増えた分もここで手元に入る
          if (e instanceof ApiClientError && e.code === "asset_quota_exceeded" && isAssetUsage(e.extra.usage)) deps.onUsage(e.extra.usage);
          const message = deps.describe(e);
          update(next.key, { state: "failed", error: message });
          deps.onFailed?.(file, message);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(list) {
      if (disposed || list.length === 0) return;
      const u = deps.usage();
      // 送る予定の行(待ち・送信中)は、まだ usage に入っていないので数に足す
      let planned = pendingCount();
      const added: QueueRow[] = [];
      const rejected: Array<[F, string]> = [];
      for (const f of list) {
        const key = ++seq;
        const base: QueueRow = { key, fileName: f.name, size: f.size, state: "waiting", name: null, renamedFrom: null, error: null };
        if (f.size > u.maxFileBytes) {
          const error = `画像が大きすぎます(1 枚あたり ${formatFileLimit(u.maxFileBytes)} まで)`;
          added.push({ ...base, state: "failed", error });
          rejected.push([f, error]);
        } else if (u.count + planned >= u.maxCount) {
          const error = `サイトの画像の上限に達しています(1 サイトあたり ${formatCount(u.maxCount)} 枚まで)`;
          added.push({ ...base, state: "failed", error });
          rejected.push([f, error]);
        } else {
          planned += 1;
          files.set(key, f);
          added.push(base);
        }
      }
      rows = [...rows, ...added];
      publish();
      for (const [f, error] of rejected) deps.onFailed?.(f, error);
      void pump();
    },
    rows: () => rows,
    active: () => pendingCount() > 0,
    clear() {
      if (pendingCount() > 0) return;
      rows = [];
      files.clear();
      publish();
    },
    dispose() {
      disposed = true;
      files.clear();
    },
    revive() {
      disposed = false;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** 1 枚の送信の上限。5MB でも回線が遅いと 30 秒を超えうるので、保存(30 秒)より長くとる */
const UPLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MESSAGE = "時間内に終わりませんでした。上がったかは、画面を開き直して確かめてください";

/** 1 枚を BFF に送る(画面の待ち行列と、IMAGE の欄の provider の層の待ち行列が共有する) */
export function sendUpload(siteId: string, file: File): Promise<UploadedAsset> {
  const fd = new FormData();
  fd.set("file", file);
  return api<UploadedAsset>("POST", `/sites/${siteId}/assets`, fd, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
}

/** 失敗を行・欄に出す 1 行にする(打ち切りは専用の文) */
export function describeUploadError(e: unknown): string {
  return e instanceof DOMException && e.name === "TimeoutError" ? UPLOAD_TIMEOUT_MESSAGE : describeError(e);
}

const EMPTY: QueueRow[] = [];

/**
 * 画面の待ち行列。onUploaded・onUsage は手元の一覧を直す関数(最新の値を ref で読むので、描画ごとに作り直してよい)。
 * usage は最新の手元の usage を返す関数(201 の直後の次の 1 枚の上限の判定にも、置き換えた値を使う)
 */
export function useUploadQueue(opts: { siteId: string; usage: () => AssetUsage; onUploaded: (a: UploadedAsset) => void; onUsage: (u: AssetUsage) => void }): {
  rows: QueueRow[];
  active: boolean;
  enqueue: (files: File[]) => void;
  clear: () => void;
} {
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const queueRef = useRef<UploadQueue<File> | null>(null);
  queueRef.current ??= createUploadQueue<File>({
      send: (file) => sendUpload(optsRef.current.siteId, file),
      usage: () => optsRef.current.usage(),
      onUploaded: (a) => optsRef.current.onUploaded(a),
      onUsage: (u) => optsRef.current.onUsage(u),
    describe: describeUploadError,
  });
  const queue = queueRef.current;

  // 画面を離れたら、待っている分は送らない(離れる前の確認の文言のとおり)。StrictMode のマウントのやり直しでは取り消す
  useEffect(() => {
    queue.revive();
    return () => queue.dispose();
  }, [queue]);

  const rows = useSyncExternalStore(queue.subscribe, queue.rows, () => EMPTY);
  const enqueue = useCallback((files: File[]) => queue.enqueue(files), [queue]);
  const clear = useCallback(() => queue.clear(), [queue]);
  return { rows, active: rows.some((r) => r.state === "waiting" || r.state === "uploading"), enqueue, clear };
}
