// 親トークンから残りのトークンを作る一本道の流れ(execute)。
// 始めに「記録の状態 × 親の値 × 引数」で進み方を 1 つに決め、決められない状態はすべて人の出口(名前と ID を出して止まる)に入れる。
// 出力(Outcome)にトークンの値・親の値の指紋・OAuth の値・作った人のメールアドレス・値の末尾 4 文字を入れない。
// 記録の欄と書き方は record.mjs、値のファイルは secrets.mjs、API は cf.mjs、トークンの表は spec.mjs、
// 共に使う道具(出力の形・人の出口・記録の子と親の削除)は flow-common.mjs、切り替え(--reset)は flow-reset.mjs。
//
// 進み方(当たったところで決める):
//   1. 引数の組を確かめる → ロック → 記録を読む(アカウント ID を照らす。済んだ後の --reset は断る)→
//      (記録が無いか子を確かめる前で、--reset が無ければ)cloudflare_tokens が bootstrap かを確かめる → deploy-secrets.env の形を確かめる
//   2. 親の値を読む(parentState)。先に当てる規則: 不明 → error / 誤 → human / 他 → 値を消して「無」として続ける /
//      値があったときの --parent-deleted → 引数を使わずに値で決める
//   3. 記録の状態で分ける(cellFor。記録の状態 × 親の値 × 引数のマス)
//   4. 作る(newFlow。記録が無いか、子を確かめる前の記録で、親が「同」): 権限の ID → 要るゾーン → (作成の印があれば待つ)→
//      トークンの一覧 → (印を一覧で解き、記録の子を消す)→ 値の取り込みの確かめ → 同名の確かめ →
//      子ごとに 印 → POST → ID を記録 → 値を書く → 届き先の確かめ(reachCheck)→ 一覧の読み直し →
//      子を確かめた時刻 → 親を消す(deleteParent)→ 済んだ後の確かめ(checkChildrenAfter)
import { fingerprint } from "./record.mjs";
import { ROLES, ENV_KEY, PERMISSIONS, tokenName, zoneHostsOf, zoneCandidates, createBody, checkParentDetails, readPolicies } from "./spec.mjs";
import { tokenModeOf } from "../../deploy-answers/questions.mjs";
import {
  DEFAULT_FS_OPS, LIST_PLACE, UNDISTINGUISHABLE, PARENT_KEY, CHILD_KEYS, fsOf, isoNow, nonEmpty, secretOf, errText, errCode, isTransient,
  childRoles, recordState, newRecord, newRun, finish, parentLabel, recordedParentLabel, parentAliveLine, markParentDeleted,
  humanExit, apiStop, unrecordedSameName, sameNameExit, waitPending, clearPending, deleteRecordedChildren, deleteParent,
} from "./flow-common.mjs";
import { switchOver, SWITCH_NEXT } from "./flow-reset.mjs";

export { DEFAULT_FS_OPS, deleteParent };

/**
 * @typedef {"none"|"same"|"other"|"bad"|"gone"|"foreign"|"unknown"} ParentState
 * @typedef {{ status: "done"|"human"|"error", lines: string[], tokens: { role: string, name: string, id: string, expires_on: string|null }[], parent: { name: string|null, id: string|null, state: string } | null }} Outcome
 */

/** 流れが読み書きする行。API を呼ぶ前に、この行の形を確かめる */
const FLOW_KEYS = [PARENT_KEY, ...CHILD_KEYS];

/** 届き先の確かめ直し(5 秒おきに 3 回) */
const REACH_RETRIES = 3;
const REACH_WAIT_MS = 5000;

/** 作業用の届き先: 要るゾーンごとに、この phase の entrypoint を読む。ルールの無いゾーンは 10003 が返り、届いた扱い */
const REACH_PHASE = "http_ratelimit";
const NO_ENTRYPOINT = 10003;

/** 本文を読めなかった・読めても形が違ったときの code(状態コードが付いていても、中身で決められない) */
const UNREAD_BODY_CODES = new Set(["network", "non_json", "bad_shape"]);

const ROLE_LABEL = Object.freeze({ setup: "作業用", deploy: "デプロイ用", usage: "使用状況用" });

// ---- 入口 ----

/**
 * ctx.onSignals(release) は任意。ロックを取った直後に呼び、戻り値(取り外す関数)をロックを外す前に呼ぶ。
 * SIGINT・SIGTERM の扱いは呼ぶ側(入口)が持つ(この関数は process に触れない)。
 * @param {{ cf, oauthToken: () => Promise<string>, files: { secrets: string, record: string, lock: string }, fsOps?, answers, ident: string,
 *   accountId: string, now: () => Date, sleep: (ms: number) => Promise<void>, args: { reset: boolean, parentDeleted: boolean },
 *   onSignals?: (release: () => void) => () => void }} ctx
 * @returns {Promise<Outcome>}
 */
export async function execute(ctx) {
  const run = newRun(ctx);
  const args = ctx.args ?? { reset: false, parentDeleted: false };
  if (args.reset && args.parentDeleted) {
    return finish(run, "error", ["--reset と --parent-deleted は一緒に使えない。どちらか一方だけを付けて打ち直す。"]);
  }
  let lock;
  try {
    lock = run.fs.acquireLock(ctx.files.lock, ctx.now);
  } catch (e) {
    return finish(run, "error", [String(e && e.message)]);
  }
  let removeSignals = null;
  try {
    if (typeof ctx.onSignals === "function") removeSignals = ctx.onSignals(lock.release);
    if (lock.removedStale) {
      run.lines.push(`前の実行が残したロック(pid ${lock.removedStale.pid}、開始 ${lock.removedStale.started_at})を外した。その実行はもう動いていなかった。`);
    }
    return await executeLocked(run, args);
  } finally {
    // どの出口でも(シグナルの取り外しが投げても)ロックを外す
    try { if (typeof removeSignals === "function") removeSignals(); } finally { lock.release(); }
  }
}

