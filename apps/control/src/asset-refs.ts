/**
 * B68(spec §3.1「参照の見方」・§22.3・§22.4): 文字列の中の画像の参照を取り出す純粋な関数。
 * D1・env・`cloudflare:workers` を触らない(保存の確かめ・公開の確かめ・確認の画面と、本番の控えを数える手元のスクリプトが同じ関数を使うため)。
 * どの関数も本体を 1 回の走査(`matchAll`)で見て、本体を写さない(512KB の設定の CPU。plan Task 0 Step 3b)
 */

/**
 * 受理する画像の拡張子(`routes/assets.ts` の形式の表 `IMAGE_TYPES` の ext と同じ。asset-refs.test.ts が表と照らす)。
 * ここに表を import しないのは、このファイルを Workers の外(手元のスクリプト)からも読めるようにするため
 */
export const ASSET_EXTENSIONS = ["png", "jpg", "gif", "webp", "avif"] as const;

/**
 * URL として正規化した形(WHATWG URL の href)。相対 URL・URL でない文字列は null。
 * ドットセグメント(`..`・`%2e%2e`・`.%2e` を大文字小文字を問わず)を解決し、スキームとホスト名を小文字にする。
 * IMAGE の保存の確かめ(validation.ts)と、アップローダーの URL の取り出しが共有する(別に書かない。plan Task 3)
 */
export function canonical(u: string): string | null {
  try {
    return new URL(u).href;
  } catch {
    return null;
  }
}

/** 正規表現の特殊文字を逃がす */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/**
 * 画像の ID(`asset_` + `[a-z0-9]{10}`。spec §3.2)のうち、文字列にそのまま現れるものを重なりを除いて返す。戻しの処理はしない。
 * 前後の境は見ない: Cron の判定(`instr(…, id)`)・`asset_delivered_refs` を埋める文(`instr(d.definition_json, a.id)`)と同じ規則にする
 * (spec §1・§3.1・§22.3 の「ID の素の出現」。広く守る向き)。境を付けると `hero_asset_…`・`images%2fasset_…` のような instr なら当たる出現を
 * 取りこぼし、Cron の印の `NOT EXISTS (… asset_delivered_refs …)` が真になって、公開したときの定義だけが指す画像が消されうる。
 * 拾いすぎ(`asset_backgrounds` の先頭 16 字など)は安全な側の誤り(spec §6.1)。`[a-z0-9]{10}` は `_` を含まないので当たりは重ならない。
 * `asset_delivered_refs` の取り出しが使う(Task 4)
 */
export function extractAssetIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/asset_[a-z0-9]{10}/g)) out.add(m[0]);
  return [...out];
}

export type ManagedAssetUrl = { url: string; siteId: string; assetId: string };

const EXT = ASSET_EXTENSIONS.join("|");
const managedReCache = new Map<string, RegExp>();
/** 公開ベースごとの正規表現(同じ isolate の中で作り直さない) */
function managedRe(base: string): RegExp {
  let re = managedReCache.get(base);
  if (!re) {
    const id = "(asset_[a-z0-9]{10})";
    re = new RegExp(
      `${escapeRe(base)}/sites/([A-Za-z0-9_-]+)/(?:images/${id}\\.(?:${EXT})|experiments/[A-Za-z0-9_-]+/${id}\\.(?:${EXT})|thumbs/${id}\\.webp)(?![A-Za-z0-9])`,
      "g",
    );
    managedReCache.set(base, re);
  }
  return re;
}

/**
 * spec §22.3 の「管理する画像の URL」(新しいキー `…/sites/<sid>/images/<id>.<ext>`・今あるキー `…/sites/<sid>/experiments/<eid>/<id>.<ext>`・
 * 縮小版 `…/sites/<sid>/thumbs/<id>.webp`)のうち、文字列にそのまま現れるものを重なりを除いて返す。
 * `publicBase` は設定の値(末尾の `/` は除く)をそのまま前に付ける。ホスト名の大文字・`/` の文字参照など別の書き方は拾わない。
 * 別のサイトの URL も `siteId` 付きで返す(呼び出し側が `asset_other_site` にする)
 */
