import { assetItemUrls } from "@wtt/core";
import { URL_PARAM_EVENT, withParam } from "./url-state";
import type { AssetList, AssetListResponse, AssetUsage, Capabilities, SiteAsset, Variant } from "./types";

/**
 * B68: サイトの画像の一覧の画面(app/w/[wid]/sites/[sid]/images)の手元の決まり。React に依らない純粋な関数にして単体テストする(test/images.test.ts)。
 * 一覧は画面を開いたときの 1 回の GET(多いサイトは描画で最初のページを渡し、マウントの後に BFF で全件をもう 1 回)で持ち、名前の変更・削除・アップロードの応答(1 件と usage)で手元を直す(読み直さない。spec §11 の K3)。
 * 絞り込み・並べ替え・ページは取得済みの一覧を画面の中で切るだけ(決まり 3.4)
 */

// ---- 画面の出し分け(spec §9.1) ----

export type ImagesPageMode = "library" | "uploader" | "guide";

/** R2 あり = ライブラリ / R2 なしでアップローダーあり = アップローダーの画面 / どちらも無い = 案内だけ。imageUploader の欠け(古い control)は false */
export function imagesPageMode(caps: Pick<Capabilities, "imageUpload" | "imageUploader">): ImagesPageMode {
  if (caps.imageUpload) return "library";
  return caps.imageUploader === true ? "uploader" : "guide";
}

// ---- パターンの画面の IMAGE の欄(spec §8・§9.3・§9.4) ----

/** picker = 選ぶ窓(R2 あり)/ url = URL の文字入力(R2 なし・アップローダーあり)/ off = IMAGE を新しく使えない(今の一文) */
export type ImageFieldMode = "picker" | "url" | "off";

export function imageFieldMode(caps: Pick<Capabilities, "imageUpload" | "imageUploader">): ImageFieldMode {
  if (caps.imageUpload) return "picker";
  return caps.imageUploader === true ? "url" : "off";
}

/** どれかのパターンの下書きに IMAGE の変更があるか */
export function hasImageChange(variants: ReadonlyArray<Pick<Variant, "changes">>): boolean {
  return variants.some((v) => v.changes.some((c) => c.type === "IMAGE"));
}

/** マウントの後にサイトの画像の一覧を読むか(選ぶ窓のときで、IMAGE の変更があるときだけ。無ければ窓を初めて開いたときに読む) */
export function shouldPreloadAssets(mode: ImageFieldMode, variants: ReadonlyArray<Pick<Variant, "changes">>): boolean {
  return mode === "picker" && hasImageChange(variants);
}

/** 一覧に無い URL の IMAGE に出す文(古い保存・削除済み。保存は control が 422 で断る) */
export const MISSING_IMAGE_TEXT = "この画像はサイトの画像の一覧にありません";

export type ImageFieldView = { kind: "empty" } | { kind: "loading" } | { kind: "found"; asset: SiteAsset } | { kind: "missing" };

/** IMAGE の src を一覧と照らす。assets = null は読み終わる前(欄は公開 URL を等幅で出す) */
export function assetForSrc(assets: readonly SiteAsset[] | null, src: string): ImageFieldView {
  if (src.trim() === "") return { kind: "empty" };
  if (assets === null) return { kind: "loading" };
  const asset = assets.find((a) => a.publicUrl === src);
  return asset ? { kind: "found", asset } : { kind: "missing" };
}

/** 窓を開けるか(閲覧者・終了したエクスペリエンス = disabled と、URL の入力の導入では開かない) */
export function canOpenPicker(o: { disabled: boolean; mode: ImageFieldMode }): boolean {
  return !o.disabled && o.mode === "picker";
}

/** 「この画像を使う」を押せるか(選んだ画像が手元の一覧にあるときだけ) */
export function canUsePick(selected: string | null, assets: readonly SiteAsset[] | null): boolean {
  return selected !== null && assets !== null && assets.some((a) => a.id === selected);
}

