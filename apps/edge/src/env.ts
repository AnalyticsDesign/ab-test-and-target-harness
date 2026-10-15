import type { VisitorProfile } from "./profile";

/** Rate Limiting binding(spec 決定 12)。ローカルで binding が無くても動くよう optional(fail-open は Task 9) */
export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type Env = {
  CONFIG_KV: KVNamespace;
  DECISION_RATE_LIMITER?: RateLimiter;
  /** spec §8: Visitor Profile(Plan 5)。テストは stub オブジェクトで差し替えて「非接触」を数える */
  VISITOR_PROFILE: DurableObjectNamespace<VisitorProfile>;
};
