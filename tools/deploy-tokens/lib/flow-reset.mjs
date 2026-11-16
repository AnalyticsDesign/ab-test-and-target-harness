// 切り替え(--reset): 済む前に、このスクリプトが作った子と親を消して記録を消し、人が救済の手順に移れるようにする。
// 生きた親(確かめを通った今の親で、ID が記録と同じ)があるときだけ呼ぶ。順:
//   1. 作成の印があれば、印の時刻から 60 秒たつまで待つ → トークンの一覧を読み切る(読めなければ止まる。記録は変えない)→
//      印があり、記録に無い同名が一覧にあれば止まる(記録は変えない)。無ければ印を外す
//   2. 最初の DELETE の直前に children_checked_at を外す → 記録の子を 1 本ずつ消す(DELETE → 値の行を空にする → 記録から外す)
//   3. 一覧をもう一度読み切り、記録に無い同名があれば止まる(遅れて成立した POST。親はまだ消さない)
//   4. 親を消す(parent_id・parent_fp を外す。parent_deleted_at は書かない。途中で止まっても記録が「後」にならず、
//      打ち直しの --reset が断られないように)
//   5. 記録を消す → done
import {
  LIST_PLACE, PARENT_KEY, secretOf, finish, apiStop, parentLabel, parentAliveLine, markParentDeleted,
  unrecordedSameName, sameNameExit, waitPending, clearPending, uncheck, deleteRecordedChildren, deleteParent,
} from "./flow-common.mjs";

/** 切り替えが済んだ後に人がすること */
export const SWITCH_NEXT = "deploy-answers.yaml の cloudflare_tokens を書き換えて、救済の手順に進む。";

/** --reset で記録に無い同名を見つけたときの次の一手 */
const SAME_NAME_NEXT = Object.freeze([
  `使っていないと分かっていれば、${LIST_PLACE}で、上に出した Name(名前)のトークン(使っていない方。Created(作成日)で見分ける)を消してから、--reset を付けて打ち直す。`,
]);

/**
 * @param {ReturnType<import("./flow-common.mjs").newRun>} run
 * @param {{ id: string, name?: string|null, expires_on?: string|null }} ps 確かめを通った今の親
 */
export async function switchOver(run, ps) {
  const { ctx, fs } = run;
  const value = secretOf(ctx, PARENT_KEY);
  const rec = run.rec;

  if (!rec) {
    // 記録が無い: 消す子も解く印も無いので、親だけを消す
    const del = await deleteParent(ctx, null, ps.id, "reset");
    if (del.status !== "ok") return finish(run, del.status, del.lines);
    markParentDeleted(run, ps);
    return finish(run, "done", [`親 ${parentLabel(ctx, ps)} を消した。ほかに消すものは無い。${SWITCH_NEXT}`]);
  }

  // 1. 作成の印を解く
  await waitPending(run);
  const list = await ctx.cf.listTokens(value);
  if (!list.ok) return apiStop(run, list, "トークンの一覧を読み切れなかった", { tail: "何も消していない。" });
  if (rec.pending) {
    const hits = unrecordedSameName(run, list.result);
    if (hits.length > 0) return sameNameExit(run, hits, { parentAlive: true, ps, next: SAME_NAME_NEXT });
    clearPending(run);
  }

  // 2. 記録の子を消す
  const stop = await deleteRecordedChildren(run, value, { rerun: "--reset を付けて", tail: "親はまだ消していない。" });
  if (stop) return stop;

  // 3. 遅れて成立した POST を拾うため、親を消す前にもう一度一覧を読み切る
  const again = await ctx.cf.listTokens(value);
  if (!again.ok) {
    const r = apiStop(run, again, "親を消す前のトークンの一覧の読み直しで、一覧を読み切れなかった", { tail: "親はまだ消していない。" });
    r.lines.push(parentAliveLine(ctx, ps));
    return r;
  }
  const late = unrecordedSameName(run, again.result);
  if (late.length > 0) return sameNameExit(run, late, { parentAlive: true, ps, next: SAME_NAME_NEXT });

  // 4. 親を消す(子が 0 本でも、最初の DELETE の前に children_checked_at を外す)
  uncheck(run);
  const del = await deleteParent(ctx, rec, ps.id, "reset");
  if (del.status !== "ok") return finish(run, del.status, del.lines);
  markParentDeleted(run, ps);

  // 5. 記録を消す
  fs.removeRecord(ctx.files.record);
  run.rec = null;
  return finish(run, "done", [`記録の子と親 ${parentLabel(ctx, ps)} を消し、記録 deploy-tokens.json を消した。${SWITCH_NEXT}`]);
}
