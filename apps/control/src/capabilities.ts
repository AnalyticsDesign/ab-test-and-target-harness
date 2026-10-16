import { z } from "zod";
import { passwordLoginOpen } from "./break-glass";
import type { Env } from "./env";

/**
 * 決定 43 (4): R2 の有効 / 無効は「binding と公開ベースの両方があるときだけ有効」の 1 か所で決める。
 * アップロード・IMAGE の検証・/dev-assets・/capabilities がこれを共有する(Site 削除の後始末は binding の有無だけを見る。Task 2)。
 * binding があって公開ベースが空・不正なのは設定漏れ(公開 URL を組み立てられない)なので無効側に倒す。
 * 入力ファイルの `none` を誤って env に写した場合も URL でないので無効になる
 */
export function imageStore(env: Env): { bucket: R2Bucket; publicBase: string } | null {
  if (!env.ASSETS) return null;
  const raw = env.AB_ASSET_PUBLIC_BASE?.trim() ?? "";
  let base: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    base = u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
  if (base === "") return null;
  return { bucket: env.ASSETS, publicBase: base };
}

/** 決定 43 (2): 代替は ATTRIBUTE の src。文言は公開物なので設計記録への参照を書かない */
export const IMAGE_DISABLED_HINT =
  "画像の差し替えは ATTRIBUTE の src で行えます。有効にするには R2 バケットの binding と公開ベース URL(AB_ASSET_PUBLIC_BASE)を設定して再デプロイします";

/** 決定 44 (4): edge の公開 origin。不正な値・未設定は null(既存導入では帯を出さない) */
export function edgeOrigin(env: Env): string | null {
  const raw = env.AB_EDGE_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** 決定 52 (7) / plan K11: 設置タグの origin(配信専用の Worker)。AB_STATIC_ORIGIN が無ければ edge と同じホスト */
export function tagOrigin(env: Env): string | null {
  const raw = env.AB_STATIC_ORIGIN?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      // 不正な値は edge と同じホストとみなす
    }
  }
  return edgeOrigin(env);
}

export function edgeOnWorkersDev(env: Env): boolean {
  const origin = edgeOrigin(env);
  if (!origin) return false;
  const host = new URL(origin).hostname;
  return host === "workers.dev" || host.endsWith(".workers.dev");
}

export const CapabilitiesSchema = z.object({
  imageUpload: z.boolean().describe("画像アップロードと IMAGE の変更が使えるか(R2 と公開ベース URL が設定されているとき true)"),
  edgeOrigin: z.string().nullable().describe("edge(訪問者のブラウザが decision / event を送る先)の公開 origin。未設定なら null"),
  tagOrigin: z.string().nullable().describe("設置タグ(/s/<siteId>.js)を配る公開 origin。未設定なら null"),
  edgeOnWorkersDev: z.boolean().describe("edge を *.workers.dev で公開しているか(ゾーンの WAF・キャッシュ・Mode B(サーバー発行 Cookie)が使えない構成)"),
  passwordLogin: z.boolean().describe("メール + パスワードのログインが開いているか(非常時だけ true。普段は Google ログインのみ)"),
  writeFreeze: z
    .object({
      reason: z.string().nullable().describe("凍結の理由。null = 凍結の設定が読めない(凍結中として扱う)"),
      until: z.string().nullable().describe("再開の見込み(ISO 8601。表示だけで、過ぎても自動では外れない)"),
      since: z.number().nullable().describe("凍結を入れた時刻(epoch ミリ秒)"),
    })
    .nullable()
    .describe("書き込みの凍結(メンテナンス中)の状態。null = 凍結していない。凍結中はログイン以外の変更操作が 503 write_frozen になる"),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** env だけで決まる部分。凍結は D1 を読むのでルートで足す(writeFreeze) */
export function capabilities(env: Env): Omit<Capabilities, "writeFreeze"> {
  return { imageUpload: imageStore(env) !== null, edgeOrigin: edgeOrigin(env), tagOrigin: tagOrigin(env), edgeOnWorkersDev: edgeOnWorkersDev(env), passwordLogin: passwordLoginOpen(env) };
}
