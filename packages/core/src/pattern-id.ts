/**
 * パターン ID(決定 49、設計書 §4.4)。保存する形の閲覧の条件(`page`)から、compile(Publish)が配る形の `patterns` のキーを決める。
 * 拡張に備えた 3 つの決まり: (1) 入力は一致の仕方(part / op / value)だけ。回数・期間は入れない(足しても ID が変わらず回数が使える)
 * (2) 版の番号付き・既定値(part = url)を省いた正規化した形 (3) 一致の仕方が変われば別の ID(= 数え直し)。
 * 形式を変えると既存の閲覧回数がすべて数え直しになるので、変えるときは版の番号を上げる
 */
import { toBase64Url } from "./id";
import { normalizePageMatch, type PageMatchInput } from "./page-normalize";
import { sha256 } from "./sha256";

export const PATTERN_ID_FORMAT = "v1";

/** ハッシュの入力(テストと調査用に公開する) */
export function patternKey(m: PageMatchInput): string {
  const n = normalizePageMatch(m);
  return [PATTERN_ID_FORMAT, ...(n.part !== undefined && n.part !== "url" ? [`part=${n.part}`] : []), n.op, n.value].join("\u0000");
}

/** `p_` + base64url(SHA-256(入力)) の先頭 16 字(96 bit。1 Site の数百のパターンでは衝突は無視できる) */
export function patternIdOf(m: PageMatchInput): string {
  return `p_${toBase64Url(sha256(new TextEncoder().encode(patternKey(m)))).slice(0, 16)}`;
}
