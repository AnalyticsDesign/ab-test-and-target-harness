// Cloudflare API の呼び出し。fetch・sleep・今の時刻を引数で受ける(テストでは偽物に差し替える)。
// 応答は { ok, status, result?, errors: { code, message }[] } にそろえる。
// トークンの値は Authorization の見出しにだけ入れる。errors の文と例外の文には値を入れない(届いた文に値が入っていれば伏せる)。
// 応答の result にある creator_email_at_creation・token_suffix は呼び出し元に返すが、文には入れない。
import { isDeleteAllow, allowIncludes } from "./record.mjs";

const API_ROOT = "https://api.cloudflare.com/client/v4";

/** 429 の retry-after をこの秒数まで待つ。超えたら待たずに失敗を返す */
export const RETRY_AFTER_CAP_SECONDS = 60;

/** トークンの一覧の 1 ページの件数と、読むページの上限 */
const LIST_PER_PAGE = 50;
const MAX_PAGES = 20;

/** 呼び出し元が比べる code。Cloudflare の code は数、ここで作る code は 429 のほかは文字列 */
export const CODE = Object.freeze({
  rateLimited: 429,
  network: "network",
  nonJson: "non_json",
  badShape: "bad_shape",
  invalidToken: 1000,
  tokenNotFound: 1003,
});

const ID_RE = /^[A-Za-z0-9]+$/;
const PHASE_RE = /^[a-z0-9_]+$/;
const MASK = "[値を伏せた]";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, accountId: string, now?: () => Date }} opts
 */