async function executeLocked(run, args) {
  const { ctx, fs } = run;
  try {
    run.rec = fs.readRecord(ctx.files.record);
  } catch (e) {
    return finish(run, "error", [String(e && e.message)]);
  }
  if (run.rec && run.rec.account_id !== ctx.accountId) {
    return finish(run, "error", [`記録ファイル ${ctx.files.record} のアカウント ID が、CLOUDFLARE_ACCOUNT_ID と違う。別のアカウントの導入の記録なので、使うアカウント ID を確かめてから打ち直す。`]);
  }
  // 済んだ後の --reset は、親の値がどうでも使い方の誤り(何も変えないため、親の値を読む前に断る)
  if (args.reset && recordState(run.rec) === "after") {
    return finish(run, "error", ["導入はもう済んでいる(子を確かめ、親も消した)ので、--reset は使えない。何も変えていない。済んだ後は、救済の手順への切り替えに使わない。"]);
  }
  // 作る道(記録が無いか、子を確かめる前)は、cloudflare_tokens が bootstrap のときだけ。API を呼ぶ前・値を消す前に断る。
  // --reset は救済の手順に移るためのものなので見ない。子を確かめた後の記録は、書き換えた後でも済むまで進める
  const state0 = recordState(run.rec);
  if (!args.reset && (state0 === "none" || state0 === "before")) {
    const modeStop = checkMode(run);
    if (modeStop) return modeStop;
  }

  // 値のファイルの形(形の外の行は値が空に見えるので、API を呼ぶ前に止める)
  const bad = fs.checkSecretsForm(ctx.files.secrets, FLOW_KEYS);
  if (bad.length > 0) {
    return finish(run, "human", [
      ...bad.map((b) => `deploy-secrets.env の ${b.key} の行(${b.line} 行目)の形が違う。`),
      "その行を「キー=値」の形にしてから打ち直す(前に export を付けない・= の前後に空白を入れない・値を引用符で囲まない・値の前後に空白を入れない)。",
    ]);
  }

  // 親の値の読みと、どのマスよりも先に当てる規則
  const ps = await parentState(ctx, run.rec);
  run.parentOut = { name: ps.name ?? null, id: ps.id ?? null, state: ps.state };
  if (ps.state === "unknown") {
    return finish(run, "error", [`親トークンを確かめられなかった(${ps.error})。何も変えていない。少し待ってから同じコマンドを打ち直す。何度か打ち直しても同じなら、打ち直しを止めて人に伝える(親トークンは期限で切れる)。`]);
  }
  if (ps.state === "bad") {
    const lines = [...ps.problems.map((p) => `親トークン ${parentLabel(ctx, ps)}: ${p}`)];
    lines.push(`そのトークンは使わない。${LIST_PLACE}で消し、deploy-secrets.env の CF_BOOTSTRAP_TOKEN の値を消す。済む前なら、依頼文どおりに作り直して貼る。`);
    if (ps.notYetValid) lines.push("作り直すときは、期限の Start(開始)が今日になっているかを確かめる(カレンダーで翌日だけを押すと、開始も翌日になる)。");
    return finish(run, "human", lines);
  }
  if (ps.state === "foreign") {
    fs.clearSecret(ctx.files.secrets, PARENT_KEY);
    const known = ps.id ? `(ID ${ps.id})` : "";
    run.lines.push(`使えない親の値を消した(別のアカウントのトークン・User API Token(My Profile(マイ プロフィール)で作ったトークン)・期限の切れたトークン・壊れた値のどれか)${known}。そのトークンが${LIST_PLACE}に残っていれば消す。User API Token を親として作ったのなら、ダッシュボードの右上のユーザーのアイコン → Profile(プロフィール)→ API Tokens(API トークン)の一覧で消す。親トークンは Account API tokens(アカウント API トークン)の画面で作る。`);
    ps.state = "none";
    run.parentOut = { name: null, id: ps.id ?? null, state: "foreign" };
  }
  // 値があったときの --parent-deleted は使わない(値で決める)。値があったかは始めに読んだ時点で決める(他で消した後も同じ)
  let effective = args;
  if (args.parentDeleted && ps.hadValue) {
    run.lines.push("deploy-secrets.env の CF_BOOTSTRAP_TOKEN に値があったので、--parent-deleted は使わなかった(値で進み方を決めた)。");
    effective = { ...args, parentDeleted: false };
  }

  return cellFor(run, ps, effective);
}

// ---- 記録の状態 × 親の値 × 引数 ----

/**
 * 「記録の状態 × 親の値 × 引数」のマスを選ぶ。親の値は 無(none)・同(same)・別(other)・消(gone) のどれか
 * (不明・誤・他は先の規則で片付いている)。表に無い組み合わせは、すべて人の出口に入れる
 */
async function cellFor(run, ps, args) {
  const state = recordState(run.rec);
  const arg = args.reset ? "reset" : args.parentDeleted ? "parentDeleted" : "plain";
  const cell = { none: cellNone, before: cellBefore, checked: cellChecked, after: cellAfter }[state];
  const out = await cell(run, ps, arg);
  return out ?? unmatched(run, state, ps, arg);
}

/** 表のマスに当たらない状態(起きないはずの組み合わせ)。人の出口に入れる */
function unmatched(run, state, ps, arg) {
  return humanExit(run, [`記録の状態(${state})と親の値(${ps.state})と引数(${arg})の組み合わせは、自動では進められない。`]);
}

/** 親トークンを作って貼る案内 */
const askParent = (ctx, tail = "") => `親トークン ${tokenName("parent", ctx.ident)} を依頼文どおりに作り、その値を deploy-secrets.env の CF_BOOTSTRAP_TOKEN に貼ってから、同じコマンドを打ち直す${tail}。`;
const REDO_CHILDREN = "(記録の子は、その親で消してから作り直す)";

