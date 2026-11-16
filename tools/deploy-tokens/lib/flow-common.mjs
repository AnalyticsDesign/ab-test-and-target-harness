// 一本道の流れ(flow.mjs)と切り替え(flow-reset.mjs)が共に使う道具: 実行の状態・出力の形・人の出口・
// 作成の印の待ち・記録の子の削除・親の削除。
// 出力(Outcome)にトークンの値・親の値の指紋・OAuth の値・作った人のメールアドレス・値の末尾 4 文字を入れない。
import { acquireLock, readRecord, writeRecord, removeRecord, allowedDeleteIds, RECORD_VERSION } from "./record.mjs";
import { readSecrets, setSecret, clearSecret, checkSecretsForm } from "./secrets.mjs";
import { ROLES, ENV_KEY, tokenName } from "./spec.mjs";

/** ファイル操作の既定(テストでは書き込みの順を見るために差し替える) */
export const DEFAULT_FS_OPS = Object.freeze({ acquireLock, readRecord, writeRecord, removeRecord, readSecrets, checkSecretsForm, setSecret, clearSecret });

/** 人に見てもらう画面の場所(画面の言葉) */
export const LIST_PLACE = "Account API tokens(アカウント API トークン)の一覧";

export const PARENT_KEY = ENV_KEY.parent;
export const CHILD_KEYS = ROLES.map((r) => ENV_KEY[r]);

/** 親の DELETE の後に待つ時間 */
const DELETE_WAIT_MS = 5000;
/** 作成の印を解くのは、印の時刻からこの時間がたった後(遅れて成立する POST を一覧で拾うため) */
const PENDING_WAIT_MS = 60000;

/** 時間を置けば通る見込みの失敗(何も変えずに error)。これ以外の失敗は人に見てもらう */
const TRANSIENT_CODES = new Set([429, "network"]);

// ---- 小さな道具 ----

export const fsOf = (ctx) => ({ ...DEFAULT_FS_OPS, ...(ctx.fsOps ?? {}) });
export const isoNow = (ctx) => ctx.now().toISOString();
export const nonEmpty = (v) => typeof v === "string" && v !== "";

/** deploy-secrets.env の key の値(無ければ "") */
export function secretOf(ctx, key) {
  const m = fsOf(ctx).readSecrets(ctx.files.secrets);
  return (m && m.get(key)) || "";
}

/** API の失敗の errors[0] を「code: message」の文にする(cf.mjs が値を伏せた文) */
export function errText(r) {
  const e = r && Array.isArray(r.errors) ? r.errors[0] : null;
  return e ? `${e.code}: ${e.message}` : "応答なし";
}
export const errCode = (r) => (r && Array.isArray(r.errors) && r.errors[0] ? r.errors[0].code : null);
export const isTransient = (r) => TRANSIENT_CODES.has(errCode(r));

export const childRoles = (rec) => ROLES.filter((r) => rec && rec.children && rec.children[r] && nonEmpty(rec.children[r].id));

/** 記録の状態: none = 記録が無い / before = 子を確かめる前 / checked = 子を確かめた後・親を消す前 / after = 両方の時刻がある */
export function recordState(rec) {
  if (!rec) return "none";
  if (!rec.children_checked_at) return "before";
  if (!rec.parent_deleted_at) return "checked";
  return "after";
}

export function newRecord(ctx) {
  return {
    version: RECORD_VERSION,
    account_id: ctx.accountId,
    parent_id: null,
    parent_fp: null,
    pending: null,
    pending_at: null,
    children: {},
    children_checked_at: null,
    parent_deleted_at: null,
  };
}

/** 1 回の実行の状態(出力に出さない値は持たない)。deletedIds = この実行で消した(か、もう無かった)記録の子の ID */
export function newRun(ctx) {
  return { ctx, fs: fsOf(ctx), lines: [], rec: null, parentOut: null, deletedIds: new Set() };
}

