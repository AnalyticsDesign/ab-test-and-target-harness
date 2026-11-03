"use client";

import { API_CONTRACT_VERSION, CLIENT_VERSION_HEADER } from "@wtt/core";

/** control の封筒(spec §13.5 決定 34): `{ error, message, hint?, path?, ...details }`。message / hint は日本語 */
export type ErrorEnvelope = {
  error?: string;
  message?: string;
  hint?: string;
  // control の封筒は `path` を**必ず配列**で出す(spec §13.5 / `ErrorEnvelopeSchema`)。
  // `invalid_analytics` / `invalid_settings` もいまは `validationFailed()` 経由なので配列。
  // ここで文字列も許すのは UI 境界の防御(`fieldErrors` が何を渡されても throw しない)であって、
  // control 側の契約の説明ではない
  path?: (string | number)[] | string;
  issues?: Array<{ path: (string | number)[] | string; message: string }>;
  required?: string;
  [key: string]: unknown;
};

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, public extra: ErrorEnvelope) {
    super(code);
    this.name = "ApiClientError";
  }
}

/**
 * plan12 K3: ブラウザの JS が BFF に送る要求はすべて、この画面(JS)が作られた時点の API 契約の版を名乗る。
 * BFF は自分とこの値の小さいほうを control に名乗るので、admin を更新した後も開いたままの古いタブ(名乗らない = 0)の書き込みは
 * control が 426 で止める。宛先が判定の対象外でも必ず付ける約束(付け忘れは test/control-headers.test.ts が止める)
 */
export function browserVersionHeaders(): Record<string, string> {
  return { [CLIENT_VERSION_HEADER]: String(API_CONTRACT_VERSION) };
}

/** ブラウザは同一オリジンの BFF だけを叩く(spec §13.4)。非 2xx は ApiClientError */
export async function api<T = unknown>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const isForm = body instanceof FormData;
  // FormData は content-type を付けない(boundary はブラウザに任せる)。版は呼び出し元の headers でも上書きさせない
  const contentType: Record<string, string> = isForm || body === undefined ? {} : { "content-type": "application/json" };
  const res = await fetch(`/api/control${path}`, {
    method,
    headers: { ...contentType, ...(init.headers as Record<string, string> | undefined), ...browserVersionHeaders() },
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    // 打ち切りの合図(BusyScope の 30 秒の上限が使う)。渡さなければ undefined で、これまでと同じ
    signal: init.signal,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiClientError(res.status, (data as ErrorEnvelope | null)?.error ?? `http_${res.status}`, (data as ErrorEnvelope | null) ?? {});
  return data as T;
}

/**
 * 封筒を画面に出す 1 行にする。control の `message`(日本語・必須)と `hint`(日本語・任意)をそのまま使い、
 * どちらも無いときだけ汎用文に落とす。コードごとの文言をクライアントに持たない(サーバーが唯一の出どころ)
 */
export function describeError(e: unknown): string {
  if (!(e instanceof ApiClientError)) return e instanceof Error ? e.message : String(e);
  const { message, hint } = e.extra;
  const text = [message, hint].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ");
  return text || `エラーが発生しました(${e.code})`;
}

/**
 * 422 validation_failed の `issues` を「フィールド名 → メッセージ」に畳む(Field に渡して項目の下に出す)。
 * path は配列なので `analytics.exposure.event` のようなドット区切りに直す。issues が無い封筒は `path` 単体で拾う。
 *
 * `path` は control のどの 422 でも配列(spec §13.5)。`invalid_analytics` / `invalid_settings` はかつて
 * ドット区切りの文字列を積んでいたが、いまは `validationFailed()` 経由なので配列に揃っている
 * (apps/control/src/site-settings.ts。`expectEnvelope` が `ErrorEnvelopeSchema` で固定している)。
 * 下の `String(issue.path)` は**その頃の名残ではなく**、配列以外が来ても `.join` で落ちないための
 * UI 境界の防御として残してある。配列でも文字列でも同じキーに正規化する
 */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiClientError)) return {};
  const out: Record<string, string> = {};
  const issues = e.extra.issues ?? (e.extra.path ? [{ path: e.extra.path, message: e.extra.message ?? "" }] : []);
  for (const issue of issues) {
    const key = Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path ?? "");
    if (key && !(key in out)) out[key] = issue.message;
  }
  return out;
}
