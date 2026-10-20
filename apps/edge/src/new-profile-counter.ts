import { newProfileLimits, utcDay, utcHourKey, type NewProfileBudget } from "@wtt/core";
import type { Env } from "./env";
import { newProfileBudgetStub, type NewProfileLimits } from "./new-profile-budget";

/**
 * isolate の数え役(決定 63 (8)・(13)(i) と SDD の着手時の改め (一)。plan12 K9)。
 * 新しい Profile を「作った後に」数え、送り先ごと(サイトの予算の DO はサイトごと、導入全体の DO は isolate に 1 つ)に
 * まとめて予算の DO(new-profile-budget.ts)へ報告する。DO が尽きたと返したら、その窓の終わりまで止まりの印を立て、
 * 印が効いている間は新しい Profile を作らせない(canCreate が false)。
 *
 * - 作る前に許可を取らないので、応答までの DO への往復は増えない(報告はすべて waitUntil の中)。
 *   その代わり上限を少し超えうる(量は plan12 K9 の「超えうる量」)。予算の DO に届かない間は止められない(fail-open)
 * - タイマーは使わない。時刻の比較だけで判定する(報告のタイムアウトも、次の報告・聞き直しの時刻も)
 * - 止まりを解くのは、時刻(窓の終わり)と、印を立てた(伸ばした)後に始めた報告の「尽きていない」の応答だけ。
 *   印は DO が返した窓の終わりより後にならないので、止まりっぱなしになる経路は無い
 */

/** 手元がこの件数になったら報告する */
export const NEW_PROFILE_REPORT_EVERY = 5;
/** 前の報告からこの時間がたっていたら、手元が 1 件でも報告する(既存の訪問者の要求でも出る) */
export const NEW_PROFILE_REPORT_MS = 10_000;
/** 報告を始めてからこの時間がたったら、返っていなくても「報告中」とみなさない(次の報告を出せる) */
export const NEW_PROFILE_REPORT_TIMEOUT_MS = 10_000;
/** 止まりの印が効いている間、この間隔で(記録は止めたまま)予算の DO に聞き直す */
export const NEW_PROFILE_RECHECK_MS = 60_000;

export type NewProfileOutcome = "created" | "not_created" | "failed";
export type NewProfileReportResult = { exhaustedUntil: number | null };
export type NewProfileCounterDeps = {
  /** 予算の DO への報告。時と日の鍵・limits・now は報告を出した時点のもの */
  report(dest: "site" | "instance", siteId: string, hour: string, day: string, count: number, limits: NewProfileLimits, now: number): Promise<NewProfileReportResult>;
  /** 応答を受けた時刻(印を立てた時刻・次の聞き直しの時刻・続けて出す報告の鍵)。テストは手で進める時計を渡す。既定は Date.now */
  now?: () => number;
};
export type NewProfileCounter = {
  /** 同期。止まりの印が効いていれば false。印が効いていて聞き直しの時刻を過ぎていれば、聞き直しの報告を waitUntil の中で出す */
  canCreate(siteId: string, budget: NewProfileBudget, now: number, waitUntil: (p: Promise<unknown>) => void): boolean;
  /** canCreate が true のときに Profile の DO を呼んだ結果。どの outcome でも、そのあと送り先ごとに報告を出すか決める */
  record(siteId: string, budget: NewProfileBudget, outcome: NewProfileOutcome, now: number, waitUntil: (p: Promise<unknown>) => void): void;
};

/** 送り先ごとの状態。これ以外は持たない(報告の待ちや券を持たない) */
type Dest = {
  readonly kind: "site" | "instance";
  /** 手元の数(まだ報告していない、作った件数) */
  pending: number;
  /** 止まりの印。DO が返した窓の終わり(0 = 印なし)。now < stoppedUntil のとき効く */
  stoppedUntil: number;
  /** 印が効いている間に、次に聞き直す時刻 */
  recheckAt: number;
  /** 印を立てた時刻(効いている印を伸ばした応答では、その報告を始めた時刻まで進める)。これより前に始めた報告の「尽きていない」の応答では印を外さない */
  markedAt: number;
  /** 報告中の報告(始めた時刻)。報告中でなければ null。自分が始めた報告かは、この object の同一性で見分ける */
  inflight: { since: number } | null;
  /** 前の報告を出した時刻(初期値 0 = isolate で最初の 1 件はすぐ出る) */
  lastReportAt: number;
  /** 続けて出す報告に使う、最後に見た送り先の情報(サイトの ID と、その時点の予算から作った上限) */
  siteId: string;
  limits: NewProfileLimits;
};

