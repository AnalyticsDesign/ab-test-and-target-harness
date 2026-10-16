import type { CompiledConfig } from "./schema";
import { toRuntimeSettings, type SiteSettings } from "./settings";

/**
 * 決定 50: bootstrap(`/s/<siteId>.js` の応答)の大きさの上限。全体は新しい接続の最初の往復(初期ウィンドウ 約 14KB)に収める。
 * runtime はどの Site でも同じ固定の部分で、全体 − HTTP ヘッダの見込み − ふつうの config(約 2.5KB)= 11KB。
 * runtimeGzipMax は packages/runtime/scripts/embed.mjs の RUNTIME_GZIP_MAX と同じ値(bake.test.ts が照合する)。
 * 上限を変えたくなったら、本体 spec の決定 50 (6) から始める(前提が変わったか / 同期で読まなくてよいコードを外し尽くしたか)
 */
export const BOOTSTRAP_LIMITS = { totalBytes: 14336, headerAllowance: 512, runtimeGzipMax: 11264 } as const;

/** previewSource = 下書きの bootstrap だけ(決定 50)。apiBase = edge の公開 origin(決定 52 (7))。runtimeHash = 先頭の注釈に出す(更新の確認用) */
export type BakeOptions = { previewSource?: string; apiBase?: string | null; runtimeHash?: string };

/**
 * spec §9.4 / §5.4 / §20: runtime.js + compiled config + Identity 設定(runtime 向けサブセット)を 1 ファイルに連結する純関数。
 * KV / R2 / API へのアクセスは呼び出し側(デプロイ専用の Worker・control の下書きの bootstrap とサイズの警告)。決定 52
 * previewSource(決定 50)は下書きの bootstrap(control の draft-bootstrap)だけが渡す。本番の bootstrap はプレビューを別ファイルから読む。
 * 出力形式(options なし)は edge の serveBootstrap が Plan 3 まで生成していた body と同一(bootstrap.test.ts が固定する)
 */
export function bakeBootstrap(config: CompiledConfig, settings: SiteSettings, runtimeSource: string, opts: BakeOptions = {}): string {
  const boot = JSON.stringify({ config, settings: toRuntimeSettings(settings), ...(opts.apiBase ? { apiBase: opts.apiBase } : {}) });
  const preview = opts.previewSource === undefined ? "" : `${opts.previewSource}\n`;
  const runtime = opts.runtimeHash ? `, runtime ${opts.runtimeHash}` : "";
  return `/* AB Test and Target Harness bootstrap (site ${config.siteId}, config v${config.version}${runtime}) */\n${preview}self.__WTT_BOOT__=${boot};\n${runtimeSource}`;
}
