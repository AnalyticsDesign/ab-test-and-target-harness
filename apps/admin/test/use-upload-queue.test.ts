import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/client";
import { createUploadQueue, type UploadQueueDeps } from "@/lib/use-upload-queue";
import type { AssetUsage, UploadedAsset } from "@/lib/types";

/**
 * B68: アップロードの待ち行列(K2 = Q294 案 A。BusyScope の run に乗せず、自分で 1 枚ずつ送る)。
 * React に依らない中身(createUploadQueue)を、送る関数を差し替えて見る
 */

type F = { name: string; size: number };

const usage = (over: Partial<AssetUsage> = {}): AssetUsage => ({
  count: 0, bytes: 0, pendingCount: 0, pendingBytes: 0, maxCount: 1000, maxBytes: 1024 ** 3, maxFileBytes: 5 * 1024 ** 2, ...over,
});

const uploaded = (name: string, u: AssetUsage, renamedFrom?: string): UploadedAsset => ({
  id: `asset_${name}`,
  name,
  publicUrl: `https://assets.example.com/${name}`,
  thumbnailUrl: null,
  thumbnail: "pending",
  mime: "image/png",
  size: 10,
  width: 1,
  height: 1,
  createdAt: 1,
  createdBy: { id: "u1", name: null },
  usedBy: [],
  deliveredIn: [],
  inUse: false,
  keptAt: null,
  ...(renamedFrom ? { renamedFrom } : {}),
  usage: u,
});

/** 送る関数を手で解く形にした差し替え。calls に送った順のファイルと解き方が積まれる */
function harness(initial: AssetUsage = usage()) {
  let current = initial;
  const calls: Array<{ file: F; resolve: (a: UploadedAsset) => void; reject: (e: unknown) => void }> = [];
  const added: UploadedAsset[] = [];
  const usages: AssetUsage[] = [];
  const deps: UploadQueueDeps<F> = {
    send: (file) => new Promise<UploadedAsset>((resolve, reject) => calls.push({ file, resolve, reject })),
    usage: () => current,
    onUploaded: (a) => added.push(a),
    onUsage: (u) => {
      current = u;
      usages.push(u);
    },
    describe: (e) => (e instanceof ApiClientError ? (e.extra.message ?? e.code) : String(e)),
  };
  const q = createUploadQueue(deps);
  return { q, calls, added, usages, current: () => current };
}

