import { env } from "cloudflare:workers";
import { assetHousekeepingJob } from "../src/cron/asset-housekeeping";
import { CronFrozen, type CronContext } from "../src/cron/runner";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { isWriteFrozen } from "../src/write-freeze";
import { testEnv } from "./helpers";

// B68 Task 5: Cron `asset-housekeeping` と縮小版のテストの道具(偽の Images の binding・R2 の包み・ジョブを 1 回流す)

/** 偽の縮小版の中身(WebP の先頭 12 バイト + 印) */
export const FAKE_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

export type FakeImagesCall = { op: "info" | "output"; bytes: number };
export type FakeImages = ImagesBinding & {
  calls: FakeImagesCall[];
  transforms: unknown[];
  outputs: unknown[];
  /** 呼び出しごとの、渡されたストリームの chunk の数(info と output の順。binding の層は chunk ごとに JS で詰め直すため 1 が望ましい) */
  chunks: number[];
  /** 呼び出しごとの、渡された chunk の ArrayBuffer(info と output の順。2 本が同じ buffer を共有していないことを見る) */
  buffers: ArrayBufferLike[][];
  /** 次の呼び出しで投げる(null = 投げない)。`code` を付けると ImagesError と同じ形 */
  fail: { at: "info" | "output"; code?: number } | null;
};

/** ストリームを読み切り、バイト数と chunk の数を返す。空(読まれた後のストリームを渡した)なら失敗する */
async function drain(stream: ReadableStream<Uint8Array>, detach = false): Promise<{ bytes: number; chunks: number; buffers: ArrayBufferLike[] }> {
  const reader = stream.getReader();
  let bytes = 0;
  let chunks = 0;
  const buffers: ArrayBufferLike[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    chunks++;
    buffers.push(value.buffer);
    // binding が chunk の buffer を切り離す作りに変わった場合をまねる(読んだ後に transfer して元を長さ 0 にする)
    if (detach) structuredClone(value.buffer, { transfer: [value.buffer as ArrayBuffer] });
  }
  if (bytes === 0) throw new Error("fake images: the stream was empty (already read?)");
  return { bytes, chunks, buffers };
}

/**
 * 偽の Images の binding。`info` と `output` はどちらも渡されたストリームを読み切る(同じストリームを 2 回渡すと 2 回目が空で失敗する)。
 * `transform` と `output` の引数を別々に記録する。`fail` で指定の呼び出しを失敗させる(code 9422 = 枠切れ)
 */
export function fakeImages(opts: { width?: number; height?: number; log?: string[]; detachChunks?: boolean } = {}): FakeImages {
  const fake = {
    calls: [] as FakeImagesCall[],
    transforms: [] as unknown[],
    outputs: [] as unknown[],
    chunks: [] as number[],
    buffers: [] as ArrayBufferLike[][],
    fail: null as FakeImages["fail"],
    async info(stream: ReadableStream<Uint8Array>) {
      opts.log?.push("images.info");
      const { bytes, chunks, buffers } = await drain(stream, opts.detachChunks);
      fake.calls.push({ op: "info", bytes });
      fake.chunks.push(chunks);
      fake.buffers.push(buffers);
      throwIf("info");
      return { format: "image/png", fileSize: bytes, width: opts.width ?? 640, height: opts.height ?? 480 };
    },
    input(stream: ReadableStream<Uint8Array>) {
      const t = {
        transform(o: unknown) {
          fake.transforms.push(o);
          return t;
        },
        draw() {
          return t;
        },
        async output(o: unknown) {
          fake.outputs.push(o);
          const { bytes, chunks, buffers } = await drain(stream, opts.detachChunks);
          fake.calls.push({ op: "output", bytes });
          fake.chunks.push(chunks);
          fake.buffers.push(buffers);
          throwIf("output");
          return {
            image: () => new Blob([FAKE_WEBP]).stream(),
            contentType: () => "image/webp",
            response: () => new Response(FAKE_WEBP, { headers: { "content-type": "image/webp" } }),
          };
        },
      };
      return t;
    },
    text() {
      throw new Error("not used");
    },
    hosted: undefined,
  };
  function throwIf(at: "info" | "output") {
    const f = fake.fail;
    if (f?.at !== at) return;
    throw Object.assign(new Error(f.code === undefined ? "fake images: failed" : `fake images: error ${f.code}`), f.code === undefined ? {} : { code: f.code });
  }
  return fake as unknown as FakeImages;
}

/**
 * R2 の包み。delete の呼び出しを記録し(`log` に "r2.delete")、`beforeDelete` を 1 回だけ先に流し、`failDelete` の回数だけ失敗させる
 */
export function wrapBucket(bucket: R2Bucket, o: { log?: string[]; beforeDelete?: () => Promise<unknown>; failDelete?: number } = {}): R2Bucket & { deleted: string[][] } {
  const deleted: string[][] = [];
  let before = o.beforeDelete;
  let fails = o.failDelete ?? 0;
  return new Proxy(bucket, {
    get(target, p) {
      if (p === "deleted") return deleted;
      if (p === "delete")
        return async (keys: string | string[]) => {
          o.log?.push("r2.delete");
          if (before) {
            const b = before;
            before = undefined;
            await b();
          }
          if (fails > 0) {
            fails--;
            throw new Error("fake r2: delete failed");
          }
          deleted.push(Array.isArray(keys) ? keys : [keys]);
          return target.delete(keys);
        };
      const v = Reflect.get(target, p);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as R2Bucket & { deleted: string[][] };
}

/** ジョブの ctx を手で作る(runner を通さない。queries の残りを決められる。凍結の確かめは包む前の DB を読み、D1 の往復の数に入れない) */
export function housekeepingCtx(over: Partial<Env>, now: number, left = Infinity): CronContext {
  const e = { ...testEnv, ...over } as Env;
  return {
    env: e,
    db: getDb(e),
    now,
    async assertNotFrozen() {
      if (await isWriteFrozen(getDb(env as unknown as Env))) throw new CronFrozen();
    },
    queries: { left: () => left, use: (n) => n <= left },
  };
}

/** ジョブを 1 回流す(既定は今の時刻) */
export const runHousekeeping = (over: Partial<Env> = {}, now = Date.now(), left = Infinity) => assetHousekeepingJob.run(housekeepingCtx(over, now, left));
