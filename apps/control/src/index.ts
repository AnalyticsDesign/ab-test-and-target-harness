import { WorkerEntrypoint } from "cloudflare:workers";
import { CRON_JOBS } from "./cron/jobs";
import { runCron } from "./cron/runner";
import type { Env } from "./env";
import { app } from "./app-routes";
import { markFromBff } from "./bff-entry";
import { stripTrustedHeaders } from "./trusted-headers";

// ルートの登録は app-routes.ts(Node のスクリプトが読めるよう cloudflare:workers に依存させない。plan12 K7)。
// テストは `import { app } from "../src/index"` で読むので再 export する。
// binding で向けてよい入口は ControlBff だけ。app には何も binding で向けない(公開の入口が通す stripTrustedHeaders を通らず、
// 送り手が付けた x-wtt-client-ip をそのまま信用してしまうため)
export { app };

/**
 * admin の service binding(wrangler.jsonc の entrypoint: "ControlBff")だけが入る入口(plan12 K8 / 決定 63 (6))。
 * 公開の URL からは届かないので、admin が付ける `x-wtt-client-ip`(利用者の IP)を信用してレート制限の鍵に使う(app.ts)。
 * service binding 経由の要求には cf-connecting-ip が付かない(Task 1 の実測)ため、このヘッダーが利用者ごとの枠の唯一の手がかりになる
 */
export class ControlBff extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    // Q528: 管理画面のログアウトの sign-out をレート制限で数えないための印(app.ts)。ヘッダーではないので公開の入口からは付けられない
    return Promise.resolve(app.fetch(markFromBff(req), this.env, this.ctx));
  }
}

/**
 * Worker の入口(公開の URL)。HTTP は Hono の app、Cron は runCron(テストは名前付きの export の app を使う)。
 * 公開の入口は admin 以外の誰でも叩けるので、信用するヘッダー(x-wtt-client-ip)は必ず消してから app へ渡す
 */
export default {
  fetch: (req, env, ctx) => app.fetch(stripTrustedHeaders(req), env, ctx),
  // D9 ②(plan ② の K5): 15 分ごとの Cron(wrangler.jsonc の triggers)。ジョブは cron/jobs.ts の登録表
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env, controller.scheduledTime, CRON_JOBS));
  },
} satisfies ExportedHandler<Env>;
