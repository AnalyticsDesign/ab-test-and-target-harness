import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { app } from "../src/index";

/**
 * 決定 34 / DoD 7b: 契約がルート定義から漏れていないことを固定する。
 *
 * **このテストは列挙ではなく掃引である。** 期待側は `/openapi.json` ではなく **Hono のルータ
 * (`app.routes`)** から導く。したがって後から `describeRoute` 無しでルートを足すと、このテストを
 * 誰も書き換えなくても落ちる。`test/auth.test.ts` の「operations の完全一致リスト」は別の保証
 * (ルートの増減に気付く)なので、そちらはそのまま残す。
 */

type Schema = { $ref?: string; properties?: Record<string, unknown>; items?: unknown; oneOf?: unknown[]; anyOf?: unknown[]; allOf?: unknown[]; type?: string };
type Media = { schema?: Schema };
type Operation = {
  summary?: string;
  description?: string;
  requestBody?: { content?: Record<string, Media> };
  responses?: Record<string, { content?: Record<string, Media> }>;
};
type Doc = { openapi: string; paths: Record<string, Record<string, Operation>> };

/** 契約の対象外: Better Auth のパススルー / R2 のローカル配信 / 文書そのもの / ヘルスチェック */
const skip = (p: string) => p.startsWith("/auth") || p.startsWith("/dev-assets") || p === "/openapi.json" || p === "/";

/** Hono の登録ルート → `METHOD /path/{param}`。`app.use("*")` などの ALL は除く。1 ルートに複数ハンドラが並ぶので重複を潰す */
function mountedOperations(): Array<readonly [string, string]> {
  const seen = new Map<string, readonly [string, string]>();
  for (const r of app.routes) {
    if (r.method === "ALL" || skip(r.path)) continue;
    const path = r.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    seen.set(`${r.method} ${path}`, [r.method.toLowerCase(), path] as const);
  }
  return [...seen.values()].sort((a, b) => `${a[1]} ${a[0]}`.localeCompare(`${b[1]} ${b[0]}`));
}

/** `{}` や `{"description": …}` だけの schema は「形が載っていない」とみなす */
const describesAShape = (s: Schema | undefined): boolean =>
  !!s && (typeof s.$ref === "string" || !!s.properties || !!s.items || !!s.oneOf || !!s.anyOf || !!s.allOf || typeof s.type === "string");