/** 窓を開いたときに選んでおく画像(今の src の画像。無ければ null) */
export function pickerInitial(assets: readonly SiteAsset[] | null, src: string): string | null {
  const v = assetForSrc(assets, src);
  return v.kind === "found" ? v.asset.id : null;
}

/** 窓の中で上がった画像を選ぶ(続けて上がれば、最後に上がった 1 枚が残る) */
export function afterUploadedSelection(_selected: string | null, uploaded: Pick<SiteAsset, "id">): string {
  return uploaded.id;
}

// ---- 一覧の引数(URL の ?q= ?use= ?sort= ?per= ?page= ?image=) ----

export const USE_FILTERS = ["all", "used", "unused"] as const;
export type UseFilter = (typeof USE_FILTERS)[number];
export const SORT_KEYS = ["new", "name", "size"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const PER_PAGES = [24, 48, 96, "all"] as const;
export type PerPage = (typeof PER_PAGES)[number];

export const USE_LABELS: Record<UseFilter, string> = { all: "すべて", used: "使っている", unused: "使っていない" };
export const SORT_LABELS: Record<SortKey, string> = { new: "新しい順", name: "名前順", size: "大きい順" };

export type ListParams = { q: string; use: UseFilter; sort: SortKey; per: PerPage; page: number; image: string | null };

export const DEFAULT_LIST_PARAMS: ListParams = { q: "", use: "all", sort: "new", per: 48, page: 1, image: null };

type SearchSource = URLSearchParams | Record<string, string | string[] | undefined>;

function getParam(source: SearchSource, key: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const v = source[key];
  return Array.isArray(v) ? v[0] : v;
}

/** URL の引数(ブラウザの URLSearchParams か、サーバーのページの searchParams)から一覧の状態を読む。許さない値は既定 */
export function readListParams(source: SearchSource): ListParams {
  const use = getParam(source, "use");
  const sort = getParam(source, "sort");
  const perRaw = getParam(source, "per");
  const per = PER_PAGES.find((p) => String(p) === perRaw) ?? DEFAULT_LIST_PARAMS.per;
  const pageNum = Number(getParam(source, "page"));
  const image = getParam(source, "image");
  return {
    q: getParam(source, "q") ?? "",
    use: (USE_FILTERS as readonly string[]).includes(use ?? "") ? (use as UseFilter) : DEFAULT_LIST_PARAMS.use,
    sort: (SORT_KEYS as readonly string[]).includes(sort ?? "") ? (sort as SortKey) : DEFAULT_LIST_PARAMS.sort,
    per,
    page: Number.isInteger(pageNum) && pageNum >= 1 ? pageNum : 1,
    image: image ? image : null,
  };
}

/** 一覧の状態を今の検索文字列(先頭の ? はあってもなくてもよい)に書いた結果。既定の値は書かない。ほかの引数は残す */
export function listParamsSearch(p: ListParams, currentSearch: string): string {
  const d = DEFAULT_LIST_PARAMS;
  let href = `/${currentSearch && !currentSearch.startsWith("?") ? `?${currentSearch}` : currentSearch}`;
  href = withParam(href, "q", p.q === d.q ? null : p.q);
  href = withParam(href, "use", p.use === d.use ? null : p.use);
  href = withParam(href, "sort", p.sort === d.sort ? null : p.sort);
  href = withParam(href, "per", p.per === d.per ? null : String(p.per));
  href = withParam(href, "page", p.page === d.page ? null : String(p.page));
  href = withParam(href, "image", p.image);
  return href.slice(1);
}

/** ブラウザ専用。URL に history.replaceState で書く(履歴を増やさず、再取得もしない。決まり 3.4)。サーバーでは何もしない */
export function writeListParams(p: ListParams): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const next = `${pathname}${listParamsSearch(p, search)}${hash}`;
  if (next === `${pathname}${search}${hash}`) return;
  window.history.replaceState(window.history.state, "", next);
  window.dispatchEvent(new Event(URL_PARAM_EVENT));
}