export function extractManagedAssetUrls(text: string, publicBase: string): ManagedAssetUrl[] {
  const base = publicBase.replace(/\/+$/, "");
  if (base === "") return [];
  const seen = new Set<string>();
  const out: ManagedAssetUrl[] = [];
  for (const m of text.matchAll(managedRe(base))) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ url: m[0], siteId: m[1]!, assetId: (m[2] ?? m[3] ?? m[4])! });
  }
  return out;
}

export type UploaderSiteUrl = { url: string; siteId: string };

/**
 * spec §22.3 の「アップローダーの URL の形」(Q263): `<uploaderBase>/u/` で始まり区切りの文字の前までを候補に拾い(公開ベースの部分は
 * 大文字・小文字を区別しない)、候補ごとに `canonical()` を当てて、正規化した形が `<uploaderBase>/u/<sid>/` で始まるものだけ `<sid>` を読む。
 * `/u/` の外へ出る・URL として読めない候補は捨てる。文字参照・CSS のエスケープ・`%2F` で区切りを書いた形は拾わない(受け入れる)。
 * `uploaderBase` は `uploaderPublicBase(env)` の値(origin。null・空なら空を返す)。`url` は本体にそのまま現れた候補
 */
export function extractUploaderSiteUrls(text: string, uploaderBase: string | null): UploaderSiteUrl[] {
  const base = (uploaderBase ?? "").replace(/\/+$/, "");
  if (base === "") return [];
  const head = canonical(`${base}/u/`);
  if (head === null) return [];
  const seen = new Set<string>();
  const out: UploaderSiteUrl[] = [];
  for (const m of text.matchAll(new RegExp(`${escapeRe(base)}/u/[^\\s"'\\\\<>()]*`, "gi"))) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    const href = canonical(url);
    if (href === null || !href.startsWith(head)) continue;
    const sid = /^([A-Za-z0-9_-]+)\//.exec(href.slice(head.length));
    if (sid) out.push({ url, siteId: sid[1]! });
  }
  return out;
}

/**
 * HTML の名前付き文字参照のうち、管理する画像の URL に現れうる文字(`:` `/` `.` `_` `-`)と、属性の中で使う区切りの文字。
 * 名前付き参照は大文字・小文字を区別する(HTML の規則)
 */
const NAMED_REFS: Record<string, string> = {
  sol: "/", colon: ":", period: ".", lowbar: "_", UnderBar: "_", hyphen: "-", dash: "-", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", percnt: "%", bsol: "\\", num: "#",
};
/** HTML の文字参照(10 進・16 進・名前付き)・CSS のエスケープ(`\` + 16 進 1〜6 桁 + 空白 1 つ / `\` + 1 字)・`%` + 16 進 2 桁を 1 回の走査で戻す */
const ENCODED_RE = /&#(\d{1,7});?|&#[xX]([0-9a-fA-F]{1,6});?|&([A-Za-z]+);|\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|\\([^\n\r\f0-9a-fA-F])|%([0-9a-fA-F]{2})/g;
const fromCode = (n: number): string | null => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null);
function decodeOnce(text: string): string {
  return text.replace(ENCODED_RE, (all, dec?: string, hex?: string, name?: string, css?: string, cssChar?: string, pct?: string) => {
    if (dec !== undefined) return fromCode(Number(dec)) ?? all;
    if (hex !== undefined) return fromCode(parseInt(hex, 16)) ?? all;
    if (name !== undefined) return Object.prototype.hasOwnProperty.call(NAMED_REFS, name) ? NAMED_REFS[name]! : all;
    if (css !== undefined) return fromCode(parseInt(css, 16)) ?? all;
    if (cssChar !== undefined) return cssChar;
    if (pct !== undefined) return String.fromCharCode(parseInt(pct, 16));
    return all;
  });
}

/**
 * spec §22.4: 画像の URL を符号化した参照。`text` に `&`・`\`・`%` のどれも無ければ空(戻さない)。
 * あれば 1 回戻した文字列から管理する画像の URL を探し、戻す前の文字列にそのまま現れないものを返す。
 * URL の形でない ID の形の語(`&#97;sset_…` だけ)は当たらない
 */
export function findEncodedAssetUrls(text: string, publicBase: string): string[] {
  if (!/[&\\%]/.test(text)) return [];
  const decoded = decodeOnce(text);
  if (decoded === text) return [];
  return extractManagedAssetUrls(decoded, publicBase)
    .map((u) => u.url)
    .filter((url) => !text.includes(url));
}
