import { DurableObject } from "cloudflare:workers";
import { decide, type Experiment, type PageContext } from "@wtt/core";
import type { Env } from "./env";

/**
 * spec §8.2 の JSON にキー 1 つで保存する(書込 1 行 / decision)。retentionDays は alarm ハンドラが期限を計算するために持つ。
 * `assignments` / `goals` は掃除しない(spec §8.3 が掃除を求めるのは patterns だけ。削除済み Experiment / Goal のエントリは retention まで残る)
 */
export type ProfileRecord = {
  firstSeenAt: number; // epoch 秒
  lastSeenAt: number;
  retentionDays: number;
  goals: Record<string, { count: number; lastAt: number }>;
  pages: Record<string, { count: number; lastAt: number }>;
  assignments: Record<string, { variant: string; at: number }>;
};

/** spec §7.4: edge が URL で絞った部分集合。config 全体(最大 512KB)は渡さず、DO は KV を読まない */
export type ProfileDecideInput = {
  retentionDays: number;
  patternKeys: string[]; // config.patterns の全キー(掃除用)
  matchedPatterns: string[]; // 現在 URL に一致したパターン ID
  experiments: Experiment[]; // URL に一致した compiled Experiment
  ctx: PageContext;
  visitorId: string;
  /** 曜日・時間帯の条件の判定に使うサイトのタイムゾーン(config の timezone)。判定時刻は ctx.now(edge が決める。決定 49 §11.1) */
  timezone?: string;
};

export const PROFILE_KEY = "profile";
const DAY_SECONDS = 86400;
const nowSec = (): number => Math.floor(Date.now() / 1000);
type Dict<T> = Record<string, T>;
/**
 * 継承プロパティを持たない辞書に正規化する(r1 CX-High-3)。Goal / パターン / Experiment の ID は任意文字列なので
 * `constructor` や `__proto__` があり得る。`{}` に対する `d[id] ?? …` は Object.prototype を拾い、`d["__proto__"] = x` は
 * prototype を差し替える。Object.create(null) の上では自身のキーとしてだけ扱われる
 */
function ownDict<T>(src: Dict<T> | undefined): Dict<T> {
  const out: Dict<T> = Object.create(null);
  if (src) for (const k of Object.keys(src)) out[k] = src[k]!;
  return out;
}
/** structured clone(storage.put)に渡す前に plain object へ戻す。spread は CreateDataProperty なので `__proto__` も自身のキーのまま写る */
const plain = <T>(d: Dict<T>): Dict<T> => ({ ...d });

function emptyProfile(now: number, retentionDays: number): ProfileRecord {
  return { firstSeenAt: now, lastSeenAt: now, retentionDays, goals: ownDict(undefined), pages: ownDict(undefined), assignments: ownDict(undefined) };
}

/**
 * spec §8: Visitor Profile。ID は idFromName("<siteId>:<visitorId>")(§8.1)。生イベント・PII は保存しない。
 * 各メソッドは get + put を同一リクエスト内で済ませ(§7.4「往復は必ず 1 回」)、
 * 書込は profile 1 行 + alarm 1 行に収める(§15「5 行以内」)
 */
export class VisitorProfile extends DurableObject<Env> {
  private async load(now: number, retentionDays: number): Promise<ProfileRecord> {
    const p = await this.ctx.storage.get<ProfileRecord>(PROFILE_KEY);
    return p ? { ...p, goals: ownDict(p.goals), pages: ownDict(p.pages), assignments: ownDict(p.assignments) } : emptyProfile(now, retentionDays);
  }

  /** §8.3: アクセスのたびに lastSeenAt を更新し、alarm を lastSeenAt + retentionDays に置き直す(訪問者あたり原則 1 回だけ実行される) */
  private async save(p: ProfileRecord, now: number, retentionDays: number): Promise<void> {
    p.lastSeenAt = now;
    p.retentionDays = retentionDays;
    await this.ctx.storage.put(PROFILE_KEY, { ...p, goals: plain(p.goals), pages: plain(p.pages), assignments: plain(p.assignments) });
    await this.ctx.storage.setAlarm((now + retentionDays * DAY_SECONDS) * 1000);
  }