export function createCf({ fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep, accountId, now = () => new Date() } = {}) {
  if (typeof accountId !== "string" || !ID_RE.test(accountId)) throw new Error("アカウントの ID が空か、形が違う");
  if (typeof fetchImpl !== "function") throw new Error("fetch を関数で渡す");
  const aid = accountId;

  /** verify が active だった結果を値ごとに持つ(同じ実行の中だけ)。DELETE した ID の分は捨てる */
  const activeCache = new Map();

  // ---- 1 回の呼び出し ----

  /**
   * @param {string} method
   * @param {string} path API の根からの path
   * @param {{ token: string, query?: Record<string, string|number>, body?: unknown, graphql?: boolean }} o
   */
  async function call(method, path, { token, query, body, graphql = false }) {
    checkToken(token);
    const url = new URL(`${API_ROOT}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    // 再試行は 429 のときだけ 1 回。通信の失敗は打ち直さない(POST が届いていれば、打ち直すと 2 本できる)
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url.toString(), init);
      } catch (e) {
        return failure(null, CODE.network, `通信に失敗した(${errorKind(e)})`, token);
      }
      if (res.status === 429) {
        const secs = retryAfterSeconds(res.headers?.get?.("retry-after"), now);
        if (attempt >= 1) return rateLimited(secs, true, token);
        if (secs === null || secs > RETRY_AFTER_CAP_SECONDS) return rateLimited(secs, false, token);
        await sleep(secs * 1000);
        continue;
      }
      return parse(res, graphql, token);
    }
  }

  // ---- 公開のメソッド ----

  /**
   * トークンの確かめ。state: active(使える)/ not_yet_valid(開始が今より後)/ gone(1000・expired・disabled)/ unknown(それ以外)。
   * active の結果だけを値ごとに使い回す
   */
  async function verify(token) {
    checkToken(token);
    const hit = activeCache.get(token);
    if (hit) {
      // 使い回した後に期限を過ぎていれば、送り直す
      const exp = hit.expires_on ? Date.parse(hit.expires_on) : NaN;
      if (Number.isNaN(exp) || exp > now().getTime()) return copy(hit);
      activeCache.delete(token);
    }
    const r = await call("GET", `/accounts/${aid}/tokens/verify`, { token });
    const res = r.result && typeof r.result === "object" ? r.result : {};
    const out = {
      ...r,
      state: verifyState(r, res, now),
      id: typeof res.id === "string" ? res.id : null,
      not_before: typeof res.not_before === "string" ? res.not_before : null,
      expires_on: typeof res.expires_on === "string" ? res.expires_on : null,
    };
    // status は HTTP の状態コード。トークンの状態(active・expired など)は tokenStatus に入れる
    out.tokenStatus = typeof res.status === "string" ? res.status : null;
    if (out.state === "active") activeCache.set(token, copy(out));
    return out;
  }

  /** トークンの詳細(親の確かめに使う) */
  async function tokenDetails(token, id) {
    checkId(id, "トークンの ID");
    return call("GET", `/accounts/${aid}/tokens/${id}`, { token });
  }

  /**
   * 権限の一覧。result_info が無ければ 1 回で全部。result_info.total_pages があればそのページまで読む。
   * 途中のページの失敗・上限に届いた → { ok: false, incomplete: true }
   */
  async function permissionGroups(token) {
    const path = `/accounts/${aid}/tokens/permission_groups`;
    const first = await call("GET", path, { token });
    if (!first.ok) return first;
    if (!Array.isArray(first.result)) return incomplete(first, CODE.badShape, "権限の一覧の形が違う(配列でない)", token);
    const all = [...first.result];
    const info = first.result_info;
    if (!info || typeof info !== "object") return done(first, all);
    const perPage = positiveInt(info.per_page);
    const totalPages = positiveInt(info.total_pages);
    const totalCount = nonNegativeInt(info.total_count);
    const more = (page) => {
      if (totalPages !== null) return page <= totalPages;
      return totalCount !== null && all.length < totalCount;
    };
    let page = 2;
    for (; more(page); page++) {
      if (page > MAX_PAGES) return incomplete(first, CODE.badShape, `権限の一覧が ${MAX_PAGES} ページを超えた`, token);
      const q = perPage === null ? { page } : { page, per_page: perPage };
      const r = await call("GET", path, { token, query: q });
      if (!r.ok) return incomplete(r, null, null, token);
      if (!Array.isArray(r.result)) return incomplete(r, CODE.badShape, "権限の一覧の形が違う(配列でない)", token);
      if (r.result.length === 0) break;
      all.push(...r.result);
    }
    return done(first, all);
  }

  /**
   * トークンの一覧を終わりまで読む。total_pages は前提にしない。
   * 終わり = 返った件数が 1 ページの件数より少ない、または total_count に届いた。
   * 途中のページの失敗・上限に届いた・result_info が無く件数が 1 ページの件数ちょうど → { ok: false, incomplete: true }
   */
  async function listTokens(token) {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await call("GET", `/accounts/${aid}/tokens`, { token, query: { page, per_page: LIST_PER_PAGE } });
      if (!r.ok) return incomplete(r, null, null, token);
      if (!Array.isArray(r.result)) return incomplete(r, CODE.badShape, "トークンの一覧の形が違う(配列でない)", token);
      all.push(...r.result);
      const info = r.result_info && typeof r.result_info === "object" ? r.result_info : null;
      const perPage = (info && positiveInt(info.per_page)) ?? LIST_PER_PAGE;
      if (r.result.length < perPage) return done(r, all);
      const totalCount = info ? nonNegativeInt(info.total_count) : null;
      if (totalCount !== null && all.length >= totalCount) return done(r, all);
      if (!info) {
        return incomplete(r, CODE.badShape, "トークンの一覧に件数の情報(result_info)が無く、続きがあるかを決められない", token);
      }
    }
    return { ok: false, incomplete: true, errors: [{ code: CODE.badShape, message: `トークンの一覧が ${MAX_PAGES} ページで終わらなかった` }] };
  }

  /** トークンを作る。応答の result に値(value)が入る。呼び出し元は値を出力に出さない */
  async function createToken(token, body) {
    if (!body || typeof body !== "object") throw new Error("作成の本文を渡す");
    return call("POST", `/accounts/${aid}/tokens`, { token, body });
  }

  /**
   * トークンを消す。allow は DELETE を許す ID の集合(記録の側の関数が作った値)で、id を含まなければ送らずに例外。
   * 戻り値の gone: true は「もう無い」(404 かつ 1003)。そのとき ok は false だが、呼び出し元は消えた扱いにできる
   */
  async function deleteToken(token, id, allow) {
    if (!isDeleteAllow(allow)) throw new Error("DELETE を許す集合ではない値が渡された。送らずに止める");
    if (!allowIncludes(allow, id)) throw new Error(`ID ${String(id)} は DELETE を許す集合に無い。送らずに止める`);
    checkId(id, "トークンの ID");
    // 応答が届かなくても消えている場合があるので、送る前に捨てる
    for (const [value, v] of activeCache) if (v.id === id) activeCache.delete(value);
    const r = await call("DELETE", `/accounts/${aid}/tokens/${id}`, { token });
    const gone = r.status === 404 && r.errors.some((e) => e.code === CODE.tokenNotFound);
    return { ...r, gone };
  }

  /** 名前でゾーンを引く(OAuth の値で)。zones に id・name・status・accountId を並べて返す */
  async function zonesByName(oauthToken, name) {
    if (typeof name !== "string" || name === "") throw new Error("ゾーンの名前が空");
    const r = await call("GET", "/zones", { token: oauthToken, query: { name } });
    if (!r.ok) return r;
    if (!Array.isArray(r.result)) return { ...r, ok: false, errors: [{ code: CODE.badShape, message: "ゾーンの一覧の形が違う(配列でない)" }] };
    const zones = r.result.map((z) => ({
      id: z?.id ?? null,
      name: z?.name ?? null,
      status: z?.status ?? null,
      accountId: z?.account?.id ?? null,
    }));
    return { ...r, zones };
  }

  /** ゾーンの phase の entrypoint の ruleset を読む(ルールの無いゾーンは 10003 が返る) */
  async function rulesetEntrypoint(token, zoneId, phase) {
    checkId(zoneId, "ゾーンの ID");
    if (typeof phase !== "string" || !PHASE_RE.test(phase)) throw new Error(`phase の形が違う(今: ${String(phase)})`);
    return call("GET", `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, { token });
  }

  /** Workers のスクリプトの一覧 */
  async function workerScripts(token) {
    return call("GET", `/accounts/${aid}/workers/scripts`, { token });
  }

  /**
   * GraphQL の最小の照会(今日の 1 日の Workers の呼び出しを 1 件)。HTTP 200 でも errors があれば ok: false。
   * 成功しても使用状況を読む権限があるとは限らない(権限の無いトークンでも、データの無いアカウントでは通る)
   */
  async function analyticsProbe(token) {
    const day = now().toISOString().slice(0, 10);
    const query = `{ viewer { accounts(filter: { accountTag: "${aid}" }) { x: workersInvocationsAdaptive(limit: 1, filter: { date_geq: "${day}", date_leq: "${day}" }) { sum { requests } } } } }`;
    return call("POST", "/graphql", { token, body: { query }, graphql: true });
  }

  return { verify, tokenDetails, permissionGroups, listTokens, createToken, deleteToken, zonesByName, rulesetEntrypoint, workerScripts, analyticsProbe };
}