/** 記録が無い */
async function cellNone(run, ps, arg) {
  const { ctx } = run;
  if (arg === "plain") {
    if (ps.state === "none") return finish(run, "human", [askParent(ctx)]);
    // 記録が無ければ parent_id も指紋も無いので、生きた親は「同」、消えた値は「他」になる
    if (ps.state === "same") return newFlow(run, ps);
  }
  if (arg === "reset") {
    if (ps.state === "none") return finish(run, "done", [`消すものは無い。${SWITCH_NEXT}`]);
    if (ps.state === "same") return switchOver(run, ps);
  }
  if (arg === "parentDeleted" && ps.state === "none") {
    return finish(run, "error", ["記録に親が無いので、--parent-deleted は使えない。引数を付けずに打ち直す。"]);
  }
  return null;
}

/** 記録の親が消えていた(消): parent_id・parent_fp を外し、値を消す。この後は「無」として続ける */
function forgetGoneParent(run, ps) {
  const { ctx, fs, rec } = run;
  const P = recordedParentLabel(run);
  rec.parent_id = null;
  rec.parent_fp = null;
  fs.writeRecord(ctx.files.record, rec);
  fs.clearSecret(ctx.files.secrets, PARENT_KEY);
  run.lines.push(`記録の前の親 ${P} は消えていたので、記録から外し、deploy-secrets.env の CF_BOOTSTRAP_TOKEN の値を消した。`);
  ps.state = "none";
}

/** 一覧で前の親・今の親を指す言葉。2 本とも同じ名前なので、Created(作成日)の古い方が前の親、新しい方が今の親 */
const prevParentWhere = (ctx) => `Name(名前)が ${tokenName("parent", ctx.ident)} のトークンのうち、Created(作成日)が古い方(前の親)`;
const CUR_PARENT = "Created(作成日)が新しい方";
const CUR_PARENT_KEEP = `新しい方(今の親)は消さない`;
/** 人が先に前の親を消していると、一覧の同じ名前は今の親 1 本だけになる。今の親の値が生きているマス(別)でだけ使う */
const ONE_LEFT_IS_CURRENT = "一覧にその Name(名前)のトークンが 1 本だけなら、それは今の親なので消さない(前の親はもう消えている。そのまま次へ進む)";

/** 前の親が記録にあり、今の親と違う(別)。前の親が消えたと確かめられるまで、どちらも消さない */
function otherParentExit(run, ps, arg) {
  const { ctx } = run;
  const P = recordedParentLabel(run);
  const cur = parentLabel(ctx, ps);
  // 前の親と今の親は名前が同じで、一覧に ID の列は無いので、Created(作成日)の古い・新しいで書き分ける
  const next = [`${LIST_PLACE}で、${prevParentWhere(ctx)}を消し、${CUR_PARENT_KEEP}。${ONE_LEFT_IS_CURRENT}。deploy-secrets.env の CF_BOOTSTRAP_TOKEN を空にして --parent-deleted を付けて打つ。その後、今の親(${CUR_PARENT})の値を CF_BOOTSTRAP_TOKEN に貼り直して打ち直す。`];
  if (arg === "reset") next.push("--reset で止まったときは、貼り直した後も --reset を付けて打つ。");
  return humanExit(run, [`記録の前の親 ${P} と、今の親 ${cur} が違う。前の親が消えたと確かめられるまで、どちらも消さない。`], { next });
}

/** 記録が「前」(子を確かめる前) */
async function cellBefore(run, ps, arg) {
  const { ctx, fs, rec } = run;
  if (ps.state === "gone") forgetGoneParent(run, ps);
  if (ps.state === "other") return otherParentExit(run, ps, arg);
  if (ps.state === "same") {
    if (arg === "plain") return newFlow(run, ps); // 最初からやり直す(記録の子を消してから作る)
    if (arg === "reset") return switchOver(run, ps);
  }
  if (ps.state !== "none") return null;

  const P = recordedParentLabel(run);
  if (arg === "plain") {
    if (!P) return humanExit(run, ["deploy-secrets.env の CF_BOOTSTRAP_TOKEN に値が無い。"], { next: [askParent(ctx, REDO_CHILDREN)] });
    return humanExit(run, [`deploy-secrets.env の CF_BOOTSTRAP_TOKEN に値が無い。記録には前の親 ${P} と、その親で作った子がある。`], {
      next: [
        `前の親の値が手元にあれば、CF_BOOTSTRAP_TOKEN に貼り直して同じコマンドを打ち直す${REDO_CHILDREN}。`,
        `値が無ければ、${LIST_PLACE}で、${prevParentWhere(ctx)}を消してから --parent-deleted を付けて打つ。その後、新しい親として、${askParent(ctx, REDO_CHILDREN)}`,
      ],
    });
  }
  if (arg === "reset") {
    if (childRoles(rec).length === 0 && !rec.pending && !P) {
      fs.removeRecord(ctx.files.record);
      run.rec = null;
      return finish(run, "done", [`消すものは無い(記録 deploy-tokens.json だけを消した)。${SWITCH_NEXT}`]);
    }
    const next = ["生きた親の値を CF_BOOTSTRAP_TOKEN に貼って、--reset を付けて打ち直す。"];
    if (P) next.push(`記録の親(${prevParentWhere(ctx)})が${LIST_PLACE}に無ければ(もう消えていれば)、先に --parent-deleted を付けて打ち、新しい親を作って貼ってから、--reset を付けて打つ。`);
    return humanExit(run, ["--reset で記録の子と親を消すには、生きた親の値が要るが、deploy-secrets.env の CF_BOOTSTRAP_TOKEN に値が無い。"], { next });
  }
  // --parent-deleted(値が無いときだけここに来る)
  if (!P) return finish(run, "error", ["記録に親が無いので、--parent-deleted は使えない。引数を付けずに打ち直す。"]);
  rec.parent_id = null;
  rec.parent_fp = null;
  fs.writeRecord(ctx.files.record, rec);
  // 前の手順が --reset の途中か(前 × 無・別 の --reset の出口から来たか)はここでは分からないので、両方の打ち方を書く
  return humanExit(run, [`記録の前の親 ${P} を、消えたものとして記録から外した。`], {
    next: [
      `生きている親の値を deploy-secrets.env の CF_BOOTSTRAP_TOKEN に貼ってから、引数を付けずに打ち直す${REDO_CHILDREN}。前の手順で貼っていた今の親がまだ生きていれば、その値を貼り直せばよい(新しく作らなくてよい)。無ければ、親トークン ${tokenName("parent", ctx.ident)} を依頼文どおりに新しく作って貼る。`,
      "救済の手順に切り替える途中(--reset を打って止まった後)なら、引数を付けずにではなく --reset を付けて打つ(記録の子と親を消し、記録を消す)。",
    ],
  });
}