// ---- 絞り込み・並べ替え・ページ ----

export type PageSlice<T = SiteAsset> = { items: T[]; total: number; page: number; pages: number; from: number; to: number };

/** 絞り込み・並べ替えに使う項目(画面の一覧の 1 件と、URL を戻す前の応答の 1 件の両方が持つ) */
type Sortable = Pick<SiteAsset, "name" | "inUse" | "size" | "createdAt">;

const byName = (a: Sortable, b: Sortable) => {
  // サーバーとブラウザで並びが変わらないよう、locale に依らない比べ方にする(小文字にしてから符号の順)
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

export function filterSortPage<T extends Sortable>(list: T[], p: Pick<ListParams, "q" | "use" | "sort" | "per" | "page">): PageSlice<T> {
  const q = p.q.trim().toLowerCase();
  const filtered = list.filter((a) => (q === "" || a.name.toLowerCase().includes(q)) && (p.use === "all" || (p.use === "used" ? a.inUse : !a.inUse)));
  const sorted = [...filtered].sort(p.sort === "name" ? byName : p.sort === "size" ? (a, b) => b.size - a.size : (a, b) => b.createdAt - a.createdAt);
  const total = sorted.length;
  if (p.per === "all") return { items: sorted, total, page: 1, pages: 1, from: total ? 1 : 0, to: total };
  const pages = Math.max(1, Math.ceil(total / p.per));
  const page = Math.min(Math.max(1, Math.floor(p.page) || 1), pages);
  const start = (page - 1) * p.per;
  const items = sorted.slice(start, start + p.per);
  return { items, total, page, pages, from: items.length ? start + 1 : 0, to: start + items.length };
}

// ---- 画面の描画で渡す分(最初のページだけ) ----

/**
 * 画面の描画(サーバー)でクライアントの部品に全件を渡す上限。これより多いサイトは、今表示するページの分だけを渡し、残りはマウントの後に BFF で読む
 * (1,000 枚の一覧を全部渡すと、RSC の直列化と HTML への埋め込みで admin の CPU が大きく増えたため)。
 * 値は数で選べる 1 ページの最大(96)と同じ: これ以下なら全件を渡しても 1 ページ分の大きさで、往復を 1 つ増やさずに済む
 */
export const INLINE_ASSETS_MAX = 96;

/** 描画で渡す一覧。complete = 全件が入っている(マウントの後に読まない)。slice = 渡したページの数の表示(全件を読み終わるまで使う) */
export type InitialAssets = { list: AssetListResponse; complete: boolean; slice: Omit<PageSlice, "items"> & { ids: string[] } };

/**
 * 一覧の応答から、描画で渡す分を切る(URL を戻す前の形のまま切るので、全件の URL を組み立てない)。
 * - 全件が INLINE_ASSETS_MAX 以下: 全件を渡す(complete)
 * - それより多い: URL の引数(絞り込み・並べ替え・ページ)どおりの今のページの分。「すべて」は INLINE_ASSETS_MAX で頭打ち(残りは読み終わってから出す)。
 *   ?image= の画像がそのページの外にあれば、その 1 件も渡す(詳細を読み込みの前から開けるように)。
 *   experiments は渡す各件が使うエクスペリエンスだけにする。creators は人数が少ないのでそのまま(各件の添字を変えない)
 */
export function initialAssets(res: AssetListResponse, params: ListParams): InitialAssets {
  const s = filterSortPage(res.assets, params);
  const meta = { total: s.total, page: s.page, pages: s.pages, from: s.from, to: s.to };
  if (res.assets.length <= INLINE_ASSETS_MAX) return { list: res, complete: true, slice: { ...meta, ids: s.items.map((a) => a.id) } };
  const items = s.items.slice(0, INLINE_ASSETS_MAX);
  const ids = items.map((a) => a.id);
  if (params.image && !ids.includes(params.image)) {
    const sel = res.assets.find((a) => a.id === params.image);
    if (sel) items.push(sel);
  }
  const used = new Set(items.flatMap((a) => [...a.usedBy.map((u) => u.experimentId), ...a.deliveredIn]));
  const experiments = Object.fromEntries(Object.entries(res.experiments).filter(([id]) => used.has(id)));
  return { list: { ...res, assets: items, experiments }, complete: false, slice: { ...meta, ids } };
}

/**
 * 全件を読み終わるまでの格子の分。URL の引数(絞り込み・並べ替え・数・ページ)が描画のときのままなら、描画で渡したページの分を
 * 手元の一覧から引いて出す(名前の変更・削除を手元で直した分が入る。アップロードした画像は読み終わってから並ぶ)。引数が変わっていれば null(読み込み中の表示)
 */
export function pendingSlice(assets: SiteAsset[], initial: InitialAssets["slice"], initialParams: ListParams, params: ListParams): PageSlice | null {
  const same = (["q", "use", "sort", "per", "page"] as const).every((k) => params[k] === initialParams[k]);
  if (!same) return null;
  const byId = new Map(assets.map((a) => [a.id, a]));
  const items = initial.ids.flatMap((id) => {
    const a = byId.get(id);
    return a ? [a] : [];
  });
  return { items, total: initial.total, page: initial.page, pages: initial.pages, from: initial.from, to: initial.to };
}

/** 全件を読み終わるまでに手元の一覧へ当てた直し(読み終わったら、全件にもう一度当てる) */
export type AssetListOp = (s: AssetList) => AssetList;

/** 読み終わった全件に、読み終わるまでに当てた直しを順に当て直す(addAsset は同じ ID を足さず、removeAsset・replaceAsset は何度当てても同じ) */
export function replayOps(full: AssetList, ops: readonly AssetListOp[]): AssetList {
  return ops.reduce((s, op) => op(s), full);
}

// ---- 一覧の応答 → 画面の一覧 ----

/**
 * `GET /sites/:sid/assets` の応答の各件に、公開 URL と縮小版の URL と作った人の名前を戻す(画面で URL を作るのはここ 1 か所)。
 * 組み立ては control と同じ @wtt/core の `assetItemUrls` なので、戻した公開 URL は IMAGE の src に書く値(control の public_url)と一字一句同じ。
 * 作った人は各件の添字で上の段の creators から引き、画面の形(`createdBy: { id, name }`)に戻す
 * (添字が表に無いときは ID も名前も無い = `{ id: "", name: null }`。control は必ず表にある添字を返すので、壊れた応答への備え)
 */
export function expandAssetList(res: AssetListResponse): AssetList {
  const prefix = res.urlPrefix ?? "";
  const creators = Array.isArray(res.creators) ? res.creators : [];
  return {
    experiments: res.experiments,
    usage: res.usage,
    assets: res.assets.map((item) => {
      const { path: _path, publicUrl: _publicUrl, thumbnailUrl: _thumbnailUrl, creator, ...rest } = item;
      const c = Number.isInteger(creator) && creator >= 0 ? creators[creator] : undefined;
      return { ...rest, ...assetItemUrls(prefix, item), createdBy: { id: c?.id ?? "", name: c?.name ?? null } };
    }),
  };
}

// ---- 手元の一覧の直し(応答で直し、読み直さない) ----

/** 応答の usage で使用量を置き換える(上限の正は control。ほかの人の操作で増えた分もここで入る) */
export function applyUsage(state: AssetList, usage: AssetUsage): AssetList {
  return { ...state, usage };
}

/** 削除待ちにした画像を一覧から外す(削除待ちは一覧に出ない) */
export function removeAsset(state: AssetList, id: string): AssetList {
  return { ...state, assets: state.assets.filter((a) => a.id !== id) };
}

/**
 * 名前の変更の応答で 1 件を差し替える。応答は使い方を読まない(usedBy・deliveredIn は空、inUse は false)ので、
 * 使い方(usedBy・deliveredIn・inUse・keptAt)は手元の値を残す。一覧に無い ID は足さない
 */
export function replaceAsset(state: AssetList, next: SiteAsset): AssetList {
  return {
    ...state,
    assets: state.assets.map((a) => (a.id === next.id ? { ...pickAsset(next), usedBy: a.usedBy, deliveredIn: a.deliveredIn, inUse: a.inUse, keptAt: a.keptAt } : a)),
  };
}

/** アップロードした 1 件を先頭に足す(新しい順の先頭)。同じ ID がもうあれば足さない */
export function addAsset(state: AssetList, next: SiteAsset): AssetList {
  if (state.assets.some((a) => a.id === next.id)) return state;
  return { ...state, assets: [pickAsset(next), ...state.assets] };
}

/** 応答だけにある項目(usage・renamedFrom)を外して、一覧の 1 件の形にする */
function pickAsset(a: SiteAsset): SiteAsset {
  const { id, name, publicUrl, thumbnailUrl, thumbnail, mime, size, width, height, createdAt, createdBy, usedBy, deliveredIn, inUse, keptAt } = a;
  return { id, name, publicUrl, thumbnailUrl, thumbnail, mime, size, width, height, createdAt, createdBy, usedBy, deliveredIn, inUse, keptAt };
}

type ExperimentRef = AssetList["experiments"][string];

/** 自分のキーだけで引く(`constructor`・`__proto__` など prototype にある名前の ID で、継承したプロパティを返さない。core の own() と同じ考え方) */
const ownValue = <T>(o: Record<string, T>, k: string): T | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** 使っているエクスペリエンスの名前・状態(一覧の応答の experiments から。無ければ undefined) */
export function experimentOf(experiments: AssetList["experiments"], id: string): ExperimentRef | undefined {
  return ownValue(experiments, id);
}

/** パターンの名前(無ければ undefined) */
export function variantNameOf(exp: ExperimentRef | undefined, variantId: string): string | undefined {
  return exp ? ownValue(exp.variants, variantId) : undefined;
}

const isExperimentRef = (v: unknown): v is ExperimentRef => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.status !== "string") return false;
  const vs = o.variants;
  return typeof vs === "object" && vs !== null && !Array.isArray(vs) && Object.values(vs).every((x) => typeof x === "string");
};

