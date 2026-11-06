import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_PARAMS,
  KEPT_BADGE_MS,
  addAsset,
  applyUsage,
  expandAssetList,
  assetBadges,
  deleteBlockedReason,
  experimentOf,
  keptNotice,
  mergeExperiments,
  variantNameOf,
  filterSortPage,
  formatBytes,
  formatName,
  imagesPageMode,
  listParamsSearch,
  readListParams,
  removeAsset,
  replaceAsset,
  usageSummary,
  INLINE_ASSETS_MAX,
  initialAssets,
  pendingSlice,
  replayOps,
  type AssetListOp,
  type ListParams,
} from "@/lib/images";
import type { AssetList, AssetListItemResponse, AssetListResponse, AssetUsage, SiteAsset } from "@/lib/types";

/** B68: サイトの画像の一覧の画面の手元の決まり(lib/images.ts)。部品は描かず、画面が使う純粋な関数だけを見る */

const usage = (over: Partial<AssetUsage> = {}): AssetUsage => ({
  count: 3, bytes: 3_000, pendingCount: 0, pendingBytes: 0, maxCount: 1000, maxBytes: 1024 ** 3, maxFileBytes: 5 * 1024 ** 2, ...over,
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
  createdAt: 1_000,
  createdBy: { id: "u1", name: "佐藤" },
  usedBy: [],
  deliveredIn: [],
  inUse: false,
  keptAt: null,
  ...over,
});

const list = (assets: SiteAsset[], u: AssetUsage = usage({ count: assets.length })): AssetList => ({ assets, experiments: {}, usage: u });

const params = (over: Partial<ListParams> = {}): ListParams => ({ ...DEFAULT_LIST_PARAMS, ...over });

describe("画面の出し分け", () => {
  it("images_page_picks_library_uploader_or_guide", () => {
    expect(imagesPageMode({ imageUpload: true })).toBe("library");
    expect(imagesPageMode({ imageUpload: true, imageUploader: true })).toBe("library");
    expect(imagesPageMode({ imageUpload: false, imageUploader: true })).toBe("uploader");
    expect(imagesPageMode({ imageUpload: false, imageUploader: false })).toBe("guide");
    expect(imagesPageMode({ imageUpload: false })).toBe("guide"); // アップローダーが入る前の control
  });
});

