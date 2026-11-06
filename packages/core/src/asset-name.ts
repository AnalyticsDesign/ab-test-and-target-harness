/**
 * 画像のライブラリの「名前」の規則(B68、spec §3.3)。control のアップロードの口が使う(runtime には入らない)。
 *
 * - 長さは JS の文字列の長さ(UTF-16 のコード単位、`.length`)で数える。切るときにサロゲートペアの途中で切らない
 *   (切り目がペアの前半に当たったらその 1 字も落とすので、結果は上限より 1 短くなりうる)
 * - 重なりの判定は `assetNameKey`(英字だけの小文字化)。D1 の `UNIQUE (site_id, name_key)` と、SQLite の `lower()` の規則が同じ
 * - 番号の候補は Worker で作り、D1 には `json_each` で一括で照会する。LIKE のパターンは作らない(D1 は 50 バイトまで)
 */

/** 名前の長さの上限(`.length`) */
export const ASSET_NAME_MAX = 100;

/** 1 回の照会で調べる番号の候補の数 */
export const ASSET_NAME_CANDIDATES_PER_QUERY = 50;

/** 拡張子として残す長さの上限(最後の `.` から後ろ、`.` を含む) */
const EXT_MAX = 6;

/** 制御文字(U+0000–U+001F・U+007F) */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** `s` を `max` 字(コード単位)以内に切る。切り目が上位サロゲート(ペアの前半)で終わるときは、その 1 字も落とす */
function cutUnits(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** 名前を「本体」と「拡張子(`.` を含む)」に分ける。拡張子が無い・6 字を超える・先頭の `.` だけのときは拡張子を空にする */
function splitExt(name: string): { body: string; ext: string } {
  const i = name.lastIndexOf(".");
  if (i <= 0 || name.length - i > EXT_MAX) return { body: name, ext: "" };
  return { body: name.slice(0, i), ext: name.slice(i) };
}

/** 本体・拡張子・つなぎの文字列を足して `ASSET_NAME_MAX` 以内に収める(収まらない分は本体から切る) */
function fit(body: string, mid: string, ext: string): string {
  return cutUnits(body, ASSET_NAME_MAX - mid.length - ext.length) + mid + ext;
}

/**
 * 受けた名前を切らずに整える。NFC にそろえ、制御文字を落とし、前後の空白を落とす。
 * 名前の変更(PATCH)が使う: 結果が空か `ASSET_NAME_MAX` を超えるなら呼び出し側が 422 にする(切るのはアップロードのときだけ)。
 * `/` `\` は名前の中の文字としてそのまま持つ
 */
export function cleanAssetName(raw: string): string {
  return raw.normalize("NFC").replace(CONTROL_CHARS, "").trim();
}

/**
 * アップロードで受けた名前を整える(`cleanAssetName` の上に組み立てる)。
 * 100 字を超えるときは拡張子(最後の `.` から後ろ、6 字以内)を残して本体を切り、切った本体の末尾の空白を落とす
 * (拡張子が無いときは結果全体。もう一度通しても同じ結果になるように)。空なら `""`(既定の名前は呼び出し側が決める)
 */
export function normalizeAssetName(raw: string): string {
  const name = cleanAssetName(raw);
  if (name.length <= ASSET_NAME_MAX) return name;
  const { body, ext } = splitExt(name);
  return cutUnits(body, ASSET_NAME_MAX - ext.length).trimEnd() + ext;
}

/** 重なりの判定に使う key。英字(A–Z)だけを小文字にする(SQLite の `lower()` と同じ。全角などは畳まない) */
export function assetNameKey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * 番号の候補 `<本体> (<n>)<拡張子>` を `n = fromN … fromN + count - 1` の順に返す。
 * 100 字を超えるときは、その `n` の桁に合わせて本体を切る(候補ごとに切り方が違う)
 */
export function assetNameCandidates(name: string, fromN: number, count: number): string[] {
  const { body, ext } = splitExt(name);
  const out: string[] = [];
  for (let n = fromN; n < fromN + count; n++) out.push(fit(body, ` (${n})`, ext));
  return out;
}

/**
 * 空いている名前を選ぶ。`fromN = 2` のときは、`name` の key が空いていればそのまま返す。
 * 空いていなければ、`assetNameCandidates(name, fromN, 50)` のうち key が `takenKeys` に無い最小のもの。
 * 渡した候補がすべて埋まっていれば `null`(呼び出し側が `fromN` を 50 進めて引き直す)。
 * `takenKeys` は、control が候補の key を `json_each` で照会して得た「使われている key」
 */
export function pickFreeAssetName(name: string, takenKeys: ReadonlySet<string>, fromN = 2): string | null {
  if (fromN === 2 && !takenKeys.has(assetNameKey(name))) return name;
  for (const c of assetNameCandidates(name, fromN, ASSET_NAME_CANDIDATES_PER_QUERY)) {
    if (!takenKeys.has(assetNameKey(c))) return c;
  }
  return null;
}
