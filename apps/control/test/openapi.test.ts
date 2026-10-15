import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import app from "../src/index";

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

  it("zod-derived request bodies are published for the site write routes", async () => {
    // review r1 / r2 の持ち越し: Task 3 の 2 ルートが requestBody を本当に公開しているかの常設アサート
    const doc = (await (await app.request("/openapi.json", {}, env)).json()) as Doc;
    for (const [path, method, required] of [
      ["/workspaces/{wid}/sites", "post", ["name", "domain"]],
      ["/sites/{sid}", "patch", ["name"]],
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
});