describe("openapi (decision 34)", () => {
  it("openapi operations cover every mounted route with envelope errors", async () => {
    const res = await app.request("/openapi.json", {}, env);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Doc;
    expect(doc.openapi).toMatch(/^3\.1/);

    const mounted = mountedOperations();
    expect(mounted.length).toBeGreaterThan(0); // ルータから 1 件も拾えない = 掃引になっていない
    for (const [method, path] of mounted) {
      const label = `${method.toUpperCase()} ${path}`;
      const op = doc.paths[path]?.[method];
      expect(op, `${label}: describeRoute が無い(paths に出ていない)`).toBeDefined();
      const codes = Object.keys(op!.responses ?? {});
      expect(codes.some((c) => c.startsWith("2")), `${label}: 2xx の応答が宣言されていない`).toBe(true);
      const errs = codes.filter((c) => c.startsWith("4") || c.startsWith("5"));
      expect(errs.length, `${label}: 4xx / 5xx の応答が 1 つも宣言されていない`).toBeGreaterThan(0);
      for (const code of errs) {
        expect(op!.responses![code]!.content?.["application/json"]?.schema?.$ref, `${label} ${code}: 封筒 schema を参照していない`).toBe(
          "#/components/schemas/ErrorEnvelope",
        );
      }
      // requestBody を持つなら中身の形まで載っていること(空の schema は「載っていない」と同じ)
      const body = op!.requestBody?.content;
      if (body) {
        for (const [media, m] of Object.entries(body)) {
          expect(describesAShape(m.schema), `${label}: requestBody(${media})の schema が空`).toBe(true);
        }
      }
    }
    // 封筒 schema 本体が components に居ること($ref の参照先が無ければ文書として壊れている)
    const components = (doc as unknown as { components?: { schemas?: Record<string, unknown> } }).components;
    expect(components?.schemas?.ErrorEnvelope).toBeDefined();
  });

  it("openapi_and_llms_mention_new_status_codes", async () => {
    const doc = (await (await app.request("/openapi.json", {}, env)).json()) as Doc;
    const op = doc.paths["/sites/{sid}/experiments/{eid}/status"]!.post!;
    const guide = await (await app.request("/llms.txt", {}, env)).text();
    for (const status of ["409", "503"]) {
      expect(op.responses?.[status]?.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/ErrorEnvelope");
    }
    expect(op.summary).toMatch(/開始・再開.*状態を変えずに 409.*封筒.*message.*hint.*assetProblems/);
    expect(guide).toMatch(/開始・再開が `409`.*状態は変わっていません。封筒/);
    for (const text of [op.summary, guide]) {
      expect(text).toMatch(/公開の準備に失敗して終了だけが確定した場合も、結果と採用の記録を試み/);
    }
    for (const description of [op.description, guide]) {
      expect(description).toContain("409 transition_conflict");
      expect(description).toContain("503 publish_outcome_unknown");
    }
  });

  it("publish_body_validation_errors_use_envelopes", async () => {
    const doc = (await (await app.request("/openapi.json", {}, env)).json()) as Doc;
    const op = doc.paths["/sites/{sid}/publish"]!.post!;
    for (const status of ["400", "422"]) expect(op.responses?.[status]?.content?.["application/json"]?.schema?.$ref).toBe("#/components/schemas/ErrorEnvelope");
    expect(op.requestBody?.content?.["application/json"]?.schema?.properties).toHaveProperty("expectDigest");
  });

  it("zod-derived request bodies are published for the site write routes", async () => {
    // review r1 / r2 の持ち越し: Task 3 の 2 ルートが requestBody を本当に公開しているかの常設アサート
    const doc = (await (await app.request("/openapi.json", {}, env)).json()) as Doc;
    for (const [path, method, required] of [
      ["/workspaces/{wid}/sites", "post", ["name", "domains"]],
      ["/sites/{sid}", "patch", ["name", "domains"]],
    ] as const) {
      const schema = doc.paths[path]?.[method]?.requestBody?.content?.["application/json"]?.schema;
      expect(schema, `${method.toUpperCase()} ${path}: requestBody が無い`).toBeDefined();
      const props = schema!.properties ?? {};
      expect(Object.keys(props).length, `${method.toUpperCase()} ${path}: requestBody の properties が空`).toBeGreaterThan(0);
      for (const key of required) expect(Object.keys(props), `${method.toUpperCase()} ${path}`).toContain(key);
    }
    // Asset アップロードは multipart。file が binary として載っていること
    const upload = doc.paths["/sites/{sid}/assets"]?.post?.requestBody?.content?.["multipart/form-data"]?.schema;
    expect(upload?.properties, "POST /sites/{sid}/assets: multipart の requestBody が無い").toBeDefined();
    expect((upload!.properties as Record<string, { format?: string }>).file?.format).toBe("binary");

    // 決定 35 (7): Change 全置換の requestBody に件数上限が載る
    const changesBody = doc.paths["/sites/{sid}/experiments/{eid}/variants/{vid}/changes"]?.put?.requestBody?.content?.["application/json"]?.schema as { maxItems?: number } | undefined;
    expect(changesBody?.maxItems, "PUT …/changes: maxItems が無い").toBe(100);
  });

  it("b68_site_asset_routes_are_described", async () => {
    // B68: 画像の 4 つの口(POST / GET / PATCH / DELETE)に summary と応答の説明がある。新しい口を足して説明を忘れたら、この掃引が落ちる
    type Op = { summary?: string; description?: string; responses?: Record<string, { description?: string; content?: Record<string, Media> }> };
    const doc = (await (await app.request("/openapi.json", {}, env)).json()) as Doc & {
      paths: Record<string, Record<string, Op>>;
      components?: { schemas?: Record<string, Schema> };
    };
    const routes = mountedOperations().filter(([, path]) => path.startsWith("/sites/{sid}/assets"));
    expect(routes.map(([m, p]) => `${m} ${p}`).sort()).toEqual([
      "delete /sites/{sid}/assets/{aid}",
      "get /sites/{sid}/assets",
      "patch /sites/{sid}/assets/{aid}",
      "post /sites/{sid}/assets",
    ]);
    for (const [method, path] of routes) {
      const op = doc.paths[path]![method] as Op;
      expect(op.summary?.length ?? 0, `${method} ${path}: summary`).toBeGreaterThan(20);
    }
    const op = (method: string, path: string) => doc.paths[path]![method] as Op;
    expect(op("get", "/sites/{sid}/assets").summary).toContain("公開したときの内容での使用は公開の記録から数える");
    expect(op("delete", "/sites/{sid}/assets/{aid}").summary).toContain("24 時間の後に、どこでも使われていなければ消える");
    expect(op("delete", "/sites/{sid}/assets/{aid}").summary).toContain("パターンの変更か、公開したときの内容で使われている間は 409");
    // 名前の変更の応答は使い方を読まない(使用中でも inUse: false)。その旨が応答の説明にある
    expect(op("patch", "/sites/{sid}/assets/{aid}").responses!["200"]!.description).toMatch(/使い方を読まない.*usedBy・deliveredIn は空.*inUse は false/);
    // 項目の説明: 一覧・削除・名前の変更の応答
    const props = (schema: Schema | undefined): Record<string, { description?: string; properties?: Record<string, { description?: string }>; items?: Schema }> => {
      const resolved = schema?.$ref ? doc.components?.schemas?.[schema.$ref.split("/").pop()!] : schema;
      return (resolved?.properties ?? {}) as never;
    };
    const ok = (method: string, path: string, code: string) => op(method, path).responses![code]!.content!["application/json"]!.schema;
    const list = props(ok("get", "/sites/{sid}/assets", "200"));
    const item = (list.assets!.items as Schema).properties as Record<string, { description?: string }>;
    for (const key of ["deliveredIn", "inUse", "keptAt"]) expect(item[key]?.description, `GET assets[].${key}`).toBeTruthy();
    const usage = list.usage!.properties!;
    for (const key of ["pendingCount", "pendingBytes"]) expect(usage[key]?.description, `usage.${key}`).toBeTruthy();
    const renamed = props(ok("patch", "/sites/{sid}/assets/{aid}", "200")) as Record<string, { description?: string }>;
    for (const key of ["usedBy", "deliveredIn", "inUse"]) expect(renamed[key]?.description, `PATCH ${key}`).toContain("使い方を読まない");
    const deleted = props(ok("delete", "/sites/{sid}/assets/{aid}", "200")) as Record<string, { description?: string }>;
    for (const key of ["status", "purgeAfter"]) expect(deleted[key]?.description, `DELETE ${key}`).toBeTruthy();
    // 状態を変える口: 開始・再開と、止める操作の違い
    const status = op("post", "/sites/{sid}/experiments/{eid}/status").summary;
    expect(status).toContain("開始・再開は、画像の確かめに通らなければ");
    expect(status).toContain("状態を変えずに 409");
    expect(status).toContain("一時停止・終了は画像を確かめずに状態を変えて公開する");
    // 公開の失敗(error の例)と、画像の問題の項目
    const publish = JSON.stringify(doc.paths["/sites/{sid}/publish"]!.post);
    expect(publish).toContain("asset_missing / asset_other_site");
    expect(publish).toContain("assetProblems");
    expect(JSON.stringify(doc.paths["/sites/{sid}/publish-preview"]!.get)).toContain("assetProblems");
  });

  it("b77_fields_are_published", async () => {
    // B77: 目標の外部計測(analytics)・パターンのオリジナルとメモ(original / description)・パターンのメモだけを更新するルート
    const doc = (await (await app.request("/openapi.json", {}, env)).json()) as Doc & { components?: { schemas?: Record<string, Schema> } };
    const body = (path: string, method: string) => doc.paths[path]?.[method]?.requestBody?.content?.["application/json"]?.schema;
    const ok = (path: string, method: string, code: string) => doc.paths[path]?.[method]?.responses?.[code]?.content?.["application/json"]?.schema;
    for (const [path, method] of [
      ["/sites/{sid}/goals", "post"],
      ["/sites/{sid}/goals/{gid}", "patch"],
    ] as const) {
      expect(propertiesOf(doc, body(path, method)), `${method.toUpperCase()} ${path}`).toContain("analytics");
    }
    const goalOut = ok("/sites/{sid}/goals", "post", "201");
    expect(propertiesOf(doc, goalOut)).toContain("analytics");
    // 応答の analytics は目標の外部計測の形(目標名の指定だけ)
    expect(propertiesOf(doc, (goalOut?.properties as Record<string, Schema> | undefined)?.analytics)).toEqual(["overrides"]);
    const variantItem = (body("/sites/{sid}/experiments/{eid}/variants", "put") as { items?: Schema } | undefined)?.items;
    expect(propertiesOf(doc, variantItem)).toEqual(expect.arrayContaining(["original", "description", "analytics"]));
    expect(propertiesOf(doc, body("/sites/{sid}/experiments/{eid}/variants/{vid}", "patch"))).toEqual(["description"]);
  });
});

/** schema の properties のキー($ref と anyOf / oneOf / allOf をたどって集める) */
function propertiesOf(doc: { components?: { schemas?: Record<string, Schema> } }, s: Schema | undefined): string[] {
  if (!s) return [];
  if (s.$ref) return propertiesOf(doc, doc.components?.schemas?.[s.$ref.replace("#/components/schemas/", "")]);
  const nested = [...(s.anyOf ?? []), ...(s.oneOf ?? []), ...(s.allOf ?? [])] as Schema[];
  return [...new Set([...Object.keys(s.properties ?? {}), ...nested.flatMap((n) => propertiesOf(doc, n))])];
}
