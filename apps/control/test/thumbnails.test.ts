import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { endOfUtcMonth, makeThumbnail, thumbKey } from "../src/thumbnails";
import { call, createSite, json, setupOwner, testEnv } from "./helpers";
import { FAKE_WEBP, fakeImages, runHousekeeping } from "./housekeeping-helpers";

// B68 Task 5(spec §5.1・§5.2・§8): 縮小版を作る関数と、アップロードの直後の waitUntil

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);

async function seedPending(sid: string, id: string) {
  await env.DB.prepare(
    `insert into assets (id, site_id, name, name_key, r2_key, public_url, mime, size, thumb_state, created_by, created_at, updated_at)
     values (?1, ?2, ?1, ?1, ?3, ?4, 'image/png', ?5, 'pending', 'u', 1, 1)`,
  )
    .bind(id, sid, `sites/${sid}/images/${id}.png`, `${env.AB_ASSET_PUBLIC_BASE}/sites/${sid}/images/${id}.png`, PNG.byteLength)
    .run();
}
const row = (id: string) => env.DB.prepare(`select thumb_state, thumb_key, thumb_attempts, width, height from assets where id = ?`).bind(id).first();
async function site() {
  const owner = await setupOwner();
  const { id } = await createSite(owner.token, owner.workspaceId);
  return { owner, sid: id };
}
const upload = (token: string, sid: string, over: Partial<Env>) => {
  const fd = new FormData();
  fd.set("file", new File([PNG], "hero.png", { type: "image/png" }));
  return call("POST", `/sites/${sid}/assets`, { token, raw: fd, envOverride: over });
};

async function freeze() {
  await env.DB.prepare(`insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', '{"reason":"更新"}', 1, null) on conflict(key) do nothing`).run();
}
async function unfreeze() {
  await env.DB.prepare(`delete from instance_settings where key = 'writeFreeze'`).run();
}

afterEach(() => vi.restoreAllMocks());

