/**
 * 決定 52: 配信専用の Worker の asset を作るためのヘルパ。Workers と Node の両方で動く(手元の setup-static と DO が共有する)。
 * ハッシュの規則は wrangler と同じ(公式「Direct Uploads」の例: sha256(base64Content + extension).slice(0, 32))
 */

/** UTF-8 のバイト列を base64 にする。String.fromCharCode の引数の上限を超えないよう 32KB ずつ */
export function toBase64(text: string): { b64: string; size: number } {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin), size: bytes.length };
}

/** asset のハッシュ。ext はドットなし(`js`) */
export async function assetHash(b64: string, ext: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b64 + ext));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export type ManifestEntry = { hash: string; size: number };
/** キーは先頭の / を含むパス(`/s/<siteId>.js`) */
export type Manifest = Record<string, ManifestEntry>;

/** 前回のデプロイと中身が同じかを比べるための、順序に依存しない文字列 */
export function manifestKey(m: Manifest): string {
  return Object.keys(m)
    .sort()
    .map((p) => `${p}\u0000${m[p]!.hash}`)
    .join("\n");
}
