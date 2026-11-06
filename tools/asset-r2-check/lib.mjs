// lib.mjs — D1 の画像の行と R2 の一覧を比べる部分と、D1 に流す SQL を作る部分(子のプロセスも API も直接は呼ばない)。
// 入口は check.mjs。ここの関数は、外とのやり取り(D1・R2・時刻・出力)を引数で受けるので、手元の偽の値で試せる

/** 画像の ID の形(control が付ける ID と同じ)。SQL に値を埋め込む前に、この形だけを受ける */
export const ASSET_ID_RE = /^asset_[a-z0-9]{10}$/;
/** サイトの ID の形(packages/core の SITE_ID_RE と同じ) */
export const SITE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 書き込みの凍結の行のキー(行があれば凍結中。値の中身は見ない) */
export const WRITE_FREEZE_KEY = "writeFreeze";
/** R2 の一覧を絞る接頭辞(画像・縮小版のキーはすべて sites/<サイトの ID>/ の下) */
export const R2_PREFIX = "sites/";
/**
 * 1 文に入れる画像の数の上限。wrangler の --command はコマンドの引数で SQL を渡すので、引数の長さの上限に掛からないよう
 * 500 枚(約 25 KB)ずつに分ける。ふつうは 1 文で済む
 */
export const TARGETS_PER_STATEMENT = 500;

/**
 * 比べる対象の行。印の付いた行(消す途中・R2 を消し損ねた墓標)は定期処理が扱うので読まない。
 * 1 行は 100 B ほど(ID・サイトの ID・R2 のキー・時刻)で、サイトあたり上限 1,000 枚なので、1 サイトで 100 KB ほど
 */
export const ASSETS_SQL = "SELECT id, site_id, r2_key, deleted_at FROM assets WHERE purge_marked_at IS NULL";
/**
 * 比べる対象の行を読んだときに、D1 がまだ画像のライブラリの列(deleted_at・purge_marked_at)を持たないことを示すエラー。
 * 画像のライブラリより前の時点に D1 を戻し、マイグレーションを当てずに流したときに出る
 */
export const OLD_SCHEMA_RE = /no such (?:column: (?:\w+\.)?(?:deleted_at|purge_marked_at)|table: assets)\b/;
/** 上のときに出す文(公開する道具の文言なので、開発の記録の番号などは書かない) */
export const OLD_SCHEMA_MESSAGE =
  "D1 の assets に、画像の削除の印の列(deleted_at・purge_marked_at)がありません。画像のライブラリより前の時点に戻した D1 です。deploy.md のバックアップ・復旧の節のとおり、凍結の中で未適用のマイグレーションを当ててから(wrangler d1 migrations apply)、もう一度流してください";

/**
 * 手元の R2(wrangler r2 object get --local)の結果から、キーの有無を決める。終了コード 0 = 在る。
 * 0 以外は、wrangler の出力に「The specified key does not exist.」(R2 の NoSuchKey の文。wrangler 4 の --local で確かめた)があるときだけ「無い」。
 * それ以外(手元の保存先を読めない・wrangler が起動しない など)は「無い」と見なさずに止める(在る画像に印を付けないため)
 */
export const LOCAL_KEY_MISSING_RE = /The specified key does not exist/;
export function localObjectResult({ status, stdout, stderr }) {
  if (status === 0) return true;
  if (LOCAL_KEY_MISSING_RE.test(`${stderr ?? ""}\n${stdout ?? ""}`)) return false;
  throw new Error(`手元の R2 のオブジェクトの有無を確かめられませんでした(wrangler の終了コード ${status})。印は付けていません`);
}

/** 書き込みの凍結が入っているか(行の数が 1 なら凍結中) */
export const FREEZE_SQL = `SELECT count(*) AS n FROM instance_settings WHERE key = '${WRITE_FREEZE_KEY}'`;