function newDest(kind: "site" | "instance", siteId: string, limits: NewProfileLimits): Dest {
  return { kind, pending: 0, stoppedUntil: 0, recheckAt: 0, markedAt: 0, inflight: null, lastReportAt: 0, siteId, limits };
}

const stopped = (d: Dest, now: number): boolean => now < d.stoppedUntil;
const busy = (d: Dest, now: number): boolean => d.inflight !== null && now - d.inflight.since < NEW_PROFILE_REPORT_TIMEOUT_MS;
/** 聞き直しの条件: 報告中でなく、印が効いていて、聞き直しの時刻を過ぎている(手元が 0 件でも出す) */
const recheckDue = (d: Dest, now: number): boolean => !busy(d, now) && stopped(d, now) && now >= d.recheckAt;
/**
 * 報告を出す条件: 報告中でなく、手元が 1 件以上で「5 件以上」「前の報告から 10 秒」「止まりの印が効いている」のどれか、
 * または聞き直しの条件
 */
function reportDue(d: Dest, now: number): boolean {
  if (busy(d, now)) return false;
  if (d.pending >= 1 && (d.pending >= NEW_PROFILE_REPORT_EVERY || now - d.lastReportAt >= NEW_PROFILE_REPORT_MS || stopped(d, now))) return true;
  return recheckDue(d, now);
}

