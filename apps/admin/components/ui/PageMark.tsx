"use client";
import { useEffect } from "react";
import { normalizeUrl, reportMark, type MarkKind } from "@/lib/feedback-store";

type Search = Record<string, string | string[] | undefined>;

/**
 * サーバーのページが知っている path と searchParams から、store が比べる形の URL を作る。
 * undefined の値は除き、配列(同じ鍵が複数回付いた URL)は同じ鍵で並べる。鍵の並べ替えは normalizeUrl が行う
 * (ページが受け取る searchParams の順は、押したリンクの href と同じとは限らないため)
 */
export function markUrl(path: string, search?: Search): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search ?? {})) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  const qs = params.toString();
  return normalizeUrl(qs ? `${path}?${qs}` : path);
}

/**
 * 画面が描かれたことを store に知らせる、何も描かない印(遷移の終わり。lib/feedback-store.ts の reportMark)。
 * - サーバーのページ: path と search を渡す(ファイルの場所から決まる path)。mount 後の URL に頼らず、描いた画面自身の URL を知らせる
 * - クライアントのページ・error・not-found: path を省く。mount した時点の window.location(= 移動先)を知らせる
 * 同じ画面の読み直し(router.refresh)では URL も kind も変わらないので、再び知らせない(読み直しは遷移ではない)
 */
export function PageMark({ path, search, kind = "page" }: { path?: string; search?: Search; kind?: MarkKind }): null {
  const url = path === undefined ? null : markUrl(path, search);
  useEffect(() => {
    // window.location は effect の中でだけ読む(サーバー描画・ハイドレーションで触らない)
    reportMark({ url: url ?? normalizeUrl(window.location.pathname + window.location.search), kind });
  }, [url, kind]);
  return null;
}