/** wrangler.jsonc の本文から R2 のバケットの名前を読む。行ごと注釈(//)にした binding は無いものとする。無ければ null */
export function readBucketName(text) {
  const live = text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const m = live.match(/"r2_buckets"\s*:\s*\[\s*\{[^}]*?"bucket_name"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * wrangler.jsonc の本文から、先頭の D1 の binding の database_name を読む(control が使う D1。控えから読み戻した導入では読み戻し先の名前)。
 * 行ごと注釈(//)にしたものは無いものとする。無ければ null
 */
export function readDatabaseName(text) {
  const live = text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const m = live.match(/"d1_databases"\s*:\s*\[\s*\{[^}]*?"database_name"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** 印の付いていない行のうち、R2 のキーが一覧(Set)に無いものを返す。縮小版のキーは見ない(元の画像があれば足りる) */
export function findMissingObjects(rows, keys) {
  return rows.filter((r) => r.purge_marked_at == null && !keys.has(r.r2_key));
}

/** SQL に埋め込む値を確かめる。形が違えば何も作らずに止める(wrangler の --command は値を別に渡せないため) */
function checkTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("対象の画像がありません");
  for (const t of targets) {
    if (typeof t.id !== "string" || !ASSET_ID_RE.test(t.id)) throw new Error(`画像の ID の形が想定と違います: ${JSON.stringify(String(t.id))}`);
    if (typeof t.site_id !== "string" || !SITE_ID_RE.test(t.site_id)) throw new Error(`サイトの ID の形が想定と違います: ${JSON.stringify(String(t.site_id))}`);
  }
}

const valuesList = (targets) => targets.map((t) => `('${t.site_id}', '${t.id}')`).join(", ");

/**
 * 見つかった画像を、訪問者に配っている版(サイトの active_version の版で、KV から消していないもの)の設定が指しているかを 1 回で読む。
 * config_json は大きい(1 版で数百 KB になりうる)ので、D1 の側で instr で絞り、(画像の ID, サイトの ID) の組だけを返す。
 * 出力は見つかった画像 1 枚につき最大 1 行(同じサイトの設定だけを見る。別のサイトの画像の URL は公開で断られるため)
 */
export function activeRefsSql(targets) {
  checkTargets(targets);
  return [
    `WITH m(site_id, asset_id) AS (VALUES ${valuesList(targets)})`,
    "SELECT DISTINCT m.asset_id AS asset_id, p.site_id AS site_id FROM m",
    "JOIN publishes p ON p.site_id = m.site_id",
    "JOIN sites s ON s.id = p.site_id AND s.active_version = p.version",
    "WHERE p.kv_deleted = 0 AND p.config_json IS NOT NULL AND instr(p.config_json, m.asset_id) > 0",
  ].join(" ");
}

/**
 * 見つかった画像に印を付ける 1 文。削除待ちの時刻は既にあれば残し、消す途中の印を付ける。
 * 印の後は、公開がその画像を指す設定を断り、定期処理が行を消す(R2 の削除は無いキーでも成功する)。
 * 書き込みの凍結が外れていれば 1 行も書かない(凍結の中で流す前提を、文の条件でも守る)
 */
export function markSql(targets, now) {
  checkTargets(targets);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error(`時刻の値が想定と違います: ${now}`);
  return [
    `UPDATE assets SET deleted_at = coalesce(deleted_at, ${now}), purge_marked_at = ${now}, updated_at = ${now}`,
    `WHERE (site_id, id) IN (VALUES ${valuesList(targets)}) AND purge_marked_at IS NULL`,
    `AND EXISTS (SELECT 1 FROM instance_settings WHERE key = '${WRITE_FREEZE_KEY}')`,
    // 印を付けた行の ID を返す(wrangler の --local の出力には変わった行の数が入らないため、返った行の数で数える)
    "RETURNING id",
  ].join(" ");
}

/**
 * Cloudflare API で R2 のオブジェクトの一覧(キー)を最後のページまで読み、{ keys, pages } を返す。トークンは要求のヘッダーにだけ使い、
 * エラーの文言には API の状態と文言だけを出す(文言にトークンが含まれていれば伏せる)。
 * 続きを読むかは「続きのしるし(cursor)があるか」だけで決め、is_truncated は見ない(省かれた・食い違った応答で途中で止まると、
 * 残りのページの画像を「中身が無い」と取り違えるため。余分に読む向きの誤りは害が無い)。同じしるしが繰り返されたら止める
 */
export async function listR2Keys({ fetch, accountId, bucket, token, prefix = R2_PREFIX, perPage = 1000 }) {
  const keys = new Set();
  const seen = new Set();
  let cursor = "";
  let pages = 0;
  const hide = (s) => String(s).split(token).join("***");
  for (;;) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects`);
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("per_page", String(perPage));
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`R2 の一覧を読めませんでした(HTTP ${res.status}。応答が JSON ではありません)`);
    }
    if (!res.ok || body?.success === false || !Array.isArray(body?.result)) {
      const messages = (body?.errors ?? []).map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join(" / ");
      throw new Error(hide(`R2 の一覧を読めませんでした(HTTP ${res.status}${messages ? `: ${messages}` : ""})`));
    }
    pages++;
    for (const o of body.result) if (typeof o?.key === "string") keys.add(o.key);
    const info = body.result_info ?? {};
    const next = typeof info.cursor === "string" ? info.cursor : "";
    if (!next) return { keys, pages };
    if (seen.has(next)) throw new Error("R2 の一覧の続きのしるしが繰り返されたため、読むのを止めました");
    seen.add(next);
    cursor = next;
  }
}

/**
 * Cloudflare API で R2 のオブジェクト 1 つの有無を確かめる(一覧に無かった画像を、印を付ける前に確かめ直す)。
 * 200 = 在る / 404 = 無い。それ以外は「無い」と見なさずに止める(在る画像に印を付けないため)
 */
export async function r2ObjectExists({ fetch, accountId, bucket, token, key }) {
  const path = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return false;
  if (res.ok) {
    await res.body?.cancel?.(); // 中身は読まない
    return true;
  }
  throw new Error(`R2 のオブジェクトの有無を確かめられませんでした(HTTP ${res.status})`);
}

/** 見つかった画像ごとの 1 行(サイトの ID・画像の ID・削除待ちか・配信中の設定で使っているサイト)。名前・URL・R2 のキーは出さない */
export function formatFinding(r, refSites) {
  const using = refSites.length ? refSites.join(", ") : "なし";
  return `- サイト ${r.site_id} / 画像 ${r.id} / 削除待ち: ${r.deleted_at != null ? "はい" : "いいえ"} / 配信中の設定で使っているサイト: ${using}`;
}

/**
 * 道具の流れ。deps:
 * - bucket: R2 のバケットの名前(R2 を使っていなければ null)
 * - preflight(): R2 を読む前の確かめ(トークンの有無など。足りなければ例外)
 * - d1(sql): SQL を流して返った行の配列を返す(印の文も RETURNING の行を返すので、これで流す)
 * - listKeys(rows): R2 にあるキーを { keys: Set, pages: 読んだページの数(1 つずつ確かめる形では null) } で返す(rows は確かめる対象の行)
 * - objectExists(key): 一覧に無かったキーを 1 つ確かめ直す(在れば true)
 * - now() / log(s) / error(s)
 * 戻り値は終了コード(0 = 終わった / 1 = 止めた)
 */
export async function run({ apply, db }, deps) {
  const { log, error } = deps;
  if (!deps.bucket) {
    log("R2 を使っていない導入です。確かめることはありません");
    return 0;
  }
  try {
    deps.preflight();
    // 印を付けるときは、先に凍結を確かめる(読む前に止められるように)。見るだけは凍結が無くても動く
    if (apply && !(await isFrozen(deps))) return refuseWithoutFreeze(error);

    const rows = await deps.d1(ASSETS_SQL).catch((e) => {
      // 画像のライブラリより前の時点に戻した D1(列が無い)は、マイグレーションを当ててから流すよう伝えて止める
      if (OLD_SCHEMA_RE.test(e instanceof Error ? e.message : String(e))) throw new Error(OLD_SCHEMA_MESSAGE);
      throw e;
    });
    const { keys, pages } = await deps.listKeys(rows);
    log(`確かめた画像: ${rows.length} 枚(${db ? `D1 ${db}・` : ""}バケット ${deps.bucket})`);
    // 一覧を全部読めたかを人が照らせるように、読んだキーの数とページの数を出す
    log(`R2 から読んだキー: ${keys.size} 件${pages != null ? `(${pages} ページ)` : ""}`);
    // 一覧に無かった画像を 1 枚ずつ確かめ直し、在ったものは対象から外す(一覧の読み損ねで在る画像に印を付けないため。ふつうは数件)
    const missing = [];
    let foundOnRecheck = 0;
    for (const r of findMissingObjects(rows, keys)) {
      if (await deps.objectExists(r.r2_key)) foundOnRecheck++;
      else missing.push(r);
    }
    if (foundOnRecheck > 0) log(`一覧に無かったが、確かめ直すと在った画像: ${foundOnRecheck} 件(対象から外しました)`);
    if (missing.length === 0) {
      log("R2 に中身の無い画像: 0 件");
      return 0;
    }
    const targets = missing.map((r) => ({ id: r.id, site_id: r.site_id }));
    const chunks = [];
    for (let i = 0; i < targets.length; i += TARGETS_PER_STATEMENT) chunks.push(targets.slice(i, i + TARGETS_PER_STATEMENT));
    const refs = [];
    for (const c of chunks) refs.push(...(await deps.d1(activeRefsSql(c))));
    const refSites = (r) => [...new Set(refs.filter((x) => x.asset_id === r.id).map((x) => x.site_id))].sort();

    log(`R2 に中身の無い画像: ${missing.length} 件`);
    for (const r of missing) log(formatFinding(r, refSites(r)));
    const usingSites = [...new Set(refs.map((x) => x.site_id))].sort();
    if (usingSites.length) {
      log(`配信中の設定でこれらの画像を使っているサイト: ${usingSites.join(", ")}`);
      log("このサイトでは、印を付けた後(凍結を外した後)に、その画像を使う変更の画像を選び直して(か変更から外して)公開し直してください。直し終えるまで、このサイトの設定を保存しないでください");
    }
    if (!apply) {
      log("見るだけで終わりました(D1 には書いていません)。印を付けるには、書き込みの凍結の中で --apply を付けて流してください");
      return 0;
    }
    // 凍結は最初に確かめてある。その後に外された場合は、印の文の条件で 1 行も書かない
    const now = deps.now();
    let changes = 0;
    for (const c of chunks) changes += (await deps.d1(markSql(c, now))).length;
    log(`印を付けた画像: ${changes} 件(対象 ${missing.length} 件)`);
    if (changes !== missing.length) {
      error("対象と印の数が違います。凍結が外れていないか、ほかの作業が同時に動いていないかを確かめてから、もう一度流してください");
      return 1;
    }
    return 0;
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function isFrozen(deps) {
  const [r] = await deps.d1(FREEZE_SQL);
  return Number(r?.n ?? 0) > 0;
}

function refuseWithoutFreeze(error) {
  error("書き込みの凍結が入っていません。deploy.md のバックアップ・復旧の節のとおり、凍結を入れてから流してください");
  return 1;
}
