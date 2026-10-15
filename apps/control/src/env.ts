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
};
