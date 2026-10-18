import type { VisitorProfile } from "./profile";
import type { ResultsBudget } from "./results-budget";
import type { ResultsHealth } from "./results-health";

/** Rate Limiting binding(spec 決定 12)。ローカルで binding が無くても動くよう optional(fail-open は Task 9) */
export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type Env = {
  CONFIG_KV: KVNamespace;
  DECISION_RATE_LIMITER?: RateLimiter;
  /** spec §8: Visitor Profile(Plan 5)。テストは stub オブジェクトで差し替えて「非接触」を数える */
  VISITOR_PROFILE: DurableObjectNamespace<VisitorProfile>;
  /**
   * 結果の書き込み・読み取りの日次の予算(D9 ② K10)。導入全体で 1 つ(idFromName("global"))。
   * wrangler.jsonc には常にあるが、型は optional にして、無いときは結果を書かない(budgetStub が throw → LeaseHolder が unreachable → failed)
   */
  RESULTS_BUDGET?: DurableObjectNamespace<ResultsBudget>;
  /**
   * 収集の失敗の記録(D9 ② K11)。Site ごと(idFromName(siteId))。wrangler.jsonc には常にあるが、型は optional にして、
   * 無いときは失敗を数えないだけにする(HealthBuffer が捨てる。リクエストの経路は止めない)
   */
  RESULTS_HEALTH?: DurableObjectNamespace<ResultsHealth>;
  /** 計測用 D1(wtt-results。設計書 §6.4)。無ければ結果は書かない(fail-closed) */
  RESULTS_DB?: D1Database;
  /** 訪問者 ID を HMAC するための鍵(base64。復号して 32 バイト以上)。edge の secret で、無ければ結果は書かない(fail-closed) */
  RESULTS_VISITOR_KEY?: string;
  /** 結果の収集の予算(文字列の整数。省略時は @wtt/core の RESULTS_BUDGET_DEFAULTS。設計書 §6.9) */
  RESULTS_WRITE_BUDGET?: string;
  RESULTS_READ_BUDGET?: string;
  RESULTS_LEASE_ROWS?: string;
};
