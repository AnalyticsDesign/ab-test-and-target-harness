import { describe, expect, it, vi } from "vitest";
import {
  MISSING_IMAGE_TEXT,
  afterUploadedSelection,
  assetForSrc,
  canOpenPicker,
  canUsePick,
  hasImageChange,
  imageFieldMode,
  pickerInitial,
  shouldPreloadAssets,
} from "@/lib/images";
import { createFieldUploader, createSiteAssetsStore } from "@/lib/site-assets-store";
import { assetProblemRows, inPlaceTarget } from "@/lib/asset-problems";
import { editorParamsFromSearch } from "@/lib/url-state";
import type { AssetList, AssetUsage, SiteAsset, UploadedAsset, Variant } from "@/lib/types";

/**
 * B68 Task 8: パターンの画面の IMAGE の欄と「画像を選ぶ」の窓の手元の決まり。
 * 描画のテストの流儀が無いので、部品が使う純粋な関数と、一覧の取得を 1 回にまとめる store(BFF の呼び出しの数)を見る。
 * provider のマウントと IMAGE の欄が複数あるときの重なった取得は、実画面の E2E(Task 9)で表明する
 */

const usage = (over: Partial<AssetUsage> = {}): AssetUsage => ({
  count: 1, bytes: 1_000, pendingCount: 0, pendingBytes: 0, maxCount: 1000, maxBytes: 1024 ** 3, maxFileBytes: 5 * 1024 ** 2, ...over,
});

const asset = (id: string, over: Partial<SiteAsset> = {}): SiteAsset => ({
  id,
  name: `${id}.png`,
  publicUrl: `https://assets.example.com/sites/s1/images/${id}.png`,
  thumbnailUrl: null,
  thumbnail: "pending",
  mime: "image/png",
  size: 1000,
  width: 10,
  height: 10,
  createdAt: 1,
  createdBy: { id: "u1", name: "A" },
  usedBy: [],
  deliveredIn: [],
  inUse: false,
  keptAt: null,
  ...over,
});

const list = (assets: SiteAsset[] = [asset("asset_aaaaaaaaaa")]): AssetList => ({ assets, experiments: {}, usage: usage({ count: assets.length }) });

const variant = (changes: Variant["changes"]): Variant => ({ id: "a", name: "A", weight: 50, original: false, description: "", analytics: null, changes });

describe("imageFieldMode", () => {
  it("image_field_mode_follows_capabilities", () => {
    expect(imageFieldMode({ imageUpload: true, imageUploader: false })).toBe("picker");
    expect(imageFieldMode({ imageUpload: true })).toBe("picker");
    // R2 なし・アップローダーあり = URL の入力(選ぶ窓を出さない)
    expect(imageFieldMode({ imageUpload: false, imageUploader: true })).toBe("url");
    // どちらも無い = 今の一文(古い control は imageUploader を返さない = false)
    expect(imageFieldMode({ imageUpload: false })).toBe("off");
  });
});

describe("一覧の先読み(マウントの後に読むか)", () => {
  it("does_not_preload_without_image_changes", () => {
    expect(hasImageChange([variant([{ id: "c1", type: "TEXT", selector: "h1", payload: { text: "x" } }])])).toBe(false);
    expect(shouldPreloadAssets("picker", [variant([{ id: "c1", type: "TEXT", selector: "h1", payload: { text: "x" } }])])).toBe(false);
  });

  it("preloads_when_a_variant_has_an_image_change", () => {
    const vs = [variant([]), variant([{ id: "c2", type: "IMAGE", selector: "img", payload: { src: "" } }])];
    expect(hasImageChange(vs)).toBe(true);
    expect(shouldPreloadAssets("picker", vs)).toBe(true);
  });

  it("url_mode_never_reads_the_library", () => {
    const vs = [variant([{ id: "c2", type: "IMAGE", selector: "img", payload: { src: "https://up.example.com/u/s1/x.png" } }])];
    expect(shouldPreloadAssets("url", vs)).toBe(false);
    expect(shouldPreloadAssets("off", vs)).toBe(false);
  });
});