/**
 * 409 asset_in_use などの応答に入った experiments(名前の表)を手元の表に混ぜる。素のオブジェクトでなければ何もしない。
 * 形の違う項目は捨てる。キーは Object.entries / fromEntries(定義として置く)で写すので、`__proto__` の ID でも prototype を変えない
 */
export function mergeExperiments(state: AssetList, extra: unknown): AssetList {
  if (typeof extra !== "object" || extra === null || Array.isArray(extra)) return state;
  const valid = Object.entries(extra as Record<string, unknown>).filter((e): e is [string, ExperimentRef] => isExperimentRef(e[1]));
  if (valid.length === 0) return state;
  return { ...state, experiments: Object.fromEntries([...Object.entries(state.experiments), ...valid]) };
}

/** 409 の本文などに入った usage が正しい形か */
export function isAssetUsage(v: unknown): v is AssetUsage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return ["count", "bytes", "pendingCount", "pendingBytes", "maxCount", "maxBytes", "maxFileBytes"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k]));
}

// ---- 表示 ----

/** 数を 3 桁ごとに区切る(locale に依らず同じ文字にする) */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** バイト数を 1024 の段で(上限の 1 GB = 1024 MB を「1 GB」と出すため) */
export function formatBytes(n: number): string {
  const steps: Array<[number, string]> = [[1024 ** 3, "GB"], [1024 ** 2, "MB"], [1024, "KB"]];
  for (const [size, label] of steps) {
    if (n >= size) {
      const v = n / size;
      return `${Number(v.toFixed(v >= 10 ? 0 : 1))} ${label}`;
    }
  }
  return `${n} B`;
}