  /** §7.4 ④: pages 加算(評価の前)→ 掃除 → decide → persistAssignment の保存 → lastSeenAt / alarm */
  async decide(input: ProfileDecideInput): Promise<Array<{ experimentId: string; variantId: string }>> {
    const now = nowSec();
    // ページの lastAt は edge が決めた判定時刻(ctx.now、ミリ秒)。期間の条件は now - lastAt を比べるので、同じ要求の中で edge と DO の時計を
    // 混ぜない(plan ② P11)。保持期間(lastSeenAt と alarm)は最後のアクセスからの実時間なので now のまま
    const judgedAt = typeof input.ctx.now === "number" ? Math.floor(input.ctx.now / 1000) : now;
    const p = await this.load(now, input.retentionDays);
    for (const k of input.matchedPatterns) {
      const e = p.pages[k] ?? { count: 0, lastAt: 0 };
      e.count += 1;
      e.lastAt = judgedAt;
      p.pages[k] = e;
    }
    for (const k of Object.keys(p.pages)) if (!input.patternKeys.includes(k)) delete p.pages[k];
    const persisted: Record<string, string> = Object.create(null); // __proto__ を Experiment ID に持つ割当も自身のキーで core に渡す(r2 CX-High-3)
    for (const [eid, a] of Object.entries(p.assignments)) persisted[eid] = a.variant;
    const results = decide({ needsProfile: true, experiments: input.experiments, ...(input.timezone !== undefined ? { timezone: input.timezone } : {}) },input.ctx, input.visitorId, { goals: p.goals, pages: p.pages }, persisted);
    for (const r of results) {
      const exp = input.experiments.find((e) => e.id === r.experimentId);
      if (exp?.persistAssignment && p.assignments[r.experimentId]?.variant !== r.variantId) {
        p.assignments[r.experimentId] = { variant: r.variantId, at: now }; // 初回保存、または消えた Variant の上書き(§7.3)
      }
    }
    await this.save(p, now, input.retentionDays);
    return results;
  }

  /** §9.2: goals[goalId].count を加算。page_view はここでは数えない(decision 経路のみ)。at = Goal の lastAt に打つ時刻(epoch 秒。edge が決める。plan ② P11) */
  async recordGoal(goalId: string, retentionDays: number, at?: number): Promise<void> {
    const now = nowSec();
    const p = await this.load(now, retentionDays);
    const g = p.goals[goalId] ?? { count: 0, lastAt: 0 };
    g.count += 1;
    g.lastAt = at ?? now;
    p.goals[goalId] = g;
    await this.save(p, now, retentionDays);
  }

  /** §16 / 決定 37: 撤回時の削除。冪等。compatibility date 2026-02-24 以降(edge は 2026-08-01)では deleteAll() が alarm も消すが、date を下げても契約が変わらないよう明示的に deleteAlarm() も呼ぶ */
  async forget(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** §8.3: 期限が未来なら再設定、過去なら全削除。削除後は alarm を残さない(expired_profile_deletes_storage_once) */
  async alarm(): Promise<void> {
    const p = await this.ctx.storage.get<ProfileRecord>(PROFILE_KEY);
    if (!p) return;
    const deadline = p.lastSeenAt + p.retentionDays * DAY_SECONDS;
    if (deadline > nowSec()) {
      await this.ctx.storage.setAlarm(deadline * 1000);
      return;
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

/** spec §8.1: 1 訪問者 1 Site = 1 DO。名前に siteId を含めるので Site をまたいで Profile は混ざらない(cross_site_profile_isolation) */
export function profileStub(env: Env, siteId: string, visitorId: string): DurableObjectStub<VisitorProfile> {
  return env.VISITOR_PROFILE.get(env.VISITOR_PROFILE.idFromName(`${siteId}:${visitorId}`));
}