// ---- 応答の読み ----

/** verify の応答から state を決める */
function verifyState(r, res, now) {
  if (r.errors.some((e) => e.code === CODE.invalidToken)) return "gone";
  if (!r.ok) return "unknown";
  if (res.status === "expired" || res.status === "disabled") return "gone";
  if (res.status !== "active") return "unknown";
  if (res.not_before === undefined || res.not_before === null) return "active";
  const start = typeof res.not_before === "string" ? Date.parse(res.not_before) : NaN;
  if (Number.isNaN(start)) return "unknown";
  return start > now().getTime() ? "not_yet_valid" : "active";
}

/** 応答を読む。JSON でなければ non_json。本文は文に入れない */
async function parse(res, graphql, token) {
  const status = res.status;
  let text;
  try {
    text = await res.text();
  } catch (e) {
    return failure(status, CODE.network, `応答の本文を読めなかった(${errorKind(e)})`, token);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return failure(status, CODE.nonJson, `JSON でない応答(HTTP ${status})`, token);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return failure(status, CODE.nonJson, `JSON のオブジェクトでない応答(HTTP ${status})`, token);

  const httpOk = status >= 200 && status < 300;
  if (graphql) {
    const errors = normalizeErrors(body.errors, token, "graphql");
    const out = { ok: httpOk && errors.length === 0, status, result: body.data, errors };
    if (!out.ok && errors.length === 0) out.errors = [{ code: `http_${status}`, message: `HTTP ${status}` }];
    return out;
  }
  const errors = normalizeErrors(body.errors, token, null);
  const out = { ok: httpOk && body.success === true, status, result: body.result, errors };
  if (body.result_info !== undefined) out.result_info = body.result_info;
  if (!out.ok && errors.length === 0) out.errors = [{ code: `http_${status}`, message: `HTTP ${status}` }];
  return out;
}

/** errors を { code, message }[] にそろえ、値が入っていれば伏せる */
function normalizeErrors(list, token, defaultCode) {
  if (!Array.isArray(list)) return [];
  return list.map((e) => {
    const code = e && (typeof e.code === "number" || typeof e.code === "string")
      ? e.code
      : (e?.extensions && typeof e.extensions.code === "string" ? e.extensions.code : defaultCode);
    const message = mask(typeof e?.message === "string" ? e.message : "", token);
    return { code, message };
  });
}

function failure(status, code, message, token) {
  return { ok: false, status, errors: [{ code, message: mask(message, token) }] };
}

function rateLimited(secs, repeated, token) {
  const when = secs === null ? "しばらく待ってから打ち直す" : `${secs} 秒後に打ち直す`;
  const why = repeated
    ? "要求が多すぎる(429)。1 回待って送り直したが、また 429 だった"
    : secs === null
      ? "要求が多すぎる(429)。待つ秒数(retry-after)が無いので、待たずに止める"
      : `要求が多すぎる(429)。待つ秒数が ${RETRY_AFTER_CAP_SECONDS} 秒を超えたので、待たずに止める`;
  return failure(429, CODE.rateLimited, `${why}。${when}`, token);
}

/** retry-after(秒か HTTP の日時)を秒にする。読めなければ null */
function retryAfterSeconds(v, now) {
  if (typeof v !== "string" || v.trim() === "") return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const at = Date.parse(s);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now().getTime()) / 1000));
}

function incomplete(r, code, message, token) {
  const errors = code === null ? r.errors : [{ code, message: mask(message, token) }];
  return { ok: false, incomplete: true, status: r.status, errors };
}

function done(r, all) {
  return { ok: true, status: r.status, result: all, errors: [] };
}

// ---- 入力の確かめ・文の後始末 ----

function checkToken(token) {
  if (typeof token !== "string" || token === "") throw new Error("トークンの値が空(呼び出し元の誤り)");
  // 見出しに入れられない文字(改行など)。値そのものは文に入れない
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("トークンの値に使えない文字(空白・改行など)が入っている");
}

function checkId(id, label) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`${label}が空か、形が違う(英数字だけ)`);
}

/** 文の中の値を伏せる */
function mask(text, token) {
  const s = String(text);
  return typeof token === "string" && token !== "" ? s.split(token).join(MASK) : s;
}

/** 通信の例外の種類だけを文にする(例外の文そのものは入れない) */
function errorKind(e) {
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  const name = e?.name;
  return typeof name === "string" && /^[A-Za-z]+$/.test(name) ? name : "例外";
}

const positiveInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const nonNegativeInt = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const copy = (v) => JSON.parse(JSON.stringify(v));
