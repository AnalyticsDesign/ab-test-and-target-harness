export type Env = {
  DB: D1Database;
  CONFIG_KV: KVNamespace;
  /** R2(画像)。導入で r2_buckets を書かなければ undefined = 画像アップロードと IMAGE Change は無効(capabilities.ts の imageStore) */
  ASSETS?: R2Bucket;
  AUTH_RATE_LIMITER: RateLimit;
  BETTER_AUTH_SECRET: string;
  /** 初回セットアップ専用。OWNER 作成後は無効(user が 1 件でもあれば拒否) */
  AB_SETUP_TOKEN?: string;
  AB_ADMIN_URL: string;
  AB_CONTROL_URL: string;
  /** Google の OAuth クライアント(決定 46)。ID は var、secret は secret。どちらか欠けると Google ログインは 503 */
  AB_GOOGLE_CLIENT_ID?: string;
  AB_GOOGLE_CLIENT_SECRET?: string;
  /** 決定 46 (2)(3): この secret があるとき(16 文字以上)だけメール + パスワードの経路が開く。普段は置かない */
  AB_BREAK_GLASS_TOKEN?: string;
  /** R2 公開ベース URL(spec §13.7)。IMAGE の src はこの配下のみ許可。R2 なし構成では不要・無視(決定 43 (4)) */
  AB_ASSET_PUBLIC_BASE?: string;
  AB_ASSET_MAX_MB?: string;
  /** edge の公開 origin(決定 44 (4)。導入時に必ず書く。bootstrap に焼く API の宛先にも使う)。ホストが .workers.dev ならドメインなし構成 */
  AB_EDGE_ORIGIN?: string;
  /**
   * 使用状況(backlog D10)。Account Analytics: Read だけの API トークン(secret)と、Cloudflare のアカウント ID(var)。
   * どちらか欠けると GET /usage は 503 usage_not_configured
   */
  CF_USAGE_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** 本製品の資源(内訳に出す)。{ workers: string[], d1: [{ id, name }], kv: [{ id, name }] }。無ければ Worker 名の既定だけ */
  AB_USAGE_RESOURCES?: unknown;
  /**
   * 決定 52: デプロイ専用の Worker(Service Binding の RPC)。本番では必ず設定する。
   * 無ければ出し直しは skipped(vitest だけ。wrangler dev は wrangler.jsonc の services で binding が「ある」ことになり、
   * 届かない binding への呼び出しは失敗して pending になる)。ローカル開発は `pnpm control:dev` が同じプロセスでデプロイ専用の Worker を動かす
   * (admin E2E と同じ。向き先は偽の Cloudflare API で、本物には届かない。README のローカル起動)
   */
  DEPLOYER?: import("@wtt/core").StaticDeployer;
  /** 設置タグの origin(配信専用の Worker の公開 origin)。省略時は AB_EDGE_ORIGIN と同じ(同じホストの Route 構成) */
  AB_STATIC_ORIGIN?: string;
  /**
   * D9(設計書 §6.6): 計測用 D1(wtt-results。テストの結果の個票)。無ければ Site で結果の記録を有効にできない(capabilities.ts の resultsStore)。
   * 表の形の正は edge の results-migrations/(control は読み取りと削除だけ)。③ から wrangler.jsonc に書く(plan ③ の K5)。
   * 古い wrangler.jsonc のままの導入では無い(optional のまま)
   */
  RESULTS_DB?: D1Database;
  /**
   * D9 ②(plan ② の K12)・③(K12・K13・K18): edge の結果の予算の DO(script 間の binding。wrangler.jsonc の script_name = wtt-edge。idFromName("global"))。
   * Cron の results-account-guard が使用量で収集を止め、③ は個票の削除の枠(lease)・読み取りの予約(reserveRead / settleRead)・停止の期間を使う。
   * 無ければそれらは何もしない(vitest の既定は無し。test/helpers.ts の fakeResultsBudget を envOverride で渡す)
   */
  RESULTS_BUDGET?: DurableObjectNamespace<ResultsBudgetRpc>;
  /**
   * D9 ③(plan ③ の K5): edge の収集の失敗の記録の DO(script 間の binding。Site ごと = idFromName(siteId))。
   * 結果の画面の「収集できなかった送信」を読む。無ければ失敗の回数は読めない(vitest の既定は無し。fakeResultsHealth を渡す)
   */
  RESULTS_HEALTH?: DurableObjectNamespace<ResultsHealthRpc>;
};

/**
 * edge の ResultsBudget(apps/edge/src/results-budget.ts)の公開の形の写し。edge の型を control に持ち込まず、core にも置かない
 * (plan ② の Task 12・plan ③ の K5)。edge の引数・戻り値の形を変えたらここも直す
 */
export type StopReason = "write_budget" | "d1_limit" | "account_usage" | "capacity";
export type LeaseResult = { ok: true; day: string; rows: number } | { ok: false; stoppedUntil: number };
export type ReadReservation = { ok: true; token: string; expiresAt: number } | { ok: false; reason: "budget" | "busy" };
export type StopPeriod = { reason: StopReason; from: number; to: number };
export type BudgetStatus = {
  day: string;
  writeBudget: number;
  writeUsed: number;
  readBudget: number;
  readUsed: number;
  leaseRows: number;
  /** 今かかっている停止の終わり(停止中でなければ null) */
  stoppedUntil: number | null;
  /** 解けていない読み取りの予約(期限切れ・精算済みは含めない) */
  readReservation: { day: string; rows: number; expiresAt: number } | null;
};

export interface ResultsBudgetRpc extends Rpc.DurableObjectBranded {
  stop(reason: StopReason, until: number, now: number): Promise<void>;
  /** 書き込みの枠を受け取る。停止中・予算が尽きていれば ok: false。残りが少なければ残りだけを配る(残りすべてを配ると write_budget の停止が立つ) */
  lease(day: string, rows: number, now: number): Promise<LeaseResult>;
  /** 読み取りの見込みの行数を予約する(導入全体で同時に 1 つ、60 秒で自動で解く) */
  reserveRead(day: string, rows: number, now: number): Promise<ReadReservation>;
  /** 予約を実際の行数で精算する(同じ token の 2 回目・知らない token は何もしない) */
  settleRead(token: string, actualRows: number): Promise<void>;
  status(now: number): Promise<BudgetStatus>;
  /** [from, to) に重なる停止の期間 */
  stopPeriods(from: number, to: number): Promise<StopPeriod[]>;
}

/** edge の ResultsHealth(apps/edge/src/results-health.ts)の公開の形の写し(plan ③ の K5) */
export interface ResultsHealthRpc extends Rpc.DurableObjectBranded {
  /** run の `[fromHour, toHour)` の時ごとの失敗の回数(時の昇順。失敗の無い時は含めない) */
  read(runId: string, fromHour: number, toHour: number): Promise<Array<{ hour: number; failed: number }>>;
}