/** 記録が「確」(子を確かめた後・親を消す前) */
async function cellChecked(run, ps, arg) {
  const { ctx, fs, rec } = run;
  const P = recordedParentLabel(run);
  const cur = ps.state === "same" || ps.state === "other" ? parentLabel(ctx, ps) : null;
  if (arg === "plain") {
    if (ps.state === "same") return deleteParentThenCheck(run, ps);
    if (ps.state === "gone") {
      // 親の DELETE を送った後で止まった実行の打ち直しで、親が消えていた
      rec.parent_deleted_at = isoNow(ctx);
      fs.writeRecord(ctx.files.record, rec);
      fs.clearSecret(ctx.files.secrets, PARENT_KEY);
      return afterCheck(run);
    }
    if (ps.state === "none") {
      return humanExit(run, [`記録の親 ${P} が消えたかを確かめられない(deploy-secrets.env の CF_BOOTSTRAP_TOKEN に値が無い)。`], {
        next: [`${LIST_PLACE}に記録の親(${prevParentWhere(ctx)})があれば消してから、CF_BOOTSTRAP_TOKEN の値を空のまま --parent-deleted を付けて打つ。`],
      });
    }
    if (ps.state === "other") {
      return humanExit(run, [`記録の親 ${P} と、今の親 ${cur} が違う。`], {
        next: [`${LIST_PLACE}で記録の親 ${P} と今の親 ${cur} を消し、deploy-secrets.env の CF_BOOTSTRAP_TOKEN を空にして --parent-deleted を付けて打つ。`],
      });
    }
  }
  if (arg === "reset") {
    if (ps.state === "same") return switchOver(run, ps);
    if (ps.state === "none") {
      return humanExit(run, [`--reset で記録の子を消すには、記録の親 ${P} の値が要るが、deploy-secrets.env の CF_BOOTSTRAP_TOKEN に値が無い。`], {
        next: [
          `記録の親 ${P} の値が手元にあれば、CF_BOOTSTRAP_TOKEN に貼り直して --reset を付けて打ち直す。`,
          `値が無ければ、${LIST_PLACE}で記録の子と記録の親 ${P} を消し、エージェントが deploy-tokens.json を消して deploy-secrets.env の子の行を空にする(これで切り替えが済む)。--parent-deleted は使わない。`,
        ],
      });
    }
    if (ps.state === "other") {
      return humanExit(run, [`記録の親 ${P} と、今の親 ${cur} が違うので、--reset では消さない。`], {
        next: [`${LIST_PLACE}で記録の子と記録の親 ${P} と今の親 ${cur} を消し、エージェントが deploy-tokens.json を消して、deploy-secrets.env の子の行と CF_BOOTSTRAP_TOKEN を空にする(これで切り替えが済む)。--parent-deleted は使わない。`],
      });
    }
    if (ps.state === "gone") {
      // 記録も値も変えない
      return humanExit(run, [`記録の親 ${P} はもう消えたので、--reset では記録の子を消せない。`], {
        next: [`${LIST_PLACE}で記録の子を消し、エージェントが deploy-tokens.json を消して、deploy-secrets.env の子の行と CF_BOOTSTRAP_TOKEN(もう使えない親の値)を空にする(これで切り替えが済む)。--parent-deleted は使わない。`],
      });
    }
  }
  if (arg === "parentDeleted" && ps.state === "none") {
    rec.parent_deleted_at = isoNow(ctx);
    fs.writeRecord(ctx.files.record, rec);
    run.lines.push(`--parent-deleted を受けて、記録の親 ${P} を消えたものとして記録した。`);
    return afterCheck(run);
  }
  return null;
}

/** 記録が「後」(子を確かめ、親を消した後)。--reset は入口で断ってある */
async function cellAfter(run, ps, arg) {
  const { ctx, fs } = run;
  if (arg === "parentDeleted" && ps.state === "none") {
    run.lines.push("済んだ後なので、--parent-deleted は要らない(使わなかった)。");
    return afterCheck(run);
  }
  if (arg !== "plain") return null;
  if (ps.state === "none") return afterCheck(run);
  // 記録の親は消えているので、生きた親の値は貼り直された別の親(同も別として扱う)
  if (ps.state === "same" || ps.state === "other") return deleteParentThenCheck(run, ps);
  if (ps.state === "gone") {
    // 親が消えたと書いた後・値を消す前で止まった実行の打ち直し
    fs.clearSecret(ctx.files.secrets, PARENT_KEY);
    run.lines.push("消えた親の値を deploy-secrets.env の CF_BOOTSTRAP_TOKEN から消した。");
    return afterCheck(run);
  }
  return null;
}

/** 確かめを通った今の親を消してから、済んだ後の確かめ */
async function deleteParentThenCheck(run, ps) {
  const del = await deleteParent(run.ctx, run.rec, ps.id, "finish");
  if (del.status !== "ok") return finish(run, del.status, del.lines);
  markParentDeleted(run, ps);
  return afterCheck(run);
}

/** 済んだ後の確かめ(何も作らない・子は消さない) */
async function afterCheck(run) {
  const after = await checkChildrenAfter(run.ctx, run.rec);
  return finish(run, after.status, after.lines);
}