/** 1 枚の上限の文字(5MB など)。MB の単位で割り切れなければ formatBytes */
export function formatFileLimit(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  return Number.isInteger(mb) ? `${mb}MB` : formatBytes(bytes);
}

/** この割合を超えたら使用量を黄の文字にする */
export const USAGE_WARN_RATIO = 0.9;

/** 見出しの下の使用量の 1 行と棒。ratio は枚数と合計の大きいほう(棒の長さ) */
export function usageSummary(u: AssetUsage): { text: string; warn: boolean; ratio: number } {
  const pending = u.pendingCount > 0 ? `(うち削除待ち ${formatCount(u.pendingCount)} 枚)` : " ";
  const text = `${formatCount(u.count)} / ${formatCount(u.maxCount)} 枚${pending}· ${formatBytes(u.bytes)} / ${formatBytes(u.maxBytes)}`;
  const ratio = Math.max(u.maxCount > 0 ? u.count / u.maxCount : 0, u.maxBytes > 0 ? u.bytes / u.maxBytes : 0);
  return { text, warn: ratio > USAGE_WARN_RATIO, ratio: Math.min(1, ratio) };
}

/** 形式の名前(mime の生の値は画面に出さない。決まり 4.5) */
const FORMAT_NAMES: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WebP", "image/avif": "AVIF" };
export function formatName(mime: string): string {
  return FORMAT_NAMES[mime] ?? "その他の形式";
}

