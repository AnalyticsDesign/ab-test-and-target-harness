// 作るトークンの表(名前・権限の名前・対象・期限)と、答えから要るゾーンのホストを導く関数、POST の本文、親トークンの詳細の照合。
// 純粋な関数だけ。Cloudflare の API は呼ばない・ファイルも読まない・トークンの値も扱わない
import { isBlank, hostProblem } from "../../deploy-answers/questions.mjs";

/** @typedef {"setup"|"deploy"|"usage"} Role */

/** 親から作る子の役割(作る順) */
export const ROLES = Object.freeze(["setup", "deploy", "usage"]);

/** deploy-secrets.env の行の名前(親は人が作って渡す) */
export const ENV_KEY = Object.freeze({ parent: "CF_BOOTSTRAP_TOKEN", setup: "CF_TOKEN", deploy: "CF_DEPLOY_TOKEN", usage: "CF_USAGE_TOKEN" });

/** 名前に使う役割の語。親だけ bootstrap */
const NAME_WORD = Object.freeze({ parent: "bootstrap", setup: "setup", deploy: "deploy", usage: "usage" });

/** 親の期限の上限。翌日の 23:59 を当日の朝に作っても収まる 2 日 */
export const PARENT_MAX_LIFETIME_MS = 48 * 60 * 60 * 1000;

/** 作業用トークンの寿命(作成から 24 時間) */
const SETUP_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** 対象の種類(権限の組の 2 つ目)。アカウント全体か、ゾーン単位か */
const ACCOUNT = "com.cloudflare.api.account";
const ZONE = "com.cloudflare.api.account.zone";

/**
 * 役割ごとの権限の名前と対象の種類の組(名前は API の権限グループの名前。画面の Edit は API では Write)。
 * 親は人が作るので、確かめる側(checkParentDetails)だけが使う
 */
export const PERMISSIONS = Object.freeze({
  parent: Object.freeze([Object.freeze(["Account API Tokens Write", ACCOUNT])]),
  setup: Object.freeze([
    Object.freeze(["Zone Read", ZONE]),
    Object.freeze(["DNS Read", ZONE]),
    Object.freeze(["Cache Settings Write", ZONE]),
    Object.freeze(["Zone WAF Write", ZONE]),
  ]),
  deploy: Object.freeze([Object.freeze(["Workers Scripts Write", ACCOUNT])]),
  usage: Object.freeze([Object.freeze(["Account Analytics Read", ACCOUNT])]),
});

const IDENT_RE = /^[a-z0-9-]{1,63}$/;
const ID_RE = /^[A-Za-z0-9]+$/;

// ---- 名前 ----

/** トークンの名前 wtt-<bootstrap|setup|deploy|usage>-<識別子>。識別子は小文字・数字・ハイフンの 1〜63 文字 */
export function tokenName(role, ident) {
  if (!Object.hasOwn(NAME_WORD, role)) throw new Error(`役割が違う: ${String(role)}(parent / setup / deploy / usage のどれか)`);
  if (typeof ident !== "string" || !IDENT_RE.test(ident)) {
    throw new Error("識別子は小文字・数字・ハイフンだけの 1〜63 文字で書く(ドットや大文字は使えない)");
  }
  return `wtt-${NAME_WORD[role]}-${ident}`;
}

// ---- 要るゾーン ----

/** 答えの host の値(control_host など)を検査して返す。custom のときだけ呼ぶ */
function customHost(values, addrKey, hostKey) {
  const host = values[hostKey];
  if (isBlank(host)) throw new Error(`${addrKey}: custom なのに ${hostKey} が書かれていない。ゾーンを決められない`);
  const problem = hostProblem(host);
  if (problem) throw new Error(`${hostKey} の形が違う(${problem})`);
  return host;
}

/** control・admin のアドレス(workers-dev か custom。行が無ければ workers-dev) */
function addressOf(values, key) {
  const v = values[key];
  if (isBlank(v) || v === "workers-dev") return "workers-dev";
  if (v === "custom") return "custom";
  throw new Error(`${key} は workers-dev か custom で書く(今: ${String(v)})`);
}

/**
 * 作業用トークンに入れるゾーンを引く元のホスト(重複なし)。
 * edge_address が route か custom-domain なら zone_name(ゾーンの名前そのもの)、control_address / admin_address が custom なら
 * control_host / admin_host(どのゾーンに属すかは API で引く)。空なら作業用トークンは要らない
 * @param {Record<string, unknown>} values parseAnswers が読んだ答え
 * @returns {string[]}
 */
