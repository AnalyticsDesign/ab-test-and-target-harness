import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { ZodError } from "zod";

/** code ごとの既定 message(封筒の `message` は必須。spec §13.5 決定 34)。extra.message があればそちらが勝つ */
export const DEFAULT_MESSAGES: Record<string, string> = {
  usage_not_configured: "使用状況の取得が設定されていません",
  usage_upstream_failed: "Cloudflare から使用状況を取得できませんでした",
  user_not_found: "そのメールアドレスのユーザーは見つかりません",
  last_instance_admin: "最後のシステム管理者は外せません",
  instance_admin_member: "システム管理者のロールはワークスペースからは変えられません",
  already_member: "既にこのワークスペースのメンバーです",
  not_found: "リソースが見つかりません",
  forbidden: "この操作を行うロールがありません",
  bad_request: "リクエスト body を解釈できません",
  validation_failed: "入力の検証に失敗しました",
  internal: "サーバー内部エラー",
  unauthorized: "認証が必要です",
  rate_limited: "リクエストが多すぎます",
  setup_closed: "初回セットアップは既に完了しています",
  setup_failed: "初回セットアップに失敗しました",
  conflict: "リソースの状態が競合しています",
  method_not_allowed: "このメソッドは許可されていません",
  unsupported_media_type: "この Content-Type は扱えません",
  payload_too_large: "リクエストが大きすぎます",
  request_failed: "リクエストを処理できません",
  invalid_transition: "その status には遷移できません",
  image_upload_disabled: "この導入では画像アップロードと IMAGE の変更は使えません",
  google_not_configured: "Google ログインが設定されていません",
  invalid_handoff: "ログインの引き継ぎコードが無効か期限切れです",
  password_login_disabled: "パスワードでのログインは無効です",
  workspace_create_failed: "ワークスペースを作れませんでした",
  last_workspace: "最後のワークスペースは削除できません",
  workspace_has_running_experiments: "配信中のエクスペリエンスがあります",
  write_frozen: "メンテナンス中のため、変更を保存できません",
};

/**
 * API エラー。応答は常に `{ error, message, hint?, path?, ...extra }` の封筒(spec §13.5 決定 34)。
 * code は機械可読(`attribute_not_allowed` / `forbidden` / `invalid_transition` …)。extra は `attribute` / `hint` / `path` / `required` など。
 *
 * `extra.detail` だけは**サーバー専用の診断情報**(生の例外文字列や core の英語診断文)で、封筒には出さない。
 * `errorHandler` がログに残す。かつては `toBody()` が extra を丸ごと展開して `detail` も外部エージェント含む
 * 全クライアントに届いていた(rulings §4 CX-Medium-1)
 */
export class ApiError extends Error {
  readonly extra: Record<string, unknown>;
  constructor(public status: ContentfulStatusCode, public code: string, extra: Record<string, unknown> = {}) {
    super(typeof extra.message === "string" ? extra.message : DEFAULT_MESSAGES[code] ?? code);
    this.name = "ApiError";
    this.extra = extra;
  }
  toBody(): Record<string, unknown> {
    const { detail: _detail, ...publicExtra } = this.extra;
    return { error: this.code, message: this.message, ...publicExtra };
  }
}

export const notFound = () => new ApiError(404, "not_found");
/** 利用者向けの文言に出すロールの名前(画面の用語。英語の識別子は required / role / highest などのフィールドに残る) */
export const ROLE_JA: Record<string, string> = { owner: "オーナー", admin: "管理者", editor: "編集者", viewer: "閲覧者" };
export const forbidden = (required: string) => new ApiError(403, "forbidden", { required, hint: `${ROLE_JA[required] ?? required}以上のロールが必要です` });
/**
 * Standard Schema(hono-openapi の `validator` フックが渡す形)の issue。zod の `ZodError.issues` とほぼ同形だが、
 * path の要素が `PropertyKey` ではなく `{ key }` のこともある(Standard Schema の PathSegment)
 */
