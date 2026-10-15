import type { EventBody, SiteSettings } from "@wtt/core";
import type { Env } from "./env";
import { profileStub } from "./profile";
import { loadActiveVersion, loadConfig } from "./store";

export type EventOutcome = "recorded" | "ignored" | "failed";

/**
 * spec §9.2: `goal` は Profile の count を加算、`forget` は deleteAll。
 * `goal` が DO に触れない条件(ストレージ汚染とコストの防御): active config が無い / needsProfile=false / 未知の goalId。
 * `forget` は config を見ずに常に届ける(決定 37 の r1 追記、ユーザー選択 C): 履歴条件の実験を止めた後(needsProfile=false)や
 * config が一時的に読めない瞬間の撤回でも「撤回 = 消える」を守る。空の DO への deleteAll は storage も alarm も残さず、
 * 露出は decision 経路(既に URL 一致だけで DO を起こせる)より 1 件あたり安い。
 * 応答は呼び出し側が常に 204(ignored も 204)、failed は 503
 */
export async function handleEvent(env: Env, siteId: string, settings: SiteSettings, body: EventBody, visitorId: string): Promise<EventOutcome> {
  try {
    if (body.type === "forget") {
      await profileStub(env, siteId, visitorId).forget(); // config を見ない(決定 37 の r1 追記 C)
      return "recorded";
    }
    const version = await loadActiveVersion(env, siteId);
    const config = version === null ? null : await loadConfig(env, siteId, version);
    if (!config || !config.needsProfile) return "ignored"; // goal は DO namespace にも触れない(r2 CX-Medium-9)
    if (!config.goals.some((g) => g.id === body.goalId)) return "ignored";
    await profileStub(env, siteId, visitorId).recordGoal(body.goalId, settings.retentionDays, Math.floor(Date.now() / 1000));
    return "recorded";
  } catch (e) {
    console.error("wtt: profile event failed", e);
    return "failed";
  }
}