/** cloudflare_tokens が bootstrap でなければ使い方の誤り */
function checkMode(run) {
  let mode;
  try {
    mode = tokenModeOf(run.ctx.answers ?? {});
  } catch (e) {
    return finish(run, "error", [String(e && e.message)]);
  }
  if (mode === "bootstrap") return null;
  return finish(run, "error", [`deploy-answers.yaml の cloudflare_tokens が ${mode} なので、このスクリプトは使わない(親トークンから作るのは bootstrap のときだけ)。済む前に救済の手順に切り替えるなら --reset を付けて打つ。`]);
}

// ---- 親の値の読み ----

/**
 * CF_BOOTSTRAP_TOKEN の値の状態を決める。値そのものは返さない。
 * @returns {Promise<{ state: ParentState, hadValue: boolean, id?: string|null, name?: string|null, expires_on?: string|null,
 *   problems?: string[], notYetValid?: boolean, error?: string }>}
 */
export async function parentState(ctx, rec) {
  const value = secretOf(ctx, PARENT_KEY);
  if (!nonEmpty(value)) return { state: "none", hadValue: false };
  const v = await ctx.cf.verify(value);
  const base = { hadValue: true, id: v.id ?? null, name: null, expires_on: v.expires_on ?? null };
  if (v.state === "unknown") return { ...base, state: "unknown", error: errText(v) };
  if (v.state === "not_yet_valid") {
    // 開始前は詳細を読まない(使える前のトークンで、ほかの宛先がどう応えるかを前提にしない)
    return { ...base, state: "bad", notYetValid: true, problems: [`開始が今より先になっている(開始: ${v.not_before})。その時刻になるまで使えない`] };
  }
  if (v.state === "gone") {
    const same = rec && nonEmpty(rec.parent_fp) && fingerprint(value) === rec.parent_fp;
    return { ...base, state: same ? "gone" : "foreign" };
  }
  if (v.state !== "active" || !nonEmpty(v.id)) return { ...base, state: "bad", problems: ["親トークンの ID を読めない"] };

  const d = await ctx.cf.tokenDetails(value, v.id);
  // 一時的な失敗(429・通信の失敗・5xx・JSON でない応答)は「不明」。人に親を作り直させない
  // (5xx と JSON でない応答は、Cloudflare の一時的な障害や間の proxy の HTML の 502 で返りうる。verify の側でも 5xx は不明)
  const transient = isTransient(d) || (typeof d.status === "number" && d.status >= 500) || errCode(d) === "non_json";
  if (!d.ok && transient) return { ...base, state: "unknown", error: `親トークンの詳細: ${errText(d)}` };
  if (!d.ok || !d.result || typeof d.result !== "object") {
    return { ...base, state: "bad", problems: [`親トークンの詳細を読めない(${errText(d)})`] };
  }
  const details = d.result;
  const name = typeof details.name === "string" ? details.name : null;
  const expires = typeof details.expires_on === "string" ? details.expires_on : base.expires_on;
  const problems = checkParentDetails(details, { ident: ctx.ident, accountId: ctx.accountId, now: ctx.now() });
  if (details.id !== v.id) problems.push("詳細の ID が verify の ID と違う");
  const out = { ...base, name, expires_on: expires };
  if (problems.length > 0) return { ...out, state: "bad", problems };
  const same = !rec || !nonEmpty(rec.parent_id) || rec.parent_id === v.id;
  return { ...out, state: same ? "same" : "other" };
}

// ---- 新しく作る ----

async function newFlow(run, ps) {
  const { ctx, fs } = run;
  const value = secretOf(ctx, PARENT_KEY);

  let hosts;
  try {
    hosts = zoneHostsOf(ctx.answers ?? {});
  } catch (e) {
    return finish(run, "error", [String(e && e.message)]);
  }
  const roles = hosts.length > 0 ? [...ROLES] : ROLES.filter((r) => r !== "setup");

  // 権限の ID(名前で引く。0 件か 2 件以上なら止まる)
  const pg = await ctx.cf.permissionGroups(value);
  if (!pg.ok) return apiStop(run, pg, "権限の一覧を読めなかった");
  const groupIds = {};
  const groupProblems = [];
  for (const role of roles) {
    for (const [permName] of PERMISSIONS[role]) {
      if (permName in groupIds) continue;
      const hit = pg.result.filter((g) => g && g.name === permName);
      if (hit.length === 1 && nonEmpty(hit[0].id)) groupIds[permName] = hit[0].id;
      else groupProblems.push(`権限 ${permName} が権限の一覧に ${hit.length} 件ある(1 件のはず)`);
    }
  }
  if (groupProblems.length > 0) {
    return finish(run, "human", [...groupProblems, "何も作っていない。Cloudflare の権限の名前が変わった可能性がある。救済の手順に切り替えるなら --reset を付けて打つ。"]);
  }

  // 要るゾーンの ID
  let zoneIds = [];
  if (hosts.length > 0) {
    const z = await lookupZones(run, hosts);
    if (z.stop) return z.stop;
    zoneIds = z.zoneIds;
  }

  // 作成の印があれば、印の時刻から 60 秒たつまで待ってから一覧を読む(遅れて成立する POST を一覧で拾うため)
  await waitPending(run);

  // トークンの一覧(読み切れなければ作らない)
  const list = await ctx.cf.listTokens(value);
  if (!list.ok) return apiStop(run, list, "トークンの一覧を読み切れなかった");

  // 前の実行が済む前に止まった: 印を一覧で解き、記録の子を消してから最初から作る
  if (run.rec) {
    const stop = await clearForRestart(run, ps, value, list.result);
    if (stop) return stop;
  }

  // 値があり、記録に無い子 → 取り込まずに止まる(記録の子の行は、上で消したときに空にしてある)
  const secrets = fs.readSecrets(ctx.files.secrets);
  const stray = CHILD_KEYS.filter((k) => secrets && nonEmpty(secrets.get(k)));
  if (stray.length > 0) {
    return finish(run, "human", [
      ...stray.map((k) => `deploy-secrets.env の ${k} に値があるが、記録 deploy-tokens.json に無い。`),
      `この値はこのスクリプトが作ったものとして確かめられない。救済の手順で作った値なら、deploy-answers.yaml の cloudflare_tokens を元に戻す。親の道で進めるなら、その値のトークンを${LIST_PLACE}で消し、値を消してから打ち直す。`,
      run.deletedIds.size > 0 ? "記録の子は消した。新しくは何も作っていない。" : "何も作っていない・何も消していない。",
    ]);
  }

  // 記録に無い同名(最初に読んだ一覧から、記録の ID と今の実行で消した ID を除く。一覧は読み直さない)
  const sameName = unrecordedSameName(run, list.result);
  if (sameName.length > 0) return sameNameExit(run, sameName, { parentAlive: Boolean(run.rec), ps });

  // 子を作る(子ごとに: 印 → POST → ID を記録 → 値を書く)
  const rec = run.rec ?? newRecord(ctx);
  run.rec = rec;
  rec.parent_id = ps.id;
  rec.parent_fp = fingerprint(value);
  for (const role of roles) {
    const stop = await createChild(run, ps, value, role, { zoneIds, groupIds });
    if (stop) return stop;
  }

  // 届き先
  const reach = await reachCheck(ctx, rec, { zoneIds });
  if (!reach.ok) {
    return finish(run, "human", [
      ...reach.failures,
      parentAliveLine(ctx, ps),
      "原因を直したら同じコマンドを打ち直す(子は消して作り直される)。やめて救済の手順に移るなら --reset を付けて打つ。",
    ]);
  }

  // 遅れて成立した POST を拾うため、もう一度一覧を読み切る
  const again = await ctx.cf.listTokens(value);
  if (!again.ok) {
    const r = apiStop(run, again, "済む前のトークンの一覧の読み直しで、一覧を読み切れなかった", { created: true });
    r.lines.push(parentAliveLine(ctx, ps));
    return r;
  }
  const late = unrecordedSameName(run, again.result);
  if (late.length > 0) return sameNameExit(run, late, { parentAlive: true, ps });

  rec.children_checked_at = isoNow(ctx);
  fs.writeRecord(ctx.files.record, rec);

  return deleteParentThenCheck(run, ps);
}