export function zoneHostsOf(values) {
  const edge = values.edge_address;
  if (isBlank(edge)) {
    throw new Error("構成が決まっていない(edge_address の行が空)。deploy-answers を --accept 付きで打って構成を確定してから、もう一度打つ");
  }
  if (edge !== "route" && edge !== "custom-domain" && edge !== "workers-dev") {
    throw new Error(`edge_address は route / custom-domain / workers-dev のどれかで書く(今: ${String(edge)})`);
  }
  const hosts = [];
  if (edge !== "workers-dev") {
    const zone = values.zone_name;
    if (isBlank(zone)) throw new Error(`edge_address: ${edge} なのに zone_name が決まっていない。deploy-answers を --accept 付きで打ち直す`);
    if (zone === "auto") throw new Error("zone_name がまだ auto。deploy-answers を --resolve-zone <ゾーン名> 付きで打ってゾーンを決めてから、もう一度打つ");
    const problem = hostProblem(zone);
    if (problem) throw new Error(`zone_name の形が違う(${problem})`);
    hosts.push(zone);
  }
  if (addressOf(values, "control_address") === "custom") hosts.push(customHost(values, "control_address", "control_host"));
  if (addressOf(values, "admin_address") === "custom") hosts.push(customHost(values, "admin_address", "admin_host"));
  return [...new Set(hosts)];
}

/**
 * ホストが属すゾーンの名前の候補を、ホスト自身から長い順に返す(最後の 1 ラベルだけの名前は含めない)。
 * 呼ぶ側(flow.mjs)は長い順に引き、名前の合うゾーンが最初に見えた候補(最も長い名前)で止まる。そのゾーンが
 * 導入先のアカウントの有効(active)なゾーンなら採り、そうでなければ(別のアカウント・active でない)短い名前に進まずに
 * 人に見てもらう(ホストが属すのは最も長いゾーンなので、短いゾーンを採ると届かないトークンになる)。
 * 既に決まった zone_name を引くときは exact: true で、名前の完全一致だけ(候補 1 つ)にする
 * @param {string} host
 * @param {{ exact?: boolean }} [opts]
 * @returns {string[]}
 */
export function zoneCandidates(host, { exact = false } = {}) {
  if (typeof host !== "string" || hostProblem(host)) throw new Error(`ホストの形ではない(今: ${String(host)})`);
  if (exact) return [host];
  const labels = host.split(".");
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

// ---- POST の本文 ----

/** now(Date・ISO 文字列・ミリ秒)を Date にする */
function toDate(v, label) {
  const d = v instanceof Date ? v : new Date(v);
  if (typeof v === "undefined" || v === null || Number.isNaN(d.getTime())) throw new Error(`${label} を日時として読めない`);
  return d;
}

/** 秒までの ISO 8601(末尾 Z) */
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** 対象の種類と ID から、resources のキーを作る。形を決めているのはここだけ */
const resourceKey = (scope, id) => `${scope}.${id}`;

/** resources の値(その対象の全部)。作る側(policyOf)と確かめる側(checkParentDetails)で同じ値を使う */
const ALL = "*";

/** POST の本文の policy 1 つ。形を決めているのはここだけ(読む側は readPolicies) */
const policyOf = (scope, ids, groupIdList) => ({
  effect: "allow",
  resources: Object.fromEntries(ids.map((id) => [resourceKey(scope, id), ALL])),
  permission_groups: groupIdList.map((id) => ({ id })),
});

/**
 * トークンを作る POST /accounts/<ID>/tokens の本文。作業用だけ expires_on(作成から 24 時間)を付ける
 * @param {Role} role
 * @param {{ ident: string, accountId: string, zoneIds: string[], groupIds: Record<string, string>, now: Date|string|number }} p
 *   groupIds: 権限の名前 → 権限グループの ID(権限の一覧から引いたもの)
 */
export function createBody(role, { ident, accountId, zoneIds, groupIds, now }) {
  if (!ROLES.includes(role)) throw new Error(`役割が違う: ${String(role)}(setup / deploy / usage のどれか)`);
  const name = tokenName(role, ident);
  if (typeof accountId !== "string" || !ID_RE.test(accountId)) throw new Error("アカウントの ID が空か、形が違う");
  const at = toDate(now, "now");
  const perms = PERMISSIONS[role];
  const needsZones = perms.some(([, scope]) => scope === ZONE);
  if (needsZones && !Array.isArray(zoneIds)) throw new Error("ゾーンの ID を配列で渡す");
  const zones = [...new Set(Array.isArray(zoneIds) ? zoneIds : [])];
  if (needsZones) {
    if (zones.length === 0) throw new Error(`${role} のトークンに入れるゾーンが無い`);
    if (zones.some((z) => typeof z !== "string" || !ID_RE.test(z))) throw new Error("ゾーンの ID が空か、形が違う");
  }
  // 対象の種類ごとに 1 つのポリシー(setup はゾーンの 1 ポリシー、ほかはアカウントの 1 ポリシー)
  const policies = [];
  for (const scope of [...new Set(perms.map(([, s]) => s))]) {
    const groups = perms.filter(([, s]) => s === scope).map(([permName]) => {
      const id = groupIds?.[permName];
      if (typeof id !== "string" || id === "") throw new Error(`権限 ${permName} の ID が分からない(権限の一覧に無い)`);
      return id;
    });
    policies.push(policyOf(scope, scope === ZONE ? zones : [accountId], groups));
  }
  const body = { name, policies };
  if (role === "setup") body.expires_on = isoSeconds(at.getTime() + SETUP_LIFETIME_MS);
  return body;
}

// ---- 親トークンの詳細の照合 ----

/**
 * 親の詳細(GET /accounts/<ID>/tokens/<id> の result)から、ポリシーの許可の種類・権限の名前・対象を読む。
 * 応答の形(policies[].effect・policies[].permission_groups[].name・policies[].resources)を決めているのはここだけ。
 * 読めなかった要素は捨てずに unreadable に数える(読めない部分を「差なし」にしないため)。
 * 流れ(flow.mjs)は、作成の応答(子の result)の権限の名前をトークンの表と照らすときにも使う
 * @returns {{ effects: unknown[], permissionNames: string[], resources: [string, unknown][], unreadable: number }}
 */
export function readPolicies(details) {
  const out = { effects: [], permissionNames: [], resources: [], unreadable: 0 };
  if (!Array.isArray(details.policies)) {
    out.unreadable++;
    return out;
  }
  for (const p of details.policies) {
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      out.unreadable++;
      continue;
    }
    if (typeof p.effect === "string") out.effects.push(p.effect);
    else out.unreadable++;
    if (Array.isArray(p.permission_groups)) {
      for (const g of p.permission_groups) {
        if (g && typeof g.name === "string") out.permissionNames.push(g.name);
        else out.unreadable++;
      }
    } else {
      out.unreadable++;
    }
    if (p.resources && typeof p.resources === "object" && !Array.isArray(p.resources)) out.resources.push(...Object.entries(p.resources));
    else out.unreadable++;
  }
  return out;
}

