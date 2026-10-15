import type { Manifest } from "./assets";

/**
 * 決定 52: 配信専用の Worker のデプロイ(Cloudflare の REST API)。DO(本番)と手元の setup-static(導入時)が共有する。
 * API の形は公式「Direct Uploads」(2026-10-04 確認)とスパイク S2。fetch と API の base は差し替えられる(テストと admin の E2E の偽の API)
 */
export type CfApiConfig = { accountId: string; token: string; scriptName: string; apiBase?: string; fetchFn?: typeof fetch };

export class CfApiError extends Error {
  constructor(
    public step: string,
    public status: number,
    public codes: number[],
    message: string,
  ) {
    super(message);
    this.name = "CfApiError";
  }
}

const DEFAULT_API = "https://api.cloudflare.com/client/v4";

/**
 * 配信専用の Worker の名前の規則。デプロイ用のトークンはアカウント内のすべての Worker を書き換えられるので、
 * 名前を誤って wtt-edge などにしても、その Worker を 404 だけを返すスクリプトで上書きしないよう、この規則に合う名前にだけデプロイする
 */
export const STATIC_SCRIPT_NAME_RE = /^wtt-static(-[a-z0-9-]+)?$/;

type Envelope<T> = { success?: boolean; result?: T | null; errors?: Array<{ code?: number; message?: string }> };

/** 1 回の呼び出し。非 2xx・success: false・JSON でない応答は CfApiError(message にトークンを入れない) */
async function call<T>(cfg: CfApiConfig, step: string, url: string, init: RequestInit): Promise<T | null> {
  const res = await (cfg.fetchFn ?? fetch)(url, init);
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = null;
  }
  if (!res.ok || body === null || body.success === false) {
    const errors = body?.errors ?? [];
    const detail = errors.map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ").slice(0, 300);
    throw new CfApiError(step, res.status, errors.map((e) => e.code ?? 0), `${step} failed (HTTP ${res.status})${detail ? ` ${detail}` : ""}`);
  }
  return body.result ?? null;
}

export function apiBaseOf(cfg: CfApiConfig): string {
  return (cfg.apiBase ?? DEFAULT_API).replace(/\/+$/, "");
}

export type DeployInput = {
  manifest: Manifest;
  /** アップロードの準備が求めたハッシュの中身(base64) */
  contentOf: (hash: string) => Promise<string>;
  /** `_headers` の書式の文字列 */
  headersFile: string;
  /** 配信専用の Worker のスクリプト(ES module) */
  scriptSource: string;
  compatibilityDate: string;
};
export type DeployOutcome = { uploadedFiles: number; buckets: number; apiCalls: number };

/** manifest の全ファイルで版を丸ごと置き換える。アップロードは未登録のハッシュだけ(スパイク S2) */
export async function deployAssets(cfg: CfApiConfig, input: DeployInput): Promise<DeployOutcome> {
  const workers = `${apiBaseOf(cfg)}/accounts/${cfg.accountId}/workers`;
  const auth = { authorization: `Bearer ${cfg.token}` };
  let apiCalls = 0;

  // 1. アップロードの準備
  apiCalls++;
  const session = await call<{ jwt: string; buckets?: string[][] }>(cfg, "upload_session", `${workers}/scripts/${cfg.scriptName}/assets-upload-session`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ manifest: input.manifest }),
  });
  if (!session?.jwt) throw new CfApiError("upload_session", 200, [], "upload_session returned no jwt");
  let completion = session.jwt;
  const buckets = session.buckets ?? [];

  // 2. 差分のアップロード(バケットごとに 1 回。完了の応答の jwt が完了の印)
  let uploadedFiles = 0;
  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) form.append(hash, new File([await input.contentOf(hash)], hash, { type: "text/javascript" }));
    apiCalls++;
    const up = await call<{ jwt?: string }>(cfg, "upload", `${workers}/assets/upload?base64=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.jwt}` },
      body: form,
    });
    if (up?.jwt) completion = up.jwt;
    uploadedFiles += bucket.length;
  }

  // 3. スクリプトの登録。ルートと workers.dev の設定は保たれる(スパイク S2)
  const form = new FormData();
  const metadata = { main_module: "index.js", compatibility_date: input.compatibilityDate, assets: { jwt: completion, config: { _headers: input.headersFile } } };
  form.append("metadata", new File([JSON.stringify(metadata)], "metadata.json", { type: "application/json" }));
  form.append("index.js", new File([input.scriptSource], "index.js", { type: "application/javascript+module" }));
  apiCalls++;
  await call(cfg, "put_script", `${workers}/scripts/${cfg.scriptName}`, { method: "PUT", headers: auth, body: form });
  return { uploadedFiles, buckets: buckets.length, apiCalls };
}

/** 配信専用の Worker があるか(設定の取得が 404 なら無い) */
export async function scriptExists(cfg: CfApiConfig): Promise<boolean> {
  const res = await (cfg.fetchFn ?? fetch)(`${apiBaseOf(cfg)}/accounts/${cfg.accountId}/workers/scripts/${cfg.scriptName}/settings`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (res.status === 404) return false;
  if (res.ok) return true;
  throw new CfApiError("script_settings", res.status, [], `script_settings failed (HTTP ${res.status})`);
}

export async function zoneIdOf(cfg: CfApiConfig, zoneName: string): Promise<string> {
  const zones = await call<Array<{ id: string; name: string }>>(cfg, "zones", `${apiBaseOf(cfg)}/zones?name=${encodeURIComponent(zoneName)}`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  const z = zones?.find((x) => x.name === zoneName);
  if (!z) throw new CfApiError("zones", 200, [], `zone not found: ${zoneName}`);
  return z.id;
}

/**
 * パターンのルートを script(既定は配信専用の Worker)に向ける。無ければ作り、他の Worker にあれば付け替える(1 回の API で切り替わる)。
 * script を渡すのは切り戻し(setup-static の --to-script)だけ
 */
export async function ensureRoute(cfg: CfApiConfig, zoneId: string, pattern: string, script = cfg.scriptName): Promise<{ result: "created" | "moved" | "unchanged"; from?: string }> {
  const auth = { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" };
  const base = `${apiBaseOf(cfg)}/zones/${zoneId}/workers/routes`;
  const routes = (await call<Array<{ id: string; pattern: string; script?: string }>>(cfg, "routes", base, { headers: auth })) ?? [];
  const cur = routes.find((r) => r.pattern === pattern);
  const body = JSON.stringify({ pattern, script });
  if (!cur) {
    await call(cfg, "route_create", base, { method: "POST", headers: auth, body });
    return { result: "created" };
  }
  if (cur.script === script) return { result: "unchanged" };
  await call(cfg, "route_update", `${base}/${cur.id}`, { method: "PUT", headers: auth, body });
  return { result: "moved", from: cur.script ?? "(none)" };
}

/** workers.dev の公開を切り替える(ドメインなし構成は on。Route 構成は off) */
export async function setWorkersDev(cfg: CfApiConfig, enabled: boolean): Promise<void> {
  await call(cfg, "subdomain", `${apiBaseOf(cfg)}/accounts/${cfg.accountId}/workers/scripts/${cfg.scriptName}/subdomain`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled, previews_enabled: false }),
  });
}