describe("makeThumbnail (spec §5.1)", () => {
  it("thumbnail_reads_body_twice", async () => {
    const { sid } = await site();
    await seedPending(sid, "asset_twiceaaaaa");
    await seedPending(sid, "asset_streamaaaa");
    const IMAGES = fakeImages();
    const e = { ...testEnv, IMAGES } as Env;
    // ArrayBuffer(アップロードの直後)と ReadableStream のどちらでも、info と変換がそれぞれ本文を読み切る
    expect(await makeThumbnail(e, { id: "asset_twiceaaaaa", site_id: sid }, PNG.slice().buffer)).toBe("ready");
    expect(await makeThumbnail(e, { id: "asset_streamaaaa", site_id: sid }, new Blob([PNG]).stream())).toBe("ready");
    expect(IMAGES.calls).toEqual([
      { op: "info", bytes: PNG.byteLength },
      { op: "output", bytes: PNG.byteLength },
      { op: "info", bytes: PNG.byteLength },
      { op: "output", bytes: PNG.byteLength },
    ]);
  });

  it("thumbnail_passes_one_chunk_streams_to_the_binding", async () => {
    // Blob.stream() は 4KB ずつの chunk になり、binding の層が chunk ごとに JS で詰め直す(5MB で約 1,200 個 × 2 回)。
    // 4KB を超える本文でも、info と変換に渡すストリームはそれぞれ 1 chunk。同じバイト列から作った 2 本目も中身が欠けない
    const { sid } = await site();
    await seedPending(sid, "asset_onechunkaa");
    await seedPending(sid, "asset_onechunkbb");
    const IMAGES = fakeImages();
    const e = { ...testEnv, IMAGES } as Env;
    const big = new Uint8Array(20_000);
    big.set(PNG);
    expect(await makeThumbnail(e, { id: "asset_onechunkaa", site_id: sid }, big.buffer)).toBe("ready");
    // Cron の経路(R2 の本文を ArrayBuffer にして渡す)と同じく、ストリームで渡されたときも読んでから 1 chunk にする
    expect(await makeThumbnail(e, { id: "asset_onechunkbb", site_id: sid }, new Blob([big]).stream())).toBe("ready");
    expect(IMAGES.chunks).toEqual([1, 1, 1, 1]);
    expect(IMAGES.calls.map((c) => c.bytes)).toEqual([20_000, 20_000, 20_000, 20_000]);
    expect(big.buffer.byteLength).toBe(20_000); // 元のバイト列は切り離されない
  });

  it("thumbnail_gives_info_and_transform_separate_buffers", async () => {
    // Q336 M1: info と変換の 2 本は別の buffer。binding が読んだ chunk の buffer を切り離す作りに変わっても、変換は欠けずに読める
    const { sid } = await site();
    await seedPending(sid, "asset_detachaaaa");
    const IMAGES = fakeImages({ detachChunks: true });
    const e = { ...testEnv, IMAGES } as Env;
    const big = new Uint8Array(20_000);
    big.set(PNG);
    expect(await makeThumbnail(e, { id: "asset_detachaaaa", site_id: sid }, big.buffer)).toBe("ready");
    expect(IMAGES.calls.map((c) => c.bytes)).toEqual([20_000, 20_000]);
    const [infoBuffers, outputBuffers] = IMAGES.buffers;
    expect(infoBuffers).toHaveLength(1);
    expect(outputBuffers).toHaveLength(1);
    expect(infoBuffers![0]).not.toBe(outputBuffers![0]);
  });

  it("thumbnail_uses_320_webp_q80_first_frame", async () => {
    const { sid } = await site();
    await seedPending(sid, "asset_argsaaaaaa");
    const IMAGES = fakeImages({ width: 2000, height: 1000 });
    expect(await makeThumbnail({ ...testEnv, IMAGES } as Env, { id: "asset_argsaaaaaa", site_id: sid }, PNG.slice().buffer, 1234)).toBe("ready");
    expect(IMAGES.transforms).toEqual([{ width: 320, fit: "scale-down" }]);
    expect(IMAGES.outputs).toEqual([{ format: "image/webp", quality: 80, anim: false }]);
    expect(await row("asset_argsaaaaaa")).toMatchObject({ thumb_state: "ready", thumb_key: thumbKey(sid, "asset_argsaaaaaa"), width: 2000, height: 1000 });
    const obj = await env.ASSETS!.get(thumbKey(sid, "asset_argsaaaaaa"));
    expect(obj!.httpMetadata).toMatchObject({ contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" });
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(FAKE_WEBP);
  });

  it("thumbnail_for_deleted_row_is_removed", async () => {
    const { sid } = await site();
    const IMAGES = fakeImages();
    // 行が無い(消えた)画像: 置いた縮小版を消して gone
    expect(await makeThumbnail({ ...testEnv, IMAGES } as Env, { id: "asset_goneaaaaaa", site_id: sid }, PNG.slice().buffer)).toBe("gone");
    expect(IMAGES.calls).toHaveLength(2); // 変換はした
    expect(await env.ASSETS!.head(thumbKey(sid, "asset_goneaaaaaa"))).toBeNull();
  });

  it("thumbnail_already_ready_keeps_object", async () => {
    // アップロードの直後と Cron が重なり、もう一方が先に ready にした: 同じキーの縮小版を消さない
    const { sid } = await site();
    await seedPending(sid, "asset_readyaaaaa");
    const e = { ...testEnv, IMAGES: fakeImages() } as Env;
    expect(await makeThumbnail(e, { id: "asset_readyaaaaa", site_id: sid }, PNG.slice().buffer)).toBe("ready");
    expect(await makeThumbnail(e, { id: "asset_readyaaaaa", site_id: sid }, PNG.slice().buffer)).toBe("ready");
    expect(await env.ASSETS!.head(thumbKey(sid, "asset_readyaaaaa"))).not.toBeNull();
  });

  it("thumbnail_frozen_after_the_gate_keeps_pending_row_and_object", async () => {
    // 入口の確かめの後に凍結が入った: 行は書かれず pending のまま・回数も増えず・置いた縮小版は消えない(次の回に同じキーへ置き直される)
    const { sid } = await site();
    await seedPending(sid, "asset_frozenaaaa");
    const e = { ...testEnv, IMAGES: fakeImages() } as Env;
    await freeze();
    expect(await makeThumbnail(e, { id: "asset_frozenaaaa", site_id: sid }, PNG.slice().buffer)).toBe("frozen");
    expect(await row("asset_frozenaaaa")).toMatchObject({ thumb_state: "pending", thumb_attempts: 0, thumb_key: null, width: null });
    expect(await env.ASSETS!.head(thumbKey(sid, "asset_frozenaaaa"))).not.toBeNull();
    await unfreeze();
    expect(await makeThumbnail(e, { id: "asset_frozenaaaa", site_id: sid }, PNG.slice().buffer)).toBe("ready");
    expect(await row("asset_frozenaaaa")).toMatchObject({ thumb_state: "ready", thumb_key: thumbKey(sid, "asset_frozenaaaa") });
    // 行が無いときは凍結中でも置いた縮小版を消して gone(行の有無が先)
    await freeze();
    expect(await makeThumbnail(e, { id: "asset_nonexistaaa", site_id: sid }, PNG.slice().buffer)).toBe("gone");
    expect(await env.ASSETS!.head(thumbKey(sid, "asset_nonexistaaa"))).toBeNull();
    await unfreeze();
  });

  it("thumbnail_classifies_errors", async () => {
    const { sid } = await site();
    await seedPending(sid, "asset_erroraaaaa");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const IMAGES = fakeImages();
    const e = { ...testEnv, IMAGES } as Env;
    IMAGES.fail = { at: "output", code: 9422 };
    expect(await makeThumbnail(e, { id: "asset_erroraaaaa", site_id: sid }, PNG.slice().buffer)).toBe("quota");
    IMAGES.fail = { at: "info", code: 9523 };
    expect(await makeThumbnail(e, { id: "asset_erroraaaaa", site_id: sid }, PNG.slice().buffer)).toBe("retry");
    expect(await row("asset_erroraaaaa")).toMatchObject({ thumb_state: "pending", thumb_attempts: 0 }); // 回数は呼び出し側が書く
    expect(await env.ASSETS!.head(thumbKey(sid, "asset_erroraaaaa"))).toBeNull();
  });

  it("end_of_utc_month", () => {
    expect(endOfUtcMonth(Date.UTC(2026, 10, 10, 12))).toBe(Date.UTC(2026, 11, 1));
    expect(endOfUtcMonth(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
  });
});

describe("thumbnail after upload (spec §5.2)", () => {
  it("thumbnail_after_upload_frozen_midway_leaves_pending_without_counting", async () => {
    // アップロードの入口は通った後、縮小版を作っている間に凍結が入った(waitUntil の経路)
    const { owner, sid } = await site();
    const IMAGES = fakeImages();
    const info = IMAGES.info.bind(IMAGES);
    IMAGES.info = async (stream) => {
      await freeze();
      return info(stream);
    };
    const res = await upload(owner.token, sid, { IMAGES });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    expect(await row(id)).toMatchObject({ thumb_state: "pending", thumb_attempts: 0, thumb_key: null });
    expect(await env.ASSETS!.head(thumbKey(sid, id))).not.toBeNull(); // 消さない
    await unfreeze();
    // 次の回(Cron の経路)が同じキーへ置き直して ready にする
    await runHousekeeping({ IMAGES: fakeImages() });
    expect(await row(id)).toMatchObject({ thumb_state: "ready", thumb_attempts: 0, thumb_key: thumbKey(sid, id) });
  });

  it("thumbnail_failure_keeps_pending_and_counts_attempt", async () => {
    const { owner, sid } = await site();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const IMAGES = fakeImages();
    IMAGES.fail = { at: "output" };
    const res = await upload(owner.token, sid, { IMAGES });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    expect(await row(id)).toMatchObject({ thumb_state: "pending", thumb_attempts: 1, thumb_key: null });
  });
});

describe("capabilities (spec §8)", () => {
  it("capabilities_reports_image_thumbnails", async () => {
    const { owner } = await site();
    const on = await json<{ imageThumbnails: boolean }>(await call("GET", "/capabilities", { token: owner.token, envOverride: { IMAGES: fakeImages() } }));
    expect(on.imageThumbnails).toBe(true);
    const off = await json<{ imageThumbnails: boolean }>(await call("GET", "/capabilities", { token: owner.token }));
    expect(off.imageThumbnails).toBe(false);
  });
});