/** 1MB を超える画像は、表示速度への注意を出す */
export const LARGE_IMAGE_BYTES = 1024 ** 2;

/** Cron が削除待ちから戻した画像に札を出す期間 */
export const KEPT_BADGE_MS = 7 * 24 * 3600 * 1000;

export type AssetBadge = { label: string; tone: "ok" | "gray" | "warn"; /** 札の全文(格子では短い文言にし、全文は title で見せる) */ title?: string };

/** Cron が戻した画像の札の全文。格子の 1 枚は狭い(6 列・2 列で中身 約 115px)ので「残しました」にし、全文は title と詳細で出す */
export const KEPT_BADGE_TEXT = "使われていたので残しました";

/** 格子の 1 枚の札。now = null(マウントの前)は 7 日の札を出さない(サーバーとブラウザで描く内容をそろえる) */
export function assetBadges(a: SiteAsset, now: number | null): AssetBadge[] {
  const out: AssetBadge[] = [];
  if (a.usedBy.length > 0) out.push({ label: `使用 ${a.usedBy.length}`, tone: "ok" });
  else if (a.deliveredIn.length > 0) out.push({ label: "公開した内容で使用", tone: "ok" });
  else out.push({ label: "未使用", tone: "gray" });
  if (a.keptAt !== null && now !== null && now - a.keptAt <= KEPT_BADGE_MS) out.push({ label: "残しました", tone: "warn", title: KEPT_BADGE_TEXT });
  return out;
}

/** 詳細に出す「残しました」の全文(7 日の間だけ。now = null は出さない) */
export function keptNotice(a: SiteAsset, now: number | null): string | null {
  return assetBadges(a, now).some((b) => b.title === KEPT_BADGE_TEXT) ? KEPT_BADGE_TEXT : null;
}

/** 削除のボタンを押せない理由(ボタンの左に文で出す。決まり 2.6)。押せるときは null */
export function deleteBlockedReason(a: SiteAsset): string | null {
  if (!a.inUse) return null;
  const draft = a.usedBy.length > 0;
  const delivered = a.deliveredIn.length > 0;
  if (draft && !delivered) return "パターンの変更で使われているため削除できません。パターンの変更から外すと削除できます";
  if (delivered && !draft) return "公開したときの内容で使われているため削除できません。そのエクスペリエンスを削除するまで削除できません";
  return "パターンの変更か、公開したときの内容で使われているため削除できません";
}