/**
 * 親が決まりどおりかを確かめる。違う項目の文(日本語・値を含まない)の配列を返し、空なら通り。
 * 決まり: 名前 wtt-bootstrap-<識別子>・権限の名前が Account API Tokens Write だけ・対象がこのアカウントだけ・
 * 期限があり now から 48 時間以内・開始が now より後ではない
 * @param {unknown} details
 * @param {{ ident: string, accountId: string, now: Date|string|number }} ctx
 * @returns {string[]}
 */
export function checkParentDetails(details, { ident, accountId, now }) {
  if (!details || typeof details !== "object") return ["親トークンの詳細を読めない"];
  const at = toDate(now, "now").getTime();
  const out = [];

  const wantName = tokenName("parent", ident);
  if (details.name !== wantName) out.push(`名前が ${wantName} ではない(今: ${String(details.name)})`);

  const { effects, permissionNames, resources, unreadable } = readPolicies(details);
  if (unreadable > 0) out.push("親トークンの詳細の一部を読めない(権限・対象を確かめられない)");
  const wantPerms = PERMISSIONS.parent.map(([n]) => n);
  const havePerms = [...new Set(permissionNames)];
  const extra = havePerms.filter((n) => !wantPerms.includes(n));
  const missing = wantPerms.filter((n) => !havePerms.includes(n));
  if (extra.length || missing.length) {
    const parts = [];
    if (extra.length) parts.push(`余分: ${extra.join("、")}`);
    if (missing.length) parts.push(`不足: ${missing.join("、")}`);
    out.push(`権限が ${wantPerms.join("、")} だけではない(${parts.join("、")})`);
  }
  if (effects.some((e) => e !== "allow")) out.push("許可(allow)ではないポリシーがある");

  const wantResource = resourceKey(ACCOUNT, accountId);
  // ポリシーが分かれて同じ対象が重なっても 1 つと数える
  const haveResources = [...new Set(resources.map(([k, v]) => (v === ALL ? k : `${k}(値 ${JSON.stringify(v)})`)))];
  if (haveResources.length !== 1 || haveResources[0] !== wantResource) {
    out.push(`対象が ${wantResource} だけではない(今: ${haveResources.length ? haveResources.join("、") : "なし"})`);
  }

  const maxHours = PARENT_MAX_LIFETIME_MS / 3600000;
  if (isBlank(details.expires_on)) {
    out.push("期限が付いていない。親トークンは期限付きにする");
  } else {
    const exp = new Date(details.expires_on).getTime();
    if (Number.isNaN(exp)) out.push(`期限を日時として読めない(今: ${String(details.expires_on)})`);
    else if (exp > at + PARENT_MAX_LIFETIME_MS) out.push(`期限が ${maxHours} 時間より先になっている(期限: ${details.expires_on})`);
  }

  if (!isBlank(details.not_before)) {
    const start = new Date(details.not_before).getTime();
    if (Number.isNaN(start)) out.push(`開始を日時として読めない(今: ${String(details.not_before)})`);
    else if (start > at) out.push(`開始が今より先になっている(開始: ${details.not_before})。その時刻になるまで使えない`);
  }
  return out;
}