type StandardIssue = { readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> };

const normalizePath = (path: StandardIssue["path"]): (string | number)[] =>
  Array.from(path ?? [], (segment) => {
    const key = typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment;
    return typeof key === "number" ? key : String(key);
  });

/**
 * 検証失敗 → 422 validation_failed。path は先頭 issue、issues は全件(エージェントが 1 回で全部直せるように)。
 * `parseJson` からは `ZodError` が、`validator("json", Schema, hook)` のフックからは Standard Schema の issue 配列が渡る
 */
export const validationFailed = (err: ZodError | readonly StandardIssue[], code = "validation_failed") => {
  const issues: readonly StandardIssue[] = Array.isArray(err) ? err : (err as ZodError).issues;
  const first = issues[0];
  return new ApiError(422, code, {
    path: normalizePath(first?.path),
    // message は封筒の必須項目。issue が 1 件も無い場合は既定文に任せる(undefined を入れると JSON から消える)
    ...(first ? { message: first.message } : {}),
    issues: issues.map((i) => ({ path: normalizePath(i.path), message: i.message })),
  });
};

/** body を JSON として読み、Schema で検証する。JSON でない body → 400 bad_request、zod 失敗 → 422 validation_failed(spec §13.5 決定 34) */
export async function parseJson<T>(c: { req: { json(): Promise<unknown> } }, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: ZodError } }): Promise<T> {
  const raw = await c.req.json().catch(() => undefined);
  if (raw === undefined) throw new ApiError(400, "bad_request");
  const r = schema.safeParse(raw);
  if (!r.success) throw validationFailed(r.error);
  return r.data;
}

/**
 * フレームワークが投げる `HTTPException` の status → 封筒の code。
 * hono 本体 / ミドルウェアは status しか持たないので、意図した status を保ったまま機械可読な code を与える
 * (例: `validator("json", …)` は JSON として読めない body に HTTPException(400) を投げる → bad_request)
 */
const HTTP_EXCEPTION_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "validation_failed",
  429: "rate_limited",
};
const codeForStatus = (status: number): string => HTTP_EXCEPTION_CODES[status] ?? (status >= 500 ? "internal" : "request_failed");

export function errorHandler(err: Error, c: Context): Response {
  // 5xx は封筒を返す前に必ずサーバー側にも残す(封筒だけだと運用者が原因を追えない)
  if (err instanceof ApiError) {
    // usage_not_configured は想定内の状態(トークン未設定)。スタック付きの error にせず 1 行の warn にする
    if (err.code === "usage_not_configured") console.warn(err.code);
    // backlog D13: write_frozen も想定内の状態(作業者が入れた凍結)。どの書き込みを断ったかだけを 1 行の warn で残す
    else if (err.code === "write_frozen") console.warn(err.code, c.req.method, new URL(c.req.url).pathname);
    else if (err.status >= 500) console.error(err.code, err.extra, err);
    // 4xx でも `detail`(応答に出さない診断情報)があればログに残す。捨てると原因調査の手がかりがどこにも残らない
    else if (err.extra.detail !== undefined) console.warn(err.code, err.extra.detail);
    // backlog D13: extra.retryAfter(秒)が数値なら Retry-After ヘッダーに写す。全 code 共通の規則(いまは 503 write_frozen だけが使う)。
    // 本文の retryAfter も残すのは、MCP などを挟むと応答ヘッダーがエージェントに届かないことがあるため
    const retry = typeof err.extra.retryAfter === "number" ? { "Retry-After": String(err.extra.retryAfter) } : undefined;
    return c.json(err.toBody(), err.status, retry);
  }
  if (err instanceof HTTPException) {
    if (err.status >= 500) console.error(err);
    return c.json(new ApiError(err.status, codeForStatus(err.status)).toBody(), err.status);
  }
  console.error(err);
  return c.json(new ApiError(500, "internal").toBody(), 500);
}