describe("createSiteAssetsStore(BFF の呼び出しの数)", () => {
  it("does_not_load_until_ensure", () => {
    const load = vi.fn(async () => list());
    const store = createSiteAssetsStore({ load, describe: String });
    expect(load).not.toHaveBeenCalled();
    expect(store.snapshot().status).toBe("idle");
    expect(store.snapshot().list).toBeNull();
  });

  it("loads_once_even_if_ensure_is_called_again_or_concurrently", async () => {
    const load = vi.fn(async () => list());
    const store = createSiteAssetsStore({ load, describe: String });
    const a = store.ensure();
    const b = store.ensure(); // 欄が 2 つ・StrictMode の effect の 2 回目
    await Promise.all([a, b]);
    expect(store.snapshot().status).toBe("ready");
    // 窓を閉じて開き直しても読み直さない
    await store.ensure();
    await store.ensure();
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.snapshot().list?.assets.map((x) => x.id)).toEqual(["asset_aaaaaaaaaa"]);
  });

  it("retries_after_a_failed_load_only", async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error("読めませんでした");
      return list();
    });
    const store = createSiteAssetsStore({ load, describe: (e) => (e instanceof Error ? e.message : String(e)) });
    await store.ensure();
    expect(store.snapshot()).toMatchObject({ status: "error", list: null, error: "読めませんでした" });
    fail = false;
    await store.ensure();
    expect(store.snapshot().status).toBe("ready");
    await store.ensure();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("adds_an_uploaded_asset_and_replaces_usage_without_reloading", async () => {
    const load = vi.fn(async () => list());
    const store = createSiteAssetsStore({ load, describe: String });
    await store.ensure();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    const up: UploadedAsset = { ...asset("asset_bbbbbbbbbb"), usage: usage({ count: 2 }) };
    store.uploaded(up);
    store.setUsage(up.usage);
    off();
    expect(seen).toHaveBeenCalled();
    const s = store.snapshot();
    expect(s.list?.assets.map((x) => x.id)).toEqual(["asset_bbbbbbbbbb", "asset_aaaaaaaaaa"]);
    expect(s.list?.usage.count).toBe(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("usage_falls_back_until_the_list_is_read", () => {
    const store = createSiteAssetsStore({ load: async () => list(), describe: String });
    expect(store.usage()).toBeNull();
  });
});

describe("IMAGE の欄の表示(assetForSrc)", () => {
  const assets = [asset("asset_aaaaaaaaaa")];

  it("shows_the_url_until_the_list_is_read", () => {
    expect(assetForSrc(null, "https://assets.example.com/sites/s1/images/asset_aaaaaaaaaa.png")).toEqual({ kind: "loading" });
  });

  it("empty_src_is_not_selected_even_before_loading", () => {
    expect(assetForSrc(null, "")).toEqual({ kind: "empty" });
    expect(assetForSrc(assets, "  ")).toEqual({ kind: "empty" });
  });

  it("finds_the_asset_by_public_url", () => {
    expect(assetForSrc(assets, assets[0]!.publicUrl)).toEqual({ kind: "found", asset: assets[0] });
  });

  it("src_not_in_the_list_shows_the_missing_text", () => {
    expect(assetForSrc(assets, "https://assets.example.com/sites/s1/images/asset_zzzzzzzzzz.png")).toEqual({ kind: "missing" });
    expect(MISSING_IMAGE_TEXT).toBe("この画像はサイトの画像の一覧にありません");
  });
});

describe("選ぶ窓の状態", () => {
  const assets = [asset("asset_aaaaaaaaaa"), asset("asset_bbbbbbbbbb")];

  it("viewer_cannot_open_the_picker", () => {
    expect(canOpenPicker({ disabled: true, mode: "picker" })).toBe(false);
    expect(canOpenPicker({ disabled: false, mode: "picker" })).toBe(true);
    // R2 なし・アップローダーありでは窓を開かない(URL の入力)
    expect(canOpenPicker({ disabled: false, mode: "url" })).toBe(false);
  });

  it("use_button_needs_a_selection_in_the_list", () => {
    expect(canUsePick(null, assets)).toBe(false);
    expect(canUsePick("asset_bbbbbbbbbb", assets)).toBe(true);
    // 一覧に無い ID(一覧がまだ・別の画面で消えた)は使えない
    expect(canUsePick("asset_zzzzzzzzzz", assets)).toBe(false);
    expect(canUsePick("asset_aaaaaaaaaa", null)).toBe(false);
  });

  it("opens_with_the_current_image_selected", () => {
    expect(pickerInitial(assets, assets[1]!.publicUrl)).toBe("asset_bbbbbbbbbb");
    expect(pickerInitial(assets, "")).toBeNull();
    expect(pickerInitial(null, assets[1]!.publicUrl)).toBeNull();
    expect(pickerInitial(assets, "https://elsewhere.example.com/x.png")).toBeNull();
  });

  it("selects_the_uploaded_image_and_the_last_one_wins", () => {
    let selected: string | null = "asset_aaaaaaaaaa";
    selected = afterUploadedSelection(selected, asset("asset_cccccccccc"));
    selected = afterUploadedSelection(selected, asset("asset_dddddddddd"));
    expect(selected).toBe("asset_dddddddddd");
  });
});

describe("createFieldUploader(欄へのドロップは provider の層で送る)", () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it("adds_the_uploaded_asset_even_after_the_field_unmounted_and_keeps_the_prompt_while_sending", async () => {
    const store = createSiteAssetsStore({ load: async () => list(), describe: String });
    await store.ensure();
    let resolve!: (a: UploadedAsset) => void;
    const uploader = createFieldUploader<{ name: string; size: number }>({
      send: () => new Promise<UploadedAsset>((r) => (resolve = r)),
      store,
      describe: String,
    });
    // 欄が upload を呼んでから外れた(欄は約束の結果を受け取らない)。送るのも一覧に足すのも provider の層
    const pending = uploader.upload({ name: "x.png", size: 10 });
    await flush();
    // 送っている間は、離れる前の確認(prompt="uploading")の印が残る
    expect(uploader.active()).toBe(true);
    resolve({ ...asset("asset_eeeeeeeeee"), usage: usage({ count: 2 }) });
    const r = await pending;
    expect(r).toMatchObject({ ok: true, asset: { id: "asset_eeeeeeeeee" } });
    expect(uploader.active()).toBe(false);
    expect(store.snapshot().list?.assets[0]?.id).toBe("asset_eeeeeeeeee");
    expect(store.snapshot().list?.usage.count).toBe(2);
  });

  it("resolves_with_the_reason_when_the_upload_fails_or_is_over_the_limit", async () => {
    const store = createSiteAssetsStore({ load: async () => list(), describe: String });
    await store.ensure();
    const uploader = createFieldUploader<{ name: string; size: number }>({
      send: async () => {
        throw new Error("だめでした");
      },
      store,
      describe: (e) => (e instanceof Error ? e.message : String(e)),
    });
    expect(await uploader.upload({ name: "x.png", size: 10 })).toEqual({ ok: false, error: "だめでした" });
    // 手元の usage で 1 枚の上限を超える行は送らずに失敗にする
    const big = await uploader.upload({ name: "big.png", size: 6 * 1024 ** 2 });
    expect(big.ok).toBe(false);
  });
});