/** Outcome を作る。tokens と parent は記録と確かめの結果から欄を選んで作る(API の応答を広げて入れない) */
export function finish(run, status, more = []) {
  const rec = run.rec;
  const tokens = childRoles(rec).map((role) => {
    const c = rec.children[role];
    return { role, name: String(c.name), id: String(c.id), expires_on: c.expires_on ?? null };
  });
  return { status, lines: [...run.lines, ...more], tokens, parent: run.parentOut ? { ...run.parentOut } : null };
}

export const parentLabel = (ctx, p) => `${(p && p.name) || tokenName("parent", ctx.ident)}(ID ${(p && p.id) || "不明"})`;

/** 記録の親の名前と ID(記録に親が無ければ null) */
export const recordedParentLabel = (run) => (run.rec && nonEmpty(run.rec.parent_id) ? parentLabel(run.ctx, { id: run.rec.parent_id }) : null);

/** 親が生きていることと期限の文 */
export const parentAliveLine = (ctx, p) => `親 ${parentLabel(ctx, p)} はまだ生きている(期限 ${(p && p.expires_on) || "不明"})。`;

/** 親を消したと確かめた後の Outcome.parent */
export function markParentDeleted(run, ps) {
  run.parentOut = { name: ps.name ?? tokenName("parent", run.ctx.ident), id: ps.id, state: "deleted" };
}

/** 記録の子と親の名前と ID の文 */
function recordLines(ctx, rec) {
  const out = [];
  for (const role of childRoles(rec)) out.push(`記録の子: ${rec.children[role].name}(ID ${rec.children[role].id})`);
  if (rec && rec.pending) out.push(`作成の結果が分からない子: ${tokenName(rec.pending, ctx.ident)}(印の時刻 ${rec.pending_at})`);
  if (rec && nonEmpty(rec.parent_id)) out.push(`記録の親: ${tokenName("parent", ctx.ident)}(ID ${rec.parent_id})`);
  return out;
}

/**
 * 一覧で人がトークンを見分けられないときの共通の文。一覧の列に ID は無く、見分けに使えるのは Name(名前)と Created(作成日)だけ。
 * ID はエージェントが deploy-log.md と deploy-tokens.json で照らす。`humanExit` を通る出口と、済んだ後の確かめの「消す」の文の最後に付く
 */
export const UNDISTINGUISHABLE = "一覧に同じ Name(名前)のトークンが 2 本以上あって、Created(作成日)でも見分けられないときは、消さずにエージェントに伝える。";

/** 人の出口の一般の次の一手 */
const DEFAULT_NEXT = Object.freeze([
  `${LIST_PLACE}で、上に出した Name(名前)のトークン(Created(作成日)が導入のころのもの)を確かめる。一覧の列に ID は無い。`,
  "人が一覧で上に出した Name(名前)のトークンを消した後: 親についてなら、CF_BOOTSTRAP_TOKEN を空にして --parent-deleted を付けて打つ。子についてなら、エージェントが deploy-tokens.json を消し、deploy-secrets.env の子の行を空にして、新しい親で最初から打ち直す(記録の親が一覧に残っていれば、それも消す)。",
]);

/**
 * 人の出口(1 つ)。lead に止まった理由を書き、記録の子と親の名前と ID、一覧の場所、次の一手を足す。
 * 表のマスごとの文は lead と next で渡す(決められない状態は、ここに入れる)
 */
export function humanExit(run, lead, { next } = {}) {
  const { ctx } = run;
  const lines = [...lead, ...recordLines(ctx, run.rec)];
  lines.push(...(next ?? DEFAULT_NEXT), UNDISTINGUISHABLE);
  return finish(run, "human", lines);
}

/**
 * API の失敗で止まる。時間を置けば通る見込みなら error、ほかは human。
 * tail = 止まった時点で何をしていないかの文(既定は「何も作っていない。」。created なら無し)
 */