export function createNewProfileCounter(deps: NewProfileCounterDeps): NewProfileCounter {
  const clock = deps.now ?? Date.now;
  const sites = new Map<string, Dest>();
  let instance: Dest | null = null;

  /** 送り先を引き(無ければ作り)、続けて出す報告のために今のサイトの ID と上限を覚える */
  function siteDest(siteId: string, budget: NewProfileBudget): Dest {
    const limits = newProfileLimits(budget.perDay);
    let d = sites.get(siteId);
    if (!d) {
      d = newDest("site", siteId, limits);
      sites.set(siteId, d);
    }
    d.limits = limits;
    return d;
  }
  /** 導入全体の送り先。budget.instancePerDay が無い(Paid の)サイトでは使わない(null) */
  function instanceDest(siteId: string, budget: NewProfileBudget): Dest | null {
    if (budget.instancePerDay === undefined) return null;
    const limits = newProfileLimits(budget.instancePerDay);
    if (!instance) instance = newDest("instance", siteId, limits);
    instance.siteId = siteId;
    instance.limits = limits;
    return instance;
  }

  /**
   * 報告を出す。手元の数をそのまま count にして 0 に戻し、報告中にする。時と日の鍵はこの時刻で決める。
   * 印が効いている間に出す報告(聞き直し)は、送るときにも次の聞き直しの時刻を進める(応答が返らない間も、
   * タイムアウトの 10 秒ごとではなく 1 分に 1 本に保つ。応答を受けたら、応答の時刻から数え直す)
   */
  function start(d: Dest, now: number): Promise<void> {
    const count = d.pending;
    d.pending = 0;
    const mine = { since: now };
    d.inflight = mine;
    d.lastReportAt = now;
    if (stopped(d, now)) d.recheckAt = now + NEW_PROFILE_RECHECK_MS;
    return run(d, mine, count, now);
  }

  async function run(d: Dest, mine: { since: number }, count: number, startedAt: number): Promise<void> {
    let res: NewProfileReportResult;
    try {
      res = await deps.report(d.kind, d.siteId, utcHourKey(startedAt), utcDay(startedAt), count, d.limits, startedAt);
    } catch (e) {
      // 失敗(遅れて届いた失敗も): 数を手元に足し戻す。DO が足した後に応答だけが失敗した場合は二重に数えるが、止める側なので許す。
      // 印は変えず、効いていれば 1 分後に聞き直す。続けては出さない(すぐ失敗が返る障害の間に送り直しが止まらなくなるため)
      const now = clock();
      d.pending += count;
      if (d.inflight === mine) d.inflight = null;
      if (stopped(d, now)) d.recheckAt = now + NEW_PROFILE_RECHECK_MS;
      console.error("wtt-edge: new profile budget report failed (counts kept, not stopping)", e);
      return;
    }
    const now = clock();
    if (d.inflight === mine) d.inflight = null; // タイムアウトの後に新しい報告が始まっていたら触らない
    const until = res?.exhaustedUntil ?? null;
    if (until !== null) {
      // 尽きた: 印を立てる。効いている印は早い値で縮めない。
      // 効いている印を伸ばすときは、印を立てた時刻もこの報告を始めた時刻まで進める(この報告より前に始めてタイムアウトした
      // 報告の遅い null で、DO がいま尽きたと言っている印を外さないため)。切れていたときは応答の時刻を記録する
      if (stopped(d, now)) {
        d.stoppedUntil = Math.max(d.stoppedUntil, until);
        d.markedAt = Math.max(d.markedAt, startedAt);
      } else {
        d.stoppedUntil = until;
        d.markedAt = now;
      }
      d.recheckAt = now + NEW_PROFILE_RECHECK_MS;
    } else if (startedAt >= d.markedAt) {
      // 尽きていない: 印を立てた後に始めた報告の応答だけが印を外す(印を立てる前に始めてタイムアウトした報告の遅い応答では外さない)
      d.stoppedUntil = 0;
    }
    // 成功の応答の直後に、往復の間にたまった分を次の record を待たずに出す(止まりの印を立てた応答なら、手元の残りもすぐ数える)
    if (reportDue(d, now)) await start(d, now);
  }

  function maybeReport(d: Dest, now: number, waitUntil: (p: Promise<unknown>) => void, due: (d: Dest, now: number) => boolean): void {
    if (due(d, now)) waitUntil(start(d, now));
  }

  return {
    canCreate(siteId, budget, now, waitUntil) {
      const site = siteDest(siteId, budget);
      const inst = instanceDest(siteId, budget);
      // 印が効いていて聞き直しの時刻を過ぎていれば、止めたまま聞き直す(聞き直しの間に Profile は作られない)
      maybeReport(site, now, waitUntil, recheckDue);
      if (inst) maybeReport(inst, now, waitUntil, recheckDue);
      return !stopped(site, now) && !(inst !== null && stopped(inst, now));
    },
    record(siteId, budget, outcome, now, waitUntil) {
      const site = siteDest(siteId, budget);
      const inst = instanceDest(siteId, budget);
      if (outcome === "created") {
        site.pending += 1;
        if (inst) inst.pending += 1;
      }
      // "not_created" と "failed" は手元を変えないが、10 秒たった残りや聞き直しはここからも出る
      maybeReport(site, now, waitUntil, reportDue);
      if (inst) maybeReport(inst, now, waitUntil, reportDue);
    },
  };
}

// isolate に 1 つ置く本体。report は最後に受けた要求の env の binding で予算の DO を呼ぶ(env は isolate の中で変わらない。
// テストは要求ごとに env を差し替えるので、最後の env を使う)
let isolateCounter: NewProfileCounter | null = null;
let boundEnv: Env | null = null;

/** isolate の数え役を返す(無ければ作る)。evaluateDecision / handleEvent が要求ごとに呼ぶ */
export function newProfileCounterFor(env: Env): NewProfileCounter {
  boundEnv = env;
  if (!isolateCounter) {
    isolateCounter = createNewProfileCounter({
      report: (dest, siteId, hour, day, count, limits, now) => {
        if (!boundEnv) return Promise.reject(new Error("env is not bound"));
        return newProfileBudgetStub(boundEnv, dest, siteId).report(hour, day, count, limits, now);
      },
    });
  }
  return isolateCounter;
}

/** テスト用: isolate の数え役を差し替える(null = 次の呼び出しで作り直す) */
export function __setNewProfileCounterForTests(counter: NewProfileCounter | null): void {
  isolateCounter = counter;
}