/**
 * やり直しの前片付け(作成の印を書いた後・子の途中・届き先の確かめで止まった実行の打ち直し)。
 * 作成の印があり、記録に無い同名が一覧にあれば止まる(POST が遅れて成立したかもしれない。消さない)。
 * 無ければ記録の子を 1 本ずつ消し、印を外す。止まるときは Outcome
 */
async function clearForRestart(run, ps, parentValue, list) {
  if (run.rec.pending) {
    const hits = unrecordedSameName(run, list);
    if (hits.length > 0) return sameNameExit(run, hits, { parentAlive: true, ps });
  }
  const stop = await deleteRecordedChildren(run, parentValue, { rerun: "同じコマンドを", tail: "何も作っていない。" });
  if (stop) return stop;
  clearPending(run);
  return null;
}

/**
 * 要るゾーンの ID を引く。zone_name そのものは完全一致の 1 回、ほかのホストは長い順に当たるまで。
 * 採るのは status が active で、アカウントが入力と同じゾーンだけ。ある候補の名前のゾーンが見えたら、そこで止める
 * (採れないゾーンなら、短い名前のゾーンに進まずに人に見てもらう)
 */
async function lookupZones(run, hosts) {
  const { ctx } = run;
  let oauth;
  try {
    oauth = await ctx.oauthToken();
  } catch (e) {
    // 例外の文は使わない(資格情報の出力の断片を含みうるため)。code か例外の名前だけ
    const kind = e && typeof e.code === "string" && /^[A-Z0-9_]+$/.test(e.code) ? e.code : (e && typeof e.name === "string" && /^[A-Za-z]+$/.test(e.name) ? e.name : "例外");
    return { stop: finish(run, "error", [`ゾーンを引くための wrangler のログインの資格情報を読めなかった(${kind})。wrangler login の後に打ち直す。`]) };
  }
  const ids = [];
  for (const host of hosts) {
    const exact = host === ctx.answers.zone_name;
    let found = null;
    let seen = null;
    for (const cand of zoneCandidates(host, { exact })) {
      const r = await ctx.cf.zonesByName(oauth, cand);
      if (!r.ok) return { stop: apiStop(run, r, `ゾーン ${cand} を引けなかった`) };
      const named = r.zones.filter((z) => z.name === cand);
      if (named.length === 0) continue;
      found = named.find((z) => z.status === "active" && z.accountId === ctx.accountId && nonEmpty(z.id)) ?? null;
      seen = { name: cand, statuses: [...new Set(named.map((z) => z.status))], other: named.every((z) => z.accountId !== ctx.accountId) };
      break;
    }
    if (!found) {
      const why = !seen
        ? `${host} が属すゾーンが見つからない`
        : seen.other
          ? `${host} が属すゾーン ${seen.name} は、このアカウントのゾーンではない`
          : `${host} が属すゾーン ${seen.name} が有効(active)になっていない(状態: ${seen.statuses.join("、")})`;
      return { stop: finish(run, "human", [`${why}。何も作っていない。`, "deploy-answers.yaml の zone_name・control_host・admin_host と、そのゾーンがこのアカウントで有効になっているかを確かめてから打ち直す。"]) };
    }
    if (!ids.includes(found.id)) ids.push(found.id);
  }
  return { zoneIds: ids };
}

