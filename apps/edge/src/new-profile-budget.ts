import { DurableObject } from "cloudflare:workers";
import { utcDay } from "@wtt/core";
import type { Env } from "./env";

/**
 * 新しい訪問者の Profile の予算(決定 63 (8)・(13)(i)。plan12 K9)。SQLite の DO で、名前は 2 種類・同じクラス:
 * `site:<siteId>`(サイトの予算)と `instance`(導入全体の予算。Free のときだけ使う)。
 *
 * edge の isolate の数え役(new-profile-counter.ts)が、作った後の件数をまとめて報告する(作る前に許可を取る形ではない)。
 * 上限は報告ごとに受け取り、DO は覚えない(上限を上げても下げても、次の報告・聞き直しで今の上限と比べ直す)。
 *
 * タイマー(alarm)は使わない。古い窓の行は報告のたびに消す。各 RPC は await を挟まない同期の SQL だけで書くので、
 * 1 つの呼び出しの中の読みと書きの間に別の呼び出しが割り込まない(results-budget.ts と同じ)
 */

export type NewProfileLimits = { perHour: number; perDay: number };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** 窓の行を残す日数(今日と、境目をまたいで遅れて届く報告に足りればよい) */
const KEEP_DAYS = 2;
const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertKey(key: string, re: RegExp, start: (k: string) => number): void {
  if (typeof key !== "string" || !re.test(key) || Number.isNaN(start(key))) throw new TypeError(`invalid window key: ${key}`);
}
function assertCount(n: number, min: number): void {
  if (!Number.isSafeInteger(n) || n < min) throw new TypeError(`invalid count: ${n}`);
}
/** 時の窓の始まり(`YYYY-MM-DDTHH` の UTC) */
const hourStart = (hour: string): number => Date.parse(`${hour}:00:00Z`);
/** 日の窓の始まり(`YYYY-MM-DD` の UTC 0 時) */
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export class NewProfileBudget extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // key = 時(`YYYY-MM-DDTHH`)か日(`YYYY-MM-DD`)。同じ表に両方を置く
    this.sql.exec(`CREATE TABLE IF NOT EXISTS windows (key TEXT PRIMARY KEY, used INTEGER NOT NULL)`);
  }

  /**
   * `count` を時と日の両方の窓に足し、どちらかが上限以上なら、尽きた窓の終わりを返す
   * (日が尽きていれば次の UTC 0 時、時だけなら次の 0 分)。尽きていなければ null。
   * `count` が 0 の報告(止まっている isolate の聞き直し)は足さずに、今の数と上限を比べるだけ。
   * 鍵は isolate が報告を出した時刻で決めたもの。窓の終わりは鍵から計算する(`now` は古い行の掃除にだけ使う)
   */
  async report(hour: string, day: string, count: number, limits: NewProfileLimits, now: number): Promise<{ exhaustedUntil: number | null }> {
    assertKey(hour, HOUR_RE, hourStart);
    assertKey(day, DAY_RE, dayStart);
    assertCount(count, 0);
    assertCount(limits?.perHour, 1);
    assertCount(limits?.perDay, 1);
    if (!Number.isFinite(now)) throw new TypeError(`invalid time: ${now}`);
    // 2 日より前の窓を消す。時の鍵も日の鍵も文字列の比較で日付順に並ぶ(`2026-10-17T05` < `2026-10-18` <= `2026-10-18T00`)
    this.sql.exec(`DELETE FROM windows WHERE key < ?`, utcDay(now - KEEP_DAYS * DAY_MS));
    if (count > 0) {
      const add = `INSERT INTO windows (key, used) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET used = used + excluded.used`;
      this.sql.exec(add, hour, count);
      this.sql.exec(add, day, count);
    }
    const used = (key: string): number => this.sql.exec<{ used: number }>(`SELECT used FROM windows WHERE key = ?`, key).toArray()[0]?.used ?? 0;
    // 日を先に見る(時が変わっても、日が尽きていれば次の UTC 0 時まで尽きたまま)
    if (used(day) >= limits.perDay) return { exhaustedUntil: dayStart(day) + DAY_MS };
    if (used(hour) >= limits.perHour) return { exhaustedUntil: hourStart(hour) + HOUR_MS };
    return { exhaustedUntil: null };
  }
}

/**
 * 送り先の DO。binding が無い(古い wrangler.jsonc のまま deploy した)ときは throw し、数え役はそれを報告の失敗として扱う
 * (数は手元に戻し、止めない = fail-open。予算は認可ではない)
 */
export function newProfileBudgetStub(env: Env, dest: "site" | "instance", siteId: string): DurableObjectStub<NewProfileBudget> {
  const ns = env.NEW_PROFILE_BUDGET;
  if (!ns) throw new Error("NEW_PROFILE_BUDGET binding is missing");
  return ns.get(ns.idFromName(dest === "site" ? `site:${siteId}` : "instance"));
}
