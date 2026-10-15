"use client";

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

/** ブラウザは同一オリジンの BFF だけを叩く(spec §13.4)。非 2xx は ApiClientError */
export async function api<T = unknown>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api/control${path}`, {
    method,
    headers: isForm || body === undefined ? init.headers : { "content-type": "application/json", ...(init.headers as Record<string, string>) },
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
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