/** 待ち行列の次の 1 歩(Promise の解決)まで進める */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createUploadQueue", () => {
  it("queue_uploads_one_at_a_time", async () => {
    const h = harness();
    h.q.enqueue([{ name: "a.png", size: 10 }, { name: "b.png", size: 10 }, { name: "c.png", size: 10 }]);
    await flush();
    expect(h.calls.map((c) => c.file.name)).toEqual(["a.png"]);
    expect(h.q.rows().map((r) => r.state)).toEqual(["uploading", "waiting", "waiting"]);
    expect(h.q.active()).toBe(true);
    h.calls[0]!.resolve(uploaded("a.png", usage({ count: 1 })));
    await flush();
    expect(h.calls.map((c) => c.file.name)).toEqual(["a.png", "b.png"]);
    // 送っている間に積んだ分も同じ列の後ろに並ぶ(捨てない)
    h.q.enqueue([{ name: "d.png", size: 10 }]);
    h.calls[1]!.resolve(uploaded("b.png", usage({ count: 2 })));
    await flush();
    h.calls[2]!.resolve(uploaded("c.png", usage({ count: 3 })));
    await flush();
    h.calls[3]!.resolve(uploaded("d.png", usage({ count: 4 })));
    await flush();
    expect(h.calls.map((c) => c.file.name)).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(h.q.rows().map((r) => r.state)).toEqual(["done", "done", "done", "done"]);
    expect(h.q.active()).toBe(false);
    expect(h.added.map((a) => a.name)).toEqual(["a.png", "b.png", "c.png", "d.png"]);
  });

  it("queue_continues_after_failure", async () => {
    const h = harness();
    h.q.enqueue([{ name: "a.svg", size: 10 }, { name: "b.png", size: 10 }]);
    await flush();
    h.calls[0]!.reject(new ApiClientError(415, "unsupported_media_type", { message: "この画像はアップロードできません" }));
    await flush();
    expect(h.q.rows()[0]).toMatchObject({ state: "failed", error: "この画像はアップロードできません" });
    expect(h.calls.map((c) => c.file.name)).toEqual(["a.svg", "b.png"]);
    h.calls[1]!.resolve(uploaded("b.png", usage({ count: 1 })));
    await flush();
    expect(h.q.rows().map((r) => r.state)).toEqual(["failed", "done"]);
    expect(h.q.active()).toBe(false);
  });

  it("queue_rejects_over_size_before_sending", async () => {
    // 1 枚の上限・枚数の上限を手元の usage で先に見つけ、送らずにその行を失敗にする(正は control)
    const h = harness(usage({ count: 998, maxCount: 1000 }));
    h.q.enqueue([
      { name: "big.jpg", size: 5 * 1024 ** 2 + 1 },
      { name: "a.png", size: 10 },
      { name: "b.png", size: 10 },
      { name: "c.png", size: 10 },
    ]);
    await flush();
    const rows = h.q.rows();
    expect(rows[0]).toMatchObject({ state: "failed", error: "画像が大きすぎます(1 枚あたり 5MB まで)" });
    expect(rows[1]!.state).toBe("uploading");
    expect(rows[2]!.state).toBe("waiting");
    // 998 + 送る予定の 2 枚で 1,000 枚。3 枚目は送らない
    expect(rows[3]).toMatchObject({ state: "failed", error: "サイトの画像の上限に達しています(1 サイトあたり 1,000 枚まで)" });
    expect(h.calls.map((c) => c.file.name)).toEqual(["a.png"]);
  });

  it("queue_shows_renamed_name", async () => {
    const h = harness();
    h.q.enqueue([{ name: "banner.png", size: 10 }]);
    await flush();
    h.calls[0]!.resolve(uploaded("banner (2).png", usage({ count: 1 }), "banner.png"));
    await flush();
    expect(h.q.rows()[0]).toMatchObject({ fileName: "banner.png", name: "banner (2).png", renamedFrom: "banner.png", state: "done" });
  });

  it("queue_applies_usage_from_201_and_409", async () => {
    const h = harness(usage({ count: 5 }));
    h.q.enqueue([{ name: "a.png", size: 10 }, { name: "b.png", size: 10 }]);
    await flush();
    h.calls[0]!.resolve(uploaded("a.png", usage({ count: 6, bytes: 10 })));
    await flush();
    expect(h.current()).toMatchObject({ count: 6, bytes: 10 });
    // ほかの人の操作で上限に届いていた: 409 の usage で手元を置き換える
    const full = usage({ count: 1000, bytes: 999 });
    h.calls[1]!.reject(new ApiClientError(409, "asset_quota_exceeded", { message: "サイトの画像の上限に達しています", usage: full }));
    await flush();
    expect(h.current()).toEqual(full);
    expect(h.usages).toEqual([usage({ count: 6, bytes: 10 }), full]);
    expect(h.q.rows()[1]).toMatchObject({ state: "failed", error: "サイトの画像の上限に達しています" });
    // 形の違う usage の 409 では置き換えない
    h.q.enqueue([{ name: "c.png", size: 10 }]);
    await flush();
    expect(h.q.rows()[2]).toMatchObject({ state: "failed" }); // 手元の usage が上限なので送らない
    expect(h.calls).toHaveLength(2);
  });

  it("ignores a malformed usage in a 409 and stops sending after dispose", async () => {
    const h = harness();
    h.q.enqueue([{ name: "a.png", size: 10 }, { name: "b.png", size: 10 }]);
    await flush();
    h.calls[0]!.reject(new ApiClientError(409, "asset_quota_exceeded", { usage: { count: "x" } }));
    await flush();
    expect(h.usages).toEqual([]);
    // 画面を離れた(dispose)後は、待っている分を送らない
    h.q.dispose();
    h.calls[1]!.resolve(uploaded("b.png", usage({ count: 1 })));
    h.q.enqueue([{ name: "c.png", size: 10 }]);
    await flush();
    expect(h.calls).toHaveLength(2);
  });

  it("clear empties the rows only when nothing is waiting or uploading", async () => {
    const h = harness();
    h.q.enqueue([{ name: "a.png", size: 10 }]);
    await flush();
    h.q.clear();
    expect(h.q.rows()).toHaveLength(1);
    h.calls[0]!.resolve(uploaded("a.png", usage({ count: 1 })));
    await flush();
    h.q.clear();
    expect(h.q.rows()).toEqual([]);
  });
});

describe("createUploadQueue の結果を呼び出し元に結ぶ", () => {
  it("passes_the_file_to_onUploaded_and_onFailed", async () => {
    const done: string[] = [];
    const failed: string[] = [];
    const q = createUploadQueue<F>({
      send: async (file) => {
        if (file.name === "bad.png") throw new Error("だめ");
        return uploaded(file.name, usage());
      },
      usage: () => usage(),
      onUploaded: (_a, file) => done.push(file.name),
      onUsage: () => {},
      onFailed: (file) => failed.push(file.name),
      describe: (e) => (e instanceof Error ? e.message : String(e)),
    });
    q.enqueue([{ name: "ok.png", size: 1 }, { name: "bad.png", size: 1 }, { name: "huge.png", size: 6 * 1024 ** 2 }]);
    await flush();
    await flush();
    expect(done).toEqual(["ok.png"]);
    expect(failed.sort()).toEqual(["bad.png", "huge.png"]);
  });
});