export function apiStop(run, r, what, { created = false, tail } = {}) {
  const t = tail ?? (created ? "" : "何も作っていない。");
  if (isTransient(r)) return finish(run, "error", [`${what}(${errText(r)})。${t}少し待ってから同じコマンドを打ち直す。`]);
  return finish(run, "human", [`${what}(${errText(r)})。${t}原因を直してから同じコマンドを打ち直す。`]);
}

// ---- 同名 ----

/** 一覧のうち、子の名前で、記録に無く、今の実行で消してもいない ID のトークン */
export function unrecordedSameName(run, list) {
  const names = ROLES.map((r) => tokenName(r, run.ctx.ident));
  const recorded = new Set(childRoles(run.rec).map((r) => run.rec.children[r].id));
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && names.includes(t.name) && !recorded.has(t.id) && !run.deletedIds.has(t.id))
    .map((t) => ({ name: String(t.name), id: String(t.id) }));
}

/**
 * 記録に無い同名で止まる(人の出口)。記録が無いときは、使っている導入のトークンかもしれないことを先に書く。
 * next を渡せば、次の一手をその文にする(--reset で止まったときなど)
 */
export function sameNameExit(run, hits, { parentAlive, ps, next } = {}) {
  const { ctx } = run;
  const lead = hits.map((h) => `記録に無い同名のトークンがある: ${h.name}(ID ${h.id})。消していない。`);
  if (parentAlive) lead.push(parentAliveLine(ctx, ps));
  if (next) return humanExit(run, lead, { next });
  if (!run.rec) {
    return humanExit(run, lead, {
      next: [
        "このアカウントに導入が済んでいて、そのトークンを使っているなら、消さずに何もしない。入れ直すなら、docs/deploy.md の撤去(10.4)の後に打ち直す。",
        `使っていないと分かっていれば、${LIST_PLACE}で、Name(名前)が ${[...new Set(hits.map((h) => h.name))].join("・")} のトークン(使っていない方。Created(作成日)で見分ける)を消してから、同じコマンドを打ち直す。`,
      ],
    });
  }
  return humanExit(run, lead);
}

// ---- 作成の印・記録の子の削除 ----

/** 作成の印があれば、印の時刻から 60 秒たつまで(残りの時間だけ)待つ。時刻が読めなければ 60 秒待つ */
export async function waitPending(run) {
  const { ctx, rec } = run;
  if (!rec || !rec.pending) return;
  const at = Date.parse(rec.pending_at);
  const left = Number.isNaN(at) ? PENDING_WAIT_MS : at + PENDING_WAIT_MS - ctx.now().getTime();
  if (left > 0) await ctx.sleep(Math.min(left, PENDING_WAIT_MS));
}

/** 作成の印を外す */
export function clearPending(run) {
  const { ctx, fs, rec } = run;
  if (!rec.pending && !rec.pending_at) return;
  rec.pending = null;
  rec.pending_at = null;
  fs.writeRecord(ctx.files.record, rec);
}

/**
 * children_checked_at があれば外す。どの DELETE よりも前に呼ぶ
 * (途中で止まっても記録が「前」に戻り、打ち直しの --reset が同じ行に入るように)
 */
export function uncheck(run) {
  const { ctx, fs, rec } = run;
  if (!rec || !rec.children_checked_at) return;
  rec.children_checked_at = null;
  fs.writeRecord(ctx.files.record, rec);
}

/**
 * 記録の子を、生きた親の値で 1 本ずつ消す(ID だけで消す。同名を名前で消さない)。
 * 1 本ごとに: DELETE(「もう無い」も消えた扱い)→ その子の値の行を空にする → 記録から外す(この順。
 * 値を空にした後に止まっても、打ち直しは記録の ID に DELETE を送り直し、「もう無い」で外す)。
 * 消す値は記録にある子の行だけ。1 本でも消せなければ止まる(作らない)。
 * @param {{ rerun: string, tail?: string }} o rerun = 打ち直しのコマンドの言い方(「同じコマンドを」「--reset を付けて」など)、
 *   tail = 止まった時点で何をしていないかの文(やり直しでは「何も作っていない。」)
 * @returns {Promise<import("./flow.mjs").Outcome | null>} 止まるときは Outcome
 */
