import type { EventBody, SiteSettings } from "@wtt/core";
import type { Env } from "./env";
import { newProfileCounterFor } from "./new-profile-counter";
import { profileStub, readRecordGoalOut } from "./profile";
import { forgetResults } from "./results";
import { loadActiveVersion, loadConfig } from "./store";

export type EventOutcome = "recorded" | "ignored" | "failed";

/** Profile の DO に向かうイベント。結果のイベント(participant / conversion)は呼び出し側が results.ts へ分ける(D9 ②) */
export type ProfileEventBody = Extract<EventBody, { type: "goal" } | { type: "forget" }>;

/** 結果のイベント(D9 ② 設計書 §6.3)か。`/event` と `/__ab/event` が handleResultsEvent へ分けるのに使う */
export function isResultsEvent(body: EventBody): body is Extract<EventBody, { type: "participant" } | { type: "conversion" }> {
  return body.type === "participant" || body.type === "conversion";
}

/**
 * spec §9.2: `goal` は Profile の count を加算、`forget` は deleteAll。
 * `goal` が DO に触れない条件(ストレージ汚染とコストの防御): active config が無い / needsProfile=false / 未知の goalId。
 * `forget` は config を見ずに常に届ける(決定 37 の r1 追記、ユーザー選択 C): 履歴条件の実験を止めた後(needsProfile=false)や
 * config が一時的に読めない瞬間の撤回でも「撤回 = 消える」を守る。空の DO への deleteAll は storage も alarm も残さず、
 * 露出は decision 経路(既に URL 一致だけで DO を起こせる)より 1 件あたり安い。
 * 応答は呼び出し側が常に 204(ignored も 204)、failed は 503。
 * plan12 K9: newProfileBudget のある Site では decision と同じく canCreate → recordGoal(allowCreate)→ record。
 * 予算が尽きた後の新しい ID は保存しない(応答は同じ 204)。KV の読み取りの失敗では record を呼ばない("failed" は Profile の DO の例外だけ)
 */
export async function handleEvent(
  env: Env,
  siteId: string,
  settings: SiteSettings,
  body: ProfileEventBody,
  visitorId: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<EventOutcome> {
  if (body.type === "forget") return handleForget(env, siteId, settings, visitorId);
  let goalId: string;
  try {
    const version = await loadActiveVersion(env, siteId);
    const config = version === null ? null : await loadConfig(env, siteId, version);
    if (!config || !config.needsProfile) return "ignored"; // goal は DO namespace にも触れない(r2 CX-Medium-9)
    if (!config.goals.some((g) => g.id === body.goalId)) return "ignored";
    goalId = body.goalId;
  } catch (e) {
    console.error("wtt: profile event failed", e);
    return "failed";
  }
  const budget = settings.newProfileBudget;
  const counter = budget ? newProfileCounterFor(env) : null;
  const allowCreate = counter && budget ? counter.canCreate(siteId, budget, Date.now(), waitUntil) : true;
  try {
    // deploy の切り替わりの間は古い DO の形(値なし)が返りうるので readRecordGoalOut で読む
    const { created } = readRecordGoalOut(await profileStub(env, siteId, visitorId).recordGoal(goalId, settings.retentionDays, Math.floor(Date.now() / 1000), allowCreate));
    if (counter && budget && allowCreate) counter.record(siteId, budget, created ? "created" : "not_created", Date.now(), waitUntil);
    return "recorded"; // 予算が尽きた後の新しい ID(保存していない)も同じ 204
  } catch (e) {
    if (counter && budget && allowCreate) counter.record(siteId, budget, "failed", Date.now(), waitUntil);
    console.error("wtt: profile event failed", e);
    return "failed";
  }
}

/**
 * forget: Profile(DO)の削除と、計測用 D1 の行の削除(D9 ② K13)をそれぞれ別の例外境界で両方試す。
 * 一方の失敗で他方を飛ばさない。応答は今のとおり Profile の結果だけで決める(計測用 D1 の失敗はログだけ。forgetResults が握る)。
 * 計測用 D1 の削除は `forgetOnRevoke !== false` のときだけ。応答が「消した」と約束するので waitUntil に回さず待つ(数行)
 */
async function handleForget(env: Env, siteId: string, settings: SiteSettings, visitorId: string): Promise<EventOutcome> {
  let outcome: EventOutcome = "recorded";
  try {
    await profileStub(env, siteId, visitorId).forget(); // config を見ない(決定 37 の r1 追記 C)
  } catch (e) {
    console.error("wtt: profile event failed", e);
    outcome = "failed";
  }
  if (settings.forgetOnRevoke !== false) await forgetResults(env, siteId, visitorId);
  return outcome;
}