describe("絞り込み・並べ替え・ページ", () => {
  const assets = [
    asset("a", { name: "Spring_Banner.png", size: 300, createdAt: 3, inUse: true, usedBy: [{ experimentId: "e1", variantId: "b" }] }),
    asset("b", { name: "autumn.jpg", size: 900, createdAt: 1 }),
    asset("c", { name: "banner_small.webp", size: 100, createdAt: 2, inUse: true, deliveredIn: ["e2"] }),
  ];

  it("filter_by_name_case_insensitive", () => {
    expect(filterSortPage(assets, params({ q: "BANNER" })).items.map((a) => a.id)).toEqual(["a", "c"]);
    expect(filterSortPage(assets, params({ q: "  spring " })).items.map((a) => a.id)).toEqual(["a"]);
    expect(filterSortPage(assets, params({ q: "nothing" })).total).toBe(0);
  });

  it("filter_used_unused_by_in_use", () => {
    // 「使っている」は inUse(下書きのパターンの変更か、公開したときの内容)で分ける
    expect(filterSortPage(assets, params({ use: "used" })).items.map((a) => a.id)).toEqual(["a", "c"]);
    expect(filterSortPage(assets, params({ use: "unused" })).items.map((a) => a.id)).toEqual(["b"]);
    expect(filterSortPage(assets, params({ use: "all" })).total).toBe(3);
  });

  it("sort_newest_name_size", () => {
    expect(filterSortPage(assets, params({ sort: "new" })).items.map((a) => a.id)).toEqual(["a", "c", "b"]);
    expect(filterSortPage(assets, params({ sort: "name" })).items.map((a) => a.id)).toEqual(["b", "c", "a"]);
    expect(filterSortPage(assets, params({ sort: "size" })).items.map((a) => a.id)).toEqual(["b", "a", "c"]);
    // 元の配列は並べ替えない
    expect(assets.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  const many = Array.from({ length: 100 }, (_, i) => asset(`x${String(i).padStart(3, "0")}`, { createdAt: 1000 - i }));

  it("page_slices_with_per_24_48_96_all", () => {
    const p24 = filterSortPage(many, params({ per: 24, page: 2 }));
    expect(p24.items).toHaveLength(24);
    expect(p24.items[0]!.id).toBe("x024");
    expect(p24).toMatchObject({ total: 100, page: 2, pages: 5, from: 25, to: 48 });
    expect(filterSortPage(many, params({ per: 48 })).items).toHaveLength(48);
    const last96 = filterSortPage(many, params({ per: 96, page: 2 }));
    expect(last96.items).toHaveLength(4);
    expect(last96).toMatchObject({ from: 97, to: 100, pages: 2 });
    const all = filterSortPage(many, params({ per: "all", page: 3 }));
    expect(all.items).toHaveLength(100);
    expect(all).toMatchObject({ page: 1, pages: 1, from: 1, to: 100 });
    expect(DEFAULT_LIST_PARAMS.per).toBe(48);
  });

  it("page_clamps_out_of_range", () => {
    expect(filterSortPage(many, params({ per: 48, page: 9 }))).toMatchObject({ page: 3, from: 97, to: 100 });
    expect(filterSortPage(many, params({ per: 48, page: 0 }))).toMatchObject({ page: 1, from: 1 });
    expect(filterSortPage([], params({ per: 24, page: 4 }))).toMatchObject({ page: 1, pages: 1, total: 0, from: 0, to: 0 });
  });
});

describe("URL の引数", () => {
  it("params_round_trip", () => {
    const state = params({ q: "春 banner", use: "unused", sort: "size", per: 96, page: 3, image: "asset_k2x9" });
    const search = listParamsSearch(state, "");
    expect(readListParams(new URLSearchParams(search))).toEqual(state);
    // 既定の値は URL に書かない。ほかの引数は残す
    expect(listParamsSearch(DEFAULT_LIST_PARAMS, "?x=1&page=4&per=24")).toBe("?x=1");
    expect(readListParams(new URLSearchParams(""))).toEqual(DEFAULT_LIST_PARAMS);
    // サーバーのページの searchParams(配列もある)からも読む。許さない値は既定
    expect(readListParams({ per: ["all"], page: "2", use: "bad", sort: "name", image: "asset_1" })).toEqual(params({ per: "all", page: 2, sort: "name", image: "asset_1" }));
    expect(readListParams({ per: "30", page: "-1" })).toEqual(DEFAULT_LIST_PARAMS);
  });
});

describe("手元の一覧の直し(応答と usage で直し、読み直さない)", () => {
  it("rename_and_delete_apply_response_usage", () => {
    const used = asset("a", { usedBy: [{ experimentId: "e1", variantId: "b" }], deliveredIn: ["e1"], inUse: true, keptAt: 5 });
    const s0 = list([used, asset("b")], usage({ count: 2 }));
    // 名前の変更の応答は使い方を読まない(usedBy・deliveredIn は空、inUse は false)。手元の値を残す
    const renamed = { ...used, name: "new.png", usedBy: [], deliveredIn: [], inUse: false };
    const s1 = applyUsage(replaceAsset(s0, renamed), usage({ count: 2, bytes: 9 }));
    expect(s1.assets[0]).toMatchObject({ id: "a", name: "new.png", usedBy: used.usedBy, deliveredIn: ["e1"], inUse: true, keptAt: 5 });
    expect(s1.usage.bytes).toBe(9);
    // 一覧に無い ID の応答は足さない
    expect(replaceAsset(s0, asset("zz")).assets.map((a) => a.id)).toEqual(["a", "b"]);
    // 削除: 一覧から外し、応答の usage で使用量を直す
    const s2 = applyUsage(removeAsset(s1, "b"), usage({ count: 2, pendingCount: 1, pendingBytes: 1000 }));
    expect(s2.assets.map((a) => a.id)).toEqual(["a"]);
    expect(s2.usage.pendingCount).toBe(1);
    // 元の状態は変えない
    expect(s0.assets).toHaveLength(2);
  });

  it("deleted_asset_leaves_list_and_counts_as_pending", () => {
    const s0 = list([asset("a"), asset("b")], usage({ count: 2, bytes: 2000 }));
    const s1 = applyUsage(removeAsset(s0, "a"), usage({ count: 2, bytes: 2000, pendingCount: 1, pendingBytes: 1000 }));
    expect(s1.assets.map((a) => a.id)).toEqual(["b"]);
    expect(filterSortPage(s1.assets, DEFAULT_LIST_PARAMS).total).toBe(1);
    // 削除待ちは count に入ったまま、「うち削除待ち」に数える
    expect(usageSummary(s1.usage).text).toBe("2 / 1,000 枚(うち削除待ち 1 枚)· 2 KB / 1 GB");
    expect(usageSummary(s0.usage).text).toBe("2 / 1,000 枚 · 2 KB / 1 GB");
  });

  it("in_use_409_merges_experiment_names", () => {
    // 押した後に使い始めたエクスペリエンスの名前は、409 asset_in_use の応答の experiments から手元の表に混ぜる
    const s0: AssetList = { ...list([asset("a")]), experiments: { e1: { name: "既存", status: "running", variants: { a: "A パターン" } } } };
    const s1 = mergeExperiments(s0, { e2: { name: "新しい", status: "draft", variants: { b: "B パターン" } }, bad: { name: 1 } });
    expect(experimentOf(s1.experiments, "e1")?.name).toBe("既存");
    expect(experimentOf(s1.experiments, "e2")?.name).toBe("新しい");
    expect(variantNameOf(experimentOf(s1.experiments, "e2"), "b")).toBe("B パターン");
    expect(experimentOf(s1.experiments, "bad")).toBeUndefined();
    // 素のオブジェクトでなければ何もしない
    expect(mergeExperiments(s0, null)).toBe(s0);
    expect(mergeExperiments(s0, ["x"])).toBe(s0);
    expect(mergeExperiments(s0, "x")).toBe(s0);
    // prototype にある名前の ID でも壊れない(継承したものを返さず、__proto__ の ID は自分のキーとして持つ)
    expect(experimentOf(s0.experiments, "constructor")).toBeUndefined();
    expect(experimentOf(s0.experiments, "toString")).toBeUndefined();
    expect(variantNameOf(experimentOf(s0.experiments, "e1"), "hasOwnProperty")).toBeUndefined();
    const evil = JSON.parse('{"__proto__": {"name": "プロト", "status": "draft", "variants": {}}}') as unknown;
    const s2 = mergeExperiments(s0, evil);
    expect(Object.getPrototypeOf(s2.experiments)).toBe(Object.prototype);
    expect(experimentOf(s2.experiments, "__proto__")?.name).toBe("プロト");
    expect(experimentOf(s2.experiments, "e1")?.name).toBe("既存");
  });

  it("adds an uploaded asset at the top without the response-only fields", () => {
    const s0 = list([asset("a")]);
    const up = { ...asset("n"), renamedFrom: "a.png", usage: usage({ count: 2 }) };
    const s1 = addAsset(s0, up);
    expect(s1.assets.map((a) => a.id)).toEqual(["n", "a"]);
    expect(s1.assets[0]).not.toHaveProperty("usage");
    expect(s1.assets[0]).not.toHaveProperty("renamedFrom");
    // 同じ ID が二度届いても重ねない
    expect(addAsset(s1, up).assets.map((a) => a.id)).toEqual(["n", "a"]);
  });
});

describe("表示", () => {
  it("usage_warns_above_90_percent", () => {
    expect(usageSummary(usage({ count: 901 })).warn).toBe(true);
    expect(usageSummary(usage({ count: 900 })).warn).toBe(false);
    expect(usageSummary(usage({ bytes: Math.ceil(1024 ** 3 * 0.91) })).warn).toBe(true);
    expect(usageSummary(usage({ count: 15, bytes: 321912832 })).text).toBe("15 / 1,000 枚 · 307 MB / 1 GB");
  });

  it("formats sizes and names the format instead of the raw mime", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(319488)).toBe("312 KB");
    expect(formatBytes(1.5 * 1024 ** 2)).toBe("1.5 MB");
    expect(formatName("image/png")).toBe("PNG");
    expect(formatName("image/jpeg")).toBe("JPEG");
    expect(formatName("image/webp")).toBe("WebP");
    expect(formatName("image/avif")).toBe("AVIF");
    expect(formatName("image/gif")).toBe("GIF");
    expect(formatName("image/x-unknown")).not.toContain("image/");
  });

  it("badge_used_delivered_unused_kept", () => {
    const now = 10 * 24 * 3600 * 1000;
    const labels = (a: SiteAsset, n: number | null = now) => assetBadges(a, n).map((b) => b.label);
    expect(labels(asset("a", { inUse: true, usedBy: [{ experimentId: "e1", variantId: "a" }, { experimentId: "e1", variantId: "b" }] }))).toEqual(["使用 2"]);
    expect(labels(asset("b", { inUse: true, deliveredIn: ["e1"] }))).toEqual(["公開した内容で使用"]);
    expect(labels(asset("c"))).toEqual(["未使用"]);
    // Cron が戻した画像は 7 日の間だけ札を足す。マウント前(now = null)は出さない(サーバーとブラウザで描く内容をそろえる)
    // 格子は狭いので短い文言にし、全文は title と詳細で出す
    expect(labels(asset("d", { keptAt: now - KEPT_BADGE_MS + 1 }))).toEqual(["未使用", "残しました"]);
    expect(assetBadges(asset("d", { keptAt: now - 1 }), now)[1]?.title).toBe("使われていたので残しました");
    expect(keptNotice(asset("d", { keptAt: now - 1 }), now)).toBe("使われていたので残しました");
    expect(keptNotice(asset("d", { keptAt: now - 1 }), null)).toBeNull();
    expect(keptNotice(asset("d"), now)).toBeNull();
    expect(labels(asset("e", { keptAt: now - KEPT_BADGE_MS - 1 }))).toEqual(["未使用"]);
    expect(labels(asset("f", { keptAt: now - 1 }), null)).toEqual(["未使用"]);
  });

  it("delete_button_disabled_when_in_use", () => {
    // 押せない理由をボタンの左に文で出す(使っていなければ null = 押せる)
    expect(deleteBlockedReason(asset("a"))).toBeNull();
    expect(deleteBlockedReason(asset("b", { inUse: true, usedBy: [{ experimentId: "e1", variantId: "b" }] }))).toMatch(/パターンの変更で使われているため削除できません/);
    expect(deleteBlockedReason(asset("c", { inUse: true, deliveredIn: ["e1"] }))).toMatch(/公開したときの内容で使われているため削除できません/);
    expect(deleteBlockedReason(asset("d", { inUse: true, usedBy: [{ experimentId: "e1", variantId: "b" }], deliveredIn: ["e1"] }))).toMatch(/パターンの変更か、公開したときの内容で使われているため削除できません/);
  });
});

describe("一覧の応答 → 画面の一覧(I5)", () => {
  it("expand_rebuilds_public_and_thumbnail_urls_exactly", () => {
    const prefix = "https://assets.example.com/sites/s1/";
    const { publicUrl: _p, thumbnailUrl: _t, createdBy: _c, ...rest } = asset("asset_a");
    const base = { ...rest, creator: 0 };
    const out = expandAssetList({
      urlPrefix: prefix,
      creators: [{ id: "u1", name: "佐藤" }, { id: "u2", name: null }],
      experiments: {},
      usage: usage(),
      assets: [
        { ...base, id: "asset_a", path: "images/asset_a.png", thumbnail: "ready" },
        { ...base, id: "asset_b", path: "experiments/e1/asset_b.jpg", thumbnail: "pending" },
        { ...base, id: "asset_c", publicUrl: "https://old.example.com/sites/s1/images/asset_c.png", thumbnail: "skipped" },
        { ...base, id: "asset_d", path: "images/asset_d.png", thumbnail: "ready", thumbnailUrl: null, creator: 1 },
      ],
    });
    expect(out.assets.map((a) => [a.publicUrl, a.thumbnailUrl])).toEqual([
      [`${prefix}images/asset_a.png`, `${prefix}thumbs/asset_a.webp`],
      [`${prefix}experiments/e1/asset_b.jpg`, null],
      ["https://old.example.com/sites/s1/images/asset_c.png", null],
      [`${prefix}images/asset_d.png`, null],
    ]);
    // 応答だけの項目(path)は画面の一覧に残さない
    expect(out.assets[0]).not.toHaveProperty("path");
    // 作った人は各件の添字で上の段の creators から戻す(応答だけの creator は残さない)。名前の無い人(ユーザーが消えた)は null
    expect(out.assets[0]!.createdBy).toEqual({ id: "u1", name: "佐藤" });
    expect(out.assets[3]!.createdBy).toEqual({ id: "u2", name: null });
    expect(out.assets[0]).not.toHaveProperty("creator");
    // 表に無い添字(範囲外・負・整数でない)は ID も名前も無い
    const orphan = expandAssetList({
      urlPrefix: prefix, creators: [], experiments: {}, usage: usage(),
      assets: [2, -1, 0.5].map((creator, i) => ({ ...base, id: `asset_x${i}`, path: `images/asset_x${i}.png`, creator })),
    });
    expect(orphan.assets.map((a) => a.createdBy)).toEqual([{ id: "", name: null }, { id: "", name: null }, { id: "", name: null }]);
    // control がアップロードで書く public_url(`<公開ベース>/sites/<sid>/images/<id>.<ext>`)と同じ文字列
    expect(out.assets[0]!.publicUrl).toBe(asset("asset_a").publicUrl);
  });

  it("expand_falls_back_when_creator_index_is_missing_or_out_of_range", () => {
    // Q336 M4: 添字が無い(古い control の応答で各件が createdBy を持つ形)・表の長さちょうど(範囲外の境)・null・文字列は、
    // 表に人がいても ID も名前も無い形に倒れる(画面は名前を出さないだけで壊れない)
    const { publicUrl: _p, thumbnailUrl: _t, createdBy: _c, ...rest } = asset("asset_a");
    const creators = [{ id: "u1", name: "佐藤" }, { id: "u2", name: "鈴木" }];
    const missing = { ...rest, id: "asset_m", path: "images/asset_m.png" } as unknown as AssetListItemResponse;
    const legacy = { ...rest, id: "asset_l", path: "images/asset_l.png", createdBy: { id: "u1", name: "佐藤" } } as unknown as AssetListItemResponse;
    const odd = [2, null, "0"].map((creator, i) => ({ ...rest, id: `asset_o${i}`, path: `images/asset_o${i}.png`, creator }) as unknown as AssetListItemResponse);
    const out = expandAssetList({ urlPrefix: "https://assets.example.com/sites/s1/", creators, experiments: {}, usage: usage(), assets: [missing, legacy, ...odd] });
    expect(out.assets.map((a) => a.createdBy)).toEqual(Array.from({ length: 5 }, () => ({ id: "", name: null })));
    // 範囲の内の添字は今までどおり戻る(倒れるのは壊れた添字だけ)
    const ok = expandAssetList({ urlPrefix: "", creators, experiments: {}, usage: usage(), assets: [{ ...rest, id: "asset_k", path: "images/asset_k.png", creator: 1 }] });
    expect(ok.assets[0]!.createdBy).toEqual({ id: "u2", name: "鈴木" });
  });
});

describe("描画で渡す分(Q331: 最初のページだけ渡し、残りはマウントの後に読む)", () => {
  const item = (i: number, over: Partial<SiteAsset> = {}): AssetListItemResponse => {
    const { publicUrl: _p, thumbnailUrl: _t, createdBy: _c, ...rest } = asset(`a${String(i).padStart(4, "0")}`, { createdAt: i, ...over });
    return { ...rest, path: `images/${rest.id}.png`, creator: 0 };
  };
  const response = (n: number, over: (i: number) => Partial<SiteAsset> = () => ({})): AssetListResponse => ({
    urlPrefix: "https://assets.example.com/sites/s1/",
    creators: [{ id: "u1", name: "佐藤" }],
    experiments: { e1: { name: "E1", status: "draft", variants: {} }, e2: { name: "E2", status: "running", variants: {} } },
    usage: usage({ count: n }),
    assets: Array.from({ length: n }, (_, i) => item(i + 1, over(i + 1))),
  });

  it("initial_assets_passes_everything_when_small", () => {
    const res = response(INLINE_ASSETS_MAX);
    const out = initialAssets(res, params());
    expect(out.complete).toBe(true);
    expect(out.list).toBe(res);
    expect(out.slice).toMatchObject({ total: INLINE_ASSETS_MAX, page: 1, pages: 2, from: 1, to: 48 });
  });

  it("initial_assets_passes_only_the_requested_page_when_large", () => {
    // 2 ページ目(per 24)= 新しい順の 25〜48 件目 = createdAt 987〜964。12 件目(createdAt 1000)は 1 ページ目
    const res = response(1011, (i) => (i === 1000 ? { inUse: true, usedBy: [{ experimentId: "e1", variantId: "b" }] } : i === 970 ? { deliveredIn: ["e2"] } : {}));
    const out = initialAssets(res, params({ page: 2, per: 24 }));
    expect(out.complete).toBe(false);
    expect(out.list.assets.map((a) => a.createdAt)).toEqual(Array.from({ length: 24 }, (_, i) => 987 - i));
    expect(out.slice).toEqual({ total: 1011, page: 2, pages: 43, from: 25, to: 48, ids: out.list.assets.map((a) => a.id) });
    // 渡す各件が使うエクスペリエンスだけ
    expect(Object.keys(out.list.experiments)).toEqual(["e2"]);
    expect(out.list.creators).toBe(res.creators);
    expect(out.list.usage).toBe(res.usage);
  });

  it("initial_assets_caps_all_and_adds_the_selected_image", () => {
    const res = response(300, (i) => (i === 5 ? { inUse: true, usedBy: [{ experimentId: "e1", variantId: "b" }], deliveredIn: ["e2"] } : {}));
    const all = initialAssets(res, params({ per: "all" }));
    expect(all.list.assets).toHaveLength(INLINE_ASSETS_MAX);
    expect(all.slice).toMatchObject({ total: 300, pages: 1, from: 1, to: 300 });
    // ?image= がページの外: その 1 件を足す(ids には入れない = 格子には出さない)。使うエクスペリエンスも渡す
    const sel = initialAssets(res, params({ image: "a0005" }));
    expect(sel.list.assets).toHaveLength(49);
    expect(sel.list.assets.at(-1)!.id).toBe("a0005");
    expect(sel.slice.ids).toHaveLength(48);
    expect(sel.slice.ids).not.toContain("a0005");
    expect(Object.keys(sel.list.experiments).sort()).toEqual(["e1", "e2"]);
    // 無い ID は足さない
    expect(initialAssets(res, params({ image: "nope" })).list.assets).toHaveLength(48);
  });

  it("pending_slice_reuses_the_rendered_page_until_params_change", () => {
    const init = { total: 500, page: 2, pages: 11, from: 49, to: 96, ids: ["x", "y", "z"] };
    const p0 = params({ page: 2 });
    const assets = [asset("y", { name: "renamed.png" }), asset("x"), asset("other")];
    const s = pendingSlice(assets, init, p0, { ...p0, image: "x" });
    // 消した z は出ない・名前の変更は入る・渡していない画像は足さない。数は描画のときの値
    expect(s).toEqual({ items: [assets[1], assets[0]], total: 500, page: 2, pages: 11, from: 49, to: 96 });
    expect(pendingSlice(assets, init, p0, { ...p0, page: 3 })).toBeNull();
    expect(pendingSlice(assets, init, p0, { ...p0, q: "a" })).toBeNull();
    expect(pendingSlice(assets, init, p0, { ...p0, sort: "name" })).toBeNull();
  });

  it("replay_ops_keeps_edits_made_before_the_full_list_arrived", () => {
    const up = asset("new", { createdAt: 9 });
    const u2 = usage({ count: 3 });
    const ops: AssetListOp[] = [
      (s) => addAsset(s, up),
      (s) => applyUsage(replaceAsset(s, asset("a", { name: "renamed.png" })), u2),
      (s) => removeAsset(s, "b"),
    ];
    // 全件の GET は書き込みより前に始まっていた(上がった画像が無く、b がまだある)
    const out = replayOps(list([asset("a"), asset("b"), asset("c")]), ops);
    expect(out.assets.map((a) => [a.id, a.name])).toEqual([["new", "new.png"], ["a", "renamed.png"], ["c", "c.png"]]);
    expect(out.usage).toBe(u2);
    // GET が書き込みの後に始まっていた(上がった画像がもう入っている)ときも二重にならない
    expect(replayOps(list([up, asset("a"), asset("c")]), ops).assets.map((a) => a.id)).toEqual(["new", "a", "c"]);
  });
});