export async function deleteRecordedChildren(run, parentValue, { rerun, tail = "" }) {
  const { ctx, fs, rec } = run;
  const allow = allowedDeleteIds(rec, "restart");
  for (const role of childRoles(rec)) {
    const c = rec.children[role];
    uncheck(run);
    const r = await ctx.cf.deleteToken(parentValue, c.id, allow);
    if (!r.ok && !r.gone) {
      const lead = [`記録の子 ${c.name}(ID ${c.id})を消せなかった(${errText(r)})。${tail}`];
      const again = `${rerun}打ち直すと、記録の ID のトークンを消し直す(もう無いトークンは消えた扱いで進む)。`;
      if (isTransient(r)) return finish(run, "error", [...lead, `少し待ってから${again}`]);
      return humanExit(run, lead, {
        next: [again, `続けて消せないときは、${LIST_PLACE}で、Name(名前)が ${c.name} のトークン(Created(作成日)が導入のころのもの)を人が消してから打ち直す。`],
      });
    }
    run.deletedIds.add(c.id);
    fs.clearSecret(ctx.files.secrets, ENV_KEY[role]);
    delete rec.children[role];
    fs.writeRecord(ctx.files.record, rec);
  }
  return null;
}

// ---- 親を消す ----

/**
 * 親を消す。DELETE(応答が届かなくても進む)→ 5 秒待つ → 元の値で verify。
 * gone → finish は parent_deleted_at を書く(すでにあれば変えない)/ reset は parent_id・parent_fp を外す → CF_BOOTSTRAP_TOKEN の値を消す(この順)。
 * reset で記録が無い(rec が null)ときは、記録を作らずに値だけを消す。
 * active → human(消し直す案内)。unknown → error(何も変えない)
 * @param {"finish"|"reset"} mode
 * @returns {Promise<{ status: "ok"|"human"|"error", lines: string[] }>}
 */
export async function deleteParent(ctx, rec, parentId, mode) {
  if (mode !== "finish" && mode !== "reset") throw new Error(`親を消す用途が違う: ${String(mode)}(finish か reset)`);
  if (mode === "finish" && !rec) throw new Error("親を消して済ませるには記録が要る(呼び出し元の誤り)");
  const fs = fsOf(ctx);
  const value = secretOf(ctx, PARENT_KEY);
  const label = `${tokenName("parent", ctx.ident)}(ID ${parentId})`;
  if (!nonEmpty(value)) return { status: "error", lines: [`親 ${label} の値が deploy-secrets.env に無いので、消せたかを確かめられない。`] };

  const allow = allowedDeleteIds(rec, "parent", parentId);
  await ctx.cf.deleteToken(value, parentId, allow);
  await ctx.sleep(DELETE_WAIT_MS);
  const v = await ctx.cf.verify(value);
  if (v.state === "gone") {
    if (rec) {
      if (mode === "finish") {
        if (!rec.parent_deleted_at) rec.parent_deleted_at = isoNow(ctx);
      } else {
        rec.parent_id = null;
        rec.parent_fp = null;
      }
      fs.writeRecord(ctx.files.record, rec);
    }
    fs.clearSecret(ctx.files.secrets, PARENT_KEY);
    return { status: "ok", lines: [] };
  }
  if (v.state === "unknown") {
    return { status: "error", lines: [`親 ${label} を消せたかを確かめられなかった(${errText(v)})。親の DELETE は送った。親の記録と CF_BOOTSTRAP_TOKEN の値は変えていない。少し待ってから同じコマンドを打ち直す(打ち直すと、親が消えたかを確かめ直す)。`] };
  }
  return { status: "human", lines: [`消したはずの親 ${label} がまだ有効。同じコマンドを打ち直すと消し直す。${LIST_PLACE}で消してから打ち直してもよい。`] };
}