describe("同じエクスペリエンスの行(画面の中で切り替える)", () => {
  it("rows_of_the_open_experiment_switch_in_place", () => {
    expect(inPlaceTarget({ experimentId: "e1", variantId: "b" }, "e1")).toEqual({ tab: "variants", variant: "b" });
    // ほかのエクスペリエンスの行は今のまま AppLink で移る
    expect(inPlaceTarget({ experimentId: "e9", variantId: "a" }, "e1")).toBeNull();
    expect(inPlaceTarget({ experimentId: "e1", variantId: "b" }, undefined)).toBeNull();
  });

  it("editor_reads_tab_and_variant_from_the_url", () => {
    const tabs = ["overview", "variants", "plan"] as const;
    expect(editorParamsFromSearch("?tab=variants&variant=b", tabs)).toEqual({ tab: "variants", variant: "b" });
    // 知らないタブは基本設定。パターンは URL の値のまま(足したばかりの下書きのパターンを捨てない。一覧に無い ID はパターンのタブが先頭を開く)
    expect(editorParamsFromSearch("?tab=nope&variant=z", tabs)).toEqual({ tab: "overview", variant: "z" });
    expect(editorParamsFromSearch("", tabs)).toEqual({ tab: "overview", variant: null });
  });

  it("rows_carry_the_ids_for_the_in_place_switch", () => {
    const [row] = assetProblemRows([{ url: "https://a.example/x.png", reason: "missing", experimentId: "e1", variantId: "b", changeId: "c1" }], { wid: "w", siteId: "s" });
    expect(row).toMatchObject({ experimentId: "e1", variantId: "b" });
  });
});
