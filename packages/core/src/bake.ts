import bootstrapLimits from "./bootstrap-limits.json";
import type { CompiledConfig } from "./schema";
import { toRuntimeSettings, type RuntimeSettings, type SiteSettings } from "./settings";

// 決定 50: Publish の警告用。runtime の CI 停止線にサイト設定の 2 KiB とヘッダ見込みを足す。
// 判定に使う gzip は、実際の配信で選ばれる圧縮方式やヘッダを含む転送量の代理値。
const headerAllowance = 512;
export const BOOTSTRAP_LIMITS = {
  totalBytes: bootstrapLimits.runtimeGzipMax + 2 * 1024 + headerAllowance,
  headerAllowance,
  runtimeGzipMax: bootstrapLimits.runtimeGzipMax,
} as const;

/** previewSource = 下書きの bootstrap だけ(決定 50)。apiBase = edge の公開 origin(決定 52 (7))。runtimeHash = 先頭の注釈に出す(更新の確認用) */
export type BakeOptions = { previewSource?: string; apiBase?: string | null; runtimeHash?: string };

/**
 * bootstrap に焼く boot payload(`self.__WTT_BOOT__` の中身)。`bakeBootstrap` と `staticInputDigest`(static-deploy.ts)が共有する。
 * 版 3 の config は名前を持たない(名前付きの版 2 は parseCompiledConfig の upgradeV2 が payload に移して落とす。B69)。settings は runtime 向けサブセット(toRuntimeSettings)だけ。
 * apiBase は値があるときだけ入れる(null・空文字・省略は入れない)
 */
export function bootPayload(
  config: CompiledConfig,
  settings: SiteSettings,
  apiBase?: string | null,
): { config: CompiledConfig; settings: RuntimeSettings; apiBase?: string } {
  return { config, settings: toRuntimeSettings(settings), ...(apiBase ? { apiBase } : {}) };
}

/**
 * spec §9.4 / §5.4 / §20: runtime.js + compiled config + Identity 設定(runtime 向けサブセット)を 1 ファイルに連結する純関数。
 * KV / R2 / API へのアクセスは呼び出し側(デプロイ専用の Worker・control の下書きの bootstrap とサイズの警告)。決定 52
 * previewSource(決定 50)は下書きの bootstrap(control の draft-bootstrap)だけが渡す。本番の bootstrap はプレビューを別ファイルから読む。
 * 版 2 の config は parseCompiledConfig で版 3 にしてから渡す(B69)。
 * 出力形式(options なし)は edge の serveBootstrap が Plan 3 まで生成していた body と同一(bootstrap.test.ts が固定する)
 */
export function bakeBootstrap(config: CompiledConfig, settings: SiteSettings, runtimeSource: string, opts: BakeOptions = {}): string {
  const boot = JSON.stringify(bootPayload(config, settings, opts.apiBase));
  const preview = opts.previewSource === undefined ? "" : `${opts.previewSource}\n`;
  const runtime = opts.runtimeHash ? `, runtime ${opts.runtimeHash}` : "";
  return `/* AB Test and Target Harness bootstrap (site ${config.siteId}, config v${config.version}${runtime}) */\n${preview}self.__WTT_BOOT__=${boot};\n${runtimeSource}`;
}