/** 作成の応答の権限の名前を、トークンの表と照らす。違う項目の文を返す(空なら通り) */
function createdPolicyProblems(role, result) {
  const { permissionNames, unreadable } = readPolicies(result);
  const want = PERMISSIONS[role].map(([n]) => n);
  const have = [...new Set(permissionNames)];
  const extra = have.filter((n) => !want.includes(n));
  const missing = want.filter((n) => !have.includes(n));
  const out = [];
  if (unreadable > 0) out.push("作成の応答の権限の一部を読めない");
  if (extra.length) out.push(`余分: ${extra.join("、")}`);
  if (missing.length) out.push(`不足: ${missing.join("、")}`);
  return out;
}

/** 子を 1 本作る。止まるときは Outcome、進むときは null */
async function createChild(run, ps, parentValue, role, { zoneIds, groupIds }) {
  const { ctx, fs } = run;
  const rec = run.rec;
  const name = tokenName(role, ctx.ident);
  const body = createBody(role, { ident: ctx.ident, accountId: ctx.accountId, zoneIds, groupIds, now: ctx.now() });

  // 作成の印(POST の結果が分からなくなっても、打ち直しで同名を確かめられるように)
  rec.pending = role;
  rec.pending_at = isoNow(ctx);
  fs.writeRecord(ctx.files.record, rec);

  const r = await ctx.cf.createToken(parentValue, body);
  const result = r.ok && r.result && typeof r.result === "object" ? r.result : null;
  const id = result && typeof result.id === "string" && /^[A-Za-z0-9]+$/.test(result.id) ? result.id : null;
  if (!id) {
    // 断られた(作られていない)と言えるのは、4xx の状態コードで本文も読めたときだけ。
    // それ以外(応答が届かない・本文が切れた・5xx・JSON でない・形の違う応答・成功なのに ID が無い)は、
    // 作れたかどうか分からないので、印を残して止まる
    const refused = typeof r.status === "number" && r.status >= 400 && r.status < 500 && !r.ok && !UNREAD_BODY_CODES.has(errCode(r));
    if (!refused) {
      return finish(run, "error", [
        `${name} の作成の結果が分からない(${r.ok ? "応答に ID が無い" : errText(r)})。記録に印を残した。`,
        parentAliveLine(ctx, ps),
        "同じコマンドを打ち直す(一覧で同名を確かめてから進む)。",
      ]);
    }
    // 断られた(4xx): 作られていないので、印を外す
    rec.pending = null;
    rec.pending_at = null;
    fs.writeRecord(ctx.files.record, rec);
    const s = apiStop(run, r, `${name} を作れなかった`, { created: true });
    s.lines.push(parentAliveLine(ctx, ps));
    return s;
  }

  // ID を先に記録する(値を書く前)
  rec.children[role] = {
    name,
    id,
    expires_on: typeof result.expires_on === "string" ? result.expires_on : null,
    created_at: typeof result.issued_on === "string" ? result.issued_on : isoNow(ctx),
  };
  rec.pending = null;
  rec.pending_at = null;
  fs.writeRecord(ctx.files.record, rec);

  // 応答の権限を表と照らす。違えば値を書かずに止まる(作り直さない。親は消さない)
  const problems = createdPolicyProblems(role, result);
  if (typeof result.value !== "string" || result.value === "") problems.push("作成の応答に値が無い");
  if (problems.length > 0) {
    return finish(run, "human", [
      `作った ${name}(ID ${id})が決まりと違う(${problems.join("、")})。値は deploy-secrets.env に書いていない。`,
      parentAliveLine(ctx, ps),
      "Cloudflare の権限の名前や応答の形が変わった可能性がある。同じコマンドを打ち直すと、記録の子を消してから作り直す。やめて救済の手順に移るなら --reset を付けて打つ。",
    ]);
  }
  fs.setSecret(ctx.files.secrets, ENV_KEY[role], result.value);
  return null;
}

// ---- 届き先の確かめ ----

/**
 * 届いたか。成功のとき。accept10003 の届き先(作業用の ruleset の entrypoint)だけは、エラーが 10003(ルールの無いゾーン)だけのときも届いた扱い
 */
const reached = (r, accept10003) => Boolean(r && (r.ok
  || (accept10003 && Array.isArray(r.errors) && r.errors.length > 0 && r.errors.every((e) => e.code === NO_ENTRYPOINT))));

/**
 * 記録の子ごとに、verify(active・ID が記録と同じ)と届き先を確かめる。
 * 届かなければ 5 秒おきに 3 回だけ確かめ直す(届かなかった届き先と、active でなかった子の verify だけを呼び直す)。
 * @param {{ zoneIds?: string[] }} [opts] 作業用の届き先にするゾーンの ID(記録には持たないので、作ったときの値を渡す)
 * @returns {Promise<{ ok: true } | { ok: false, failures: string[] }>}
 */
export async function reachCheck(ctx, rec, { zoneIds = [] } = {}) {
  // 作業用の子があるのにゾーンが無ければ、呼ぶ側の渡し忘れ(届き先を 1 つも確かめずに通さない)
  if (childRoles(rec).includes("setup") && (!Array.isArray(zoneIds) || zoneIds.length === 0)) {
    throw new Error("作業用のトークンの届き先を確かめるゾーンの ID が渡されていない(呼び出し元の誤り)");
  }
  const secrets = fsOf(ctx).readSecrets(ctx.files.secrets);
  const items = childRoles(rec).map((role) => {
    const child = rec.children[role];
    const value = (secrets && secrets.get(ENV_KEY[role])) || "";
    const targets = [];
    if (role === "setup") {
      for (const zoneId of zoneIds) targets.push({ label: `ゾーン ${zoneId} のルール(${REACH_PHASE})の読み取り`, accept10003: true, call: () => ctx.cf.rulesetEntrypoint(value, zoneId, REACH_PHASE) });
    } else if (role === "deploy") {
      targets.push({ label: "Workers のスクリプトの一覧", accept10003: false, call: () => ctx.cf.workerScripts(value) });
    } else {
      targets.push({ label: "使用状況の照会(GraphQL)", accept10003: false, call: () => ctx.cf.analyticsProbe(value) });
    }
    return { role, child, value, verified: false, why: null, targets: targets.map((t) => ({ ...t, ok: false, why: null })) };
  });

  for (let attempt = 0; attempt <= REACH_RETRIES; attempt++) {
    if (attempt > 0) await ctx.sleep(REACH_WAIT_MS);
    let failed = false;
    for (const it of items) {
      if (!it.verified) {
        if (!nonEmpty(it.value)) {
          it.why = "deploy-secrets.env に値が無い";
        } else {
          const v = await ctx.cf.verify(it.value);
          if (v.state === "active" && v.id === it.child.id) it.verified = true;
          else it.why = v.state === "active" ? "値のトークンの ID が記録と違う" : `確かめ(verify)が ${v.state}(${errText(v)})`;
        }
        if (!it.verified) { failed = true; continue; }
      }
      for (const t of it.targets) {
        if (t.ok) continue;
        const r = await t.call();
        if (reached(r, t.accept10003)) t.ok = true;
        else { t.why = errText(r); failed = true; }
      }
    }
    if (!failed) return { ok: true };
  }

  const failures = [];
  for (const it of items) {
    const label = `${ROLE_LABEL[it.role]} ${it.child.name}(ID ${it.child.id})`;
    if (!it.verified) { failures.push(`${label}: ${it.why}。`); continue; }
    for (const t of it.targets) if (!t.ok) failures.push(`${label}: ${t.label}が届かない(${t.why})。`);
  }
  return { ok: false, failures };
}

// ---- 済んだ後の確かめ ----

/** 済んだ後の確かめで止まったときの、種類ごとの次の一手(種類があれば 1 回だけ出す) */
const AFTER_NEXT = Object.freeze({
  // 値が無い・使えない(後ろの手順で使った後の子を消さないため、スクリプトは作り直さない)
  missing: `後ろの手順でこの値を使った後なら、何もしなくてよい。まだなら、その 1 本を人が直接作り(救済の手順と同じ)、${LIST_PLACE}で、Name(名前)が記録の子と同じトークン(Created(作成日)が導入のころのもの)を消す。${UNDISTINGUISHABLE}`,
  // 作業用は作ってから 24 時間で切れる
  expired: "導入の途中で作業用が切れたら、作業用 1 本を人が直接作る(docs/deploy.md の 0.5 の最後の段落の手順)。導入が済んでいれば、何もしなくてよい。",
  // 上の案内どおりに人が作り直した値(状態は増やさず、止まるが文を分ける)
  recreated: "案内どおり人が作り直した後なら、このままでよい。このスクリプトの確かめは済んでいる。",
});

/**
 * 済んだ後の確かめ。何も作らない・子は消さない。
 * 1. CF_BOOTSTRAP_TOKEN に値が残っている → human(済みを出さない)
 * 2. deploy-secrets.env が無い → human(導入が済んでいれば何もしなくてよい)
 * 3. 記録の子ごとに値を verify。値が無い・active でない → human(作業用の期限切れは文を分ける)/
 *    active で ID が記録と違う → human(人が作り直した後なら、このままでよい)/
 *    確かめられない(429・通信の失敗)→ 「使えない」とはみなさない(ほかに止まる子が無ければ error)
 * 4. どれでもなければ done
 * @returns {Promise<{ status: "done"|"human"|"error", lines: string[] }>}
 */
export async function checkChildrenAfter(ctx, rec) {
  const secrets = fsOf(ctx).readSecrets(ctx.files.secrets);
  if (secrets && nonEmpty(secrets.get(PARENT_KEY))) {
    return {
      status: "human",
      lines: ["deploy-secrets.env の CF_BOOTSTRAP_TOKEN に値が残っているので、済んだとは言わない。同じコマンドを打ち直す(その値の親を確かめ、生きていれば消してから、子を確かめる)。"],
    };
  }
  if (!secrets) {
    return {
      status: "human",
      lines: [
        "deploy-secrets.env が無いので、子の値を確かめられない(済んだとは言わない)。",
        "導入が済んでいれば、何もしなくてよい。まだ済んでいなければ、deploy-secrets.env を元の場所に戻してから同じコマンドを打ち直す。",
      ],
    };
  }

  const lines = [];
  const kinds = new Set();
  let unverified = false;
  for (const role of childRoles(rec)) {
    const c = rec.children[role];
    const key = ENV_KEY[role];
    const label = `${ROLE_LABEL[role]} ${c.name}(ID ${c.id})`;
    const value = secrets.get(key);
    if (!nonEmpty(value)) {
      lines.push(`${label}: deploy-secrets.env の ${key} に値が無い。`);
      kinds.add("missing");
      continue;
    }
    const v = await ctx.cf.verify(value);
    if (v.state === "active" && v.id === c.id) continue;
    if (v.state === "active") {
      lines.push(`${label}: deploy-secrets.env の ${key} の値は、記録と違う ID ${v.id} のトークンのもの。`);
      kinds.add("recreated");
    } else if (v.state === "unknown") {
      lines.push(`${label}: ${key} の値を確かめられなかった(${errText(v)})。子は作ってもいないし、消してもいない。少し待ってから同じコマンドを打ち直す。`);
      unverified = true;
    } else if (role === "setup" && v.state === "gone" && v.tokenStatus === "expired" && v.id === c.id) {
      lines.push(`${label}: 期限が切れている(期限 ${c.expires_on ?? v.expires_on ?? "不明"})。`);
      kinds.add("expired");
    } else {
      // gone・not_yet_valid(ID が記録と違う値もここ)
      lines.push(`${label}: deploy-secrets.env の ${key} の値の確かめ(verify)が ${v.state}。`);
      kinds.add("missing");
    }
  }
  for (const k of ["missing", "expired", "recreated"]) if (kinds.has(k)) lines.push(AFTER_NEXT[k]);
  if (kinds.size > 0) return { status: "human", lines };
  if (unverified) return { status: "error", lines };
  return { status: "done", lines: [] };
}
