import { describe, expect, it } from "vitest";
import { API_CONTRACT_VERSION } from "@wtt/core";
import { call, json } from "./helpers";
import { BREAKING_MESSAGE, UPDATE_MESSAGE, contractDiff, mergeContract, updateBaseline, type Versions } from "./contract/diff";
import { normalizeContract, type Baseline, type Contract, type JsonSchema, type OperationContract, type OpenApiDoc } from "./contract/normalize";

/**
 * plan12 K7: control の API 契約のスナップショット。
 * 版ごとの基準 test/contract/v<N>.json(N = API_CONTRACT_VERSION)と今の `/openapi.json` を比べ、
 * 互換を外す変更は API_CONTRACT_VERSION を上げない限り落とす。基準の作り方・更新は `pnpm -C apps/control contract:update`
 * (docs/dev/compatibility_rules.md「control の API 契約の版」)。MIN_CLIENT_VERSION の検査はここでは行わない(core のテストが常に見る)
 */

// vite の import.meta.glob(型は vite/client に入っているが、このパッケージの tsconfig では読んでいないので宣言する)
declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true; import?: string }): Record<string, T>;
  }
}
const baselines = import.meta.glob<Baseline>("./contract/v*.json", { eager: true, import: "default" });
const baselineOf = (version: number): Baseline | undefined => baselines[`./contract/v${version}.json`];

type Verdict = { ok: true } | { ok: false; message: string; details: string[] };

/** 今の契約と、今の版の基準の差分を判定する。breaking → 版を上げる / additive → 基準を更新する / 差分なし → PASS */
function judgeSnapshot(snapshot: Baseline | undefined, current: Contract, versions: Versions): Verdict {
  if (!snapshot) return { ok: false, message: `契約の基準(v${versions.apiContractVersion}.json)がありません: pnpm -C apps/control contract:update`, details: [] };
  const { breaking, additive } = contractDiff(snapshot.contract, current);
  if (breaking.length > 0) return { ok: false, message: BREAKING_MESSAGE, details: breaking };
  if (additive.length > 0) return { ok: false, message: UPDATE_MESSAGE, details: additive };
  return { ok: true };
}
const explain = (v: Verdict): string => (v.ok ? "ok" : [v.message, ...v.details].join("\n"));

// ---- 契約の組み立て(単体テスト用) ----
const str: JsonSchema = { type: "string" };
const obj = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties), extra: JsonSchema = {}): JsonSchema => ({
  type: "object",
  properties,
  required: [...required].sort(),
  additionalProperties: false,
  ...extra,
});
const operation = (o: Partial<OperationContract> = {}): OperationContract => ({ parameters: {}, responses: {}, ...o });
const contractOf = (o: Partial<OperationContract>, key = "GET /things"): Contract => ({ operations: { [key]: operation(o) } });
const responding = (schema: JsonSchema, status = "200"): Partial<OperationContract> => ({ responses: { [status]: { "application/json": schema } } });
const requesting = (schema: JsonSchema, required = true): Partial<OperationContract> => ({ requestBody: { required, content: { "application/json": schema } } });
const POST = "POST /things";

describe("contract diff (plan12 K7)", () => {
  it("パスの削除は breaking", () => {
    const d = contractDiff({ operations: { "GET /a": operation(), "GET /b": operation() } }, { operations: { "GET /a": operation() } });
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain("GET /b");
  });
  it("メソッドの削除は breaking", () => {
    const d = contractDiff({ operations: { "GET /a": operation(), "POST /a": operation() } }, { operations: { "GET /a": operation() } });
    expect(d.breaking[0]).toContain("POST /a");
  });
  it("新しいパスは additive", () => {
    const d = contractDiff({ operations: { "GET /a": operation() } }, { operations: { "GET /a": operation(), "GET /b": operation() } });
    expect(d.breaking).toEqual([]);
    expect(d.additive.length).toBeGreaterThan(0);
    expect(d.additive[0]).toContain("GET /b");
  });
  it("応答のプロパティの削除は breaking", () => {
    const d = contractDiff(contractOf(responding(obj({ id: str, name: str }))), contractOf(responding(obj({ id: str }))));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".name");
  });
  it("応答のプロパティの追加は additive", () => {
    const d = contractDiff(contractOf(responding(obj({ id: str }))), contractOf(responding(obj({ id: str, name: str }))));
    expect(d.breaking).toEqual([]);
    expect(d.additive.length).toBeGreaterThan(0);
  });
  it("要求の必須プロパティの追加は breaking", () => {
    const d = contractDiff(contractOf(requesting(obj({ id: str })), POST), contractOf(requesting(obj({ id: str, name: str })), POST));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".name: 要求の必須プロパティが追加されました");
  });
  it("既存の要求のプロパティが必須になるのは breaking", () => {
    const d = contractDiff(contractOf(requesting(obj({ id: str, name: str }, ["id"])), POST), contractOf(requesting(obj({ id: str, name: str })), POST));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".name: 要求のプロパティが必須になりました");
  });
  it("要求の任意プロパティの追加は additive", () => {
    const d = contractDiff(contractOf(requesting(obj({ id: str })), POST), contractOf(requesting(obj({ id: str, note: str }, ["id"])), POST));
    expect(d.breaking).toEqual([]);
    expect(d.additive.length).toBeGreaterThan(0);
  });
  it("要求のプロパティの削除(additionalProperties: false の object)は breaking", () => {
    const d = contractDiff(contractOf(requesting(obj({ id: str, note: str }, ["id"])), POST), contractOf(requesting(obj({ id: str }, ["id"])), POST));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".note");
  });
  it("要求のプロパティの削除でも、未知のプロパティを許す object なら breaking にしない", () => {
    const loose = (props: Record<string, JsonSchema>): JsonSchema => ({ type: "object", properties: props });
    const d = contractDiff(contractOf(requesting(loose({ id: str, note: str })), POST), contractOf(requesting(loose({ id: str })), POST));
    expect(d.breaking).toEqual([]);
  });
  it.each([
    ["maxLength の減少", { type: "string", maxLength: 100 }, { type: "string", maxLength: 50 }],
    ["maxItems の減少", { type: "array", maxItems: 10 }, { type: "array", maxItems: 5 }],
    ["maximum の減少", { type: "integer", maximum: 100 }, { type: "integer", maximum: 99 }],
    ["minLength の増加", { type: "string", minLength: 1 }, { type: "string", minLength: 2 }],
    ["minItems の増加", { type: "array", minItems: 0 }, { type: "array", minItems: 1 }],
    ["minimum の増加", { type: "integer", minimum: 0 }, { type: "integer", minimum: 1 }],
    ["pattern の変更", { type: "string", pattern: "^a+$" }, { type: "string", pattern: "^b+$" }],
    ["制約の追加", { type: "string" }, { type: "string", maxLength: 10 }],
  ] as Array<[string, JsonSchema, JsonSchema]>)("要求の値の制約を狭める変更は breaking: %s", (_name, before, after) => {
    const d = contractDiff(contractOf(requesting(obj({ v: before })), POST), contractOf(requesting(obj({ v: after })), POST));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".v");
  });
  it.each([
    ["maxLength の増加", { type: "string", maxLength: 50 }, { type: "string", maxLength: 100 }],
    ["minimum の減少", { type: "integer", minimum: 1 }, { type: "integer", minimum: 0 }],
    ["制約を外す", { type: "string", pattern: "^a+$" }, { type: "string" }],
  ] as Array<[string, JsonSchema, JsonSchema]>)("要求の値の制約を緩める変更は breaking にならない: %s", (_name, before, after) => {
    const d = contractDiff(contractOf(requesting(obj({ v: before })), POST), contractOf(requesting(obj({ v: after })), POST));
    expect(d.breaking).toEqual([]);
  });
  it("応答の値の制約の変更は breaking にしない", () => {
    const d = contractDiff(contractOf(responding(obj({ v: { type: "string", maxLength: 100 } }))), contractOf(responding(obj({ v: { type: "string", maxLength: 10 } }))));
    expect(d.breaking).toEqual([]);
  });
  it("入れ子の object のプロパティの削除は breaking", () => {
    const d = contractDiff(
      contractOf(responding(obj({ outer: obj({ inner: str, other: str }) }))),
      contractOf(responding(obj({ outer: obj({ other: str }) }))),
    );
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".outer.inner");
  });
  it("配列の items の中のプロパティの削除は breaking", () => {
    const d = contractDiff(
      contractOf(responding({ type: "array", items: obj({ a: str, b: str }) })),
      contractOf(responding({ type: "array", items: obj({ a: str }) })),
    );
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".[].b: 応答のプロパティが削除されました");
  });
  it("応答の enum の値の削除は breaking", () => {
    const d = contractDiff(contractOf(responding(obj({ s: { type: "string", enum: ["a", "b"] } }))), contractOf(responding(obj({ s: { type: "string", enum: ["a"] } }))));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain('"b"');
  });
  it("応答の enum の値の追加は additive", () => {
    const d = contractDiff(contractOf(responding(obj({ s: { type: "string", enum: ["a"] } }))), contractOf(responding(obj({ s: { type: "string", enum: ["a", "b"] } }))));
    expect(d.breaking).toEqual([]);
    expect(d.additive.length).toBeGreaterThan(0);
  });
  it("要求の enum の値の削除は breaking", () => {
    const d = contractDiff(contractOf(requesting(obj({ s: { type: "string", enum: ["a", "b"] } })), POST), contractOf(requesting(obj({ s: { type: "string", enum: ["a"] } })), POST));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain('enum の値 "b" が削除されました');
  });
  it("型の変更(string → number)は breaking", () => {
    const d = contractDiff(contractOf(responding(obj({ v: str }))), contractOf(responding(obj({ v: { type: "number" } }))));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".v");
  });
  it("応答のプロパティが必須でなくなるのは breaking", () => {
    const d = contractDiff(contractOf(responding(obj({ a: str, b: str }))), contractOf(responding(obj({ a: str, b: str }, ["a"]))));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".b: 応答のプロパティが必須でなくなりました");
  });
  it("必須の引数の追加は breaking・任意の引数の追加は additive", () => {
    const p = (required: boolean) => ({ required, schema: str });
    const base = contractOf({});
    const required = contractDiff(base, contractOf({ parameters: { "query:q": p(true) } })).breaking;
    expect(required).toHaveLength(1);
    expect(required[0]).toContain("必須の引数 query:q が追加されました");
    const d = contractDiff(base, contractOf({ parameters: { "query:q": p(false) } }));
    expect(d.breaking).toEqual([]);
    expect(d.additive.length).toBeGreaterThan(0);
  });
  it("成功の応答の削除は breaking・エラー応答の宣言の削除は breaking にしない", () => {
    const both: Partial<OperationContract> = { responses: { "200": { "application/json": str }, "404": { "application/json": str } } };
    const removed = contractDiff(contractOf(both), contractOf(responding(str, "404"))).breaking;
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("応答 200 が削除されました");
    expect(contractDiff(contractOf(both), contractOf(responding(str, "200"))).breaking).toEqual([]);
  });
  it("anyOf の変種の中のプロパティの削除は breaking・変種の追加は additive", () => {
    const variant = (kind: string, props: Record<string, JsonSchema>): JsonSchema => obj({ kind: { type: "string", const: kind }, ...props });
    const before = contractOf(responding({ anyOf: [variant("a", { x: str, y: str }), variant("b", {})] }));
    const dropped = contractDiff(before, contractOf(responding({ anyOf: [variant("a", { x: str }), variant("b", {})] }))).breaking;
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain(".y: 応答のプロパティが削除されました");
    const added = contractDiff(before, contractOf(responding({ anyOf: [variant("a", { x: str, y: str }), variant("b", {}), variant("c", {})] })));
    expect(added.breaking).toEqual([]);
    expect(added.additive.length).toBeGreaterThan(0);
  });
  it("要求の anyOf の変種の削除は breaking", () => {
    const d = contractDiff(
      contractOf(requesting({ anyOf: [obj({ kind: { type: "string", const: "a" } }), obj({ kind: { type: "string", const: "b" } })] }), POST),
      contractOf(requesting({ anyOf: [obj({ kind: { type: "string", const: "a" } })] }), POST),
    );
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain("受け付ける形が削除されました");
  });
  it("応答の anyOf の変種の削除・改名は breaking(const で判別する union は enum の値の削除と同じ)", () => {
    const outcome = (ok: boolean, props: Record<string, JsonSchema> = {}): JsonSchema => obj({ ok: { type: "boolean", const: ok }, ...props });
    const before = contractOf(responding({ anyOf: [outcome(true), outcome(false, { reason: str })] }), "POST /things");
    const removed = contractDiff(before, contractOf(responding({ anyOf: [outcome(true)] }), "POST /things"));
    expect(removed.breaking).toHaveLength(1);
    expect(removed.breaking[0]).toContain("応答の形が削除されました");
    // 判別値の改名(ok: false → ok: "no")は、古い形の削除として見つかる
    const renamed = contractDiff(
      before,
      contractOf(responding({ anyOf: [outcome(true), obj({ ok: { type: "string", const: "no" }, reason: str })] }), "POST /things"),
    );
    expect(renamed.breaking.length).toBeGreaterThan(0);
    expect(renamed.breaking.join("\n")).toContain("応答の形が削除されました");
  });
  it("const の変更は breaking", () => {
    const d = contractDiff(contractOf(responding(obj({ k: { type: "string", const: "a" } }))), contractOf(responding(obj({ k: { type: "string", const: "b" } }))));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".k: const が変わりました");
  });
  it("要求の enum が新たに絞られるのは breaking", () => {
    const d = contractDiff(contractOf(requesting(obj({ s: str })), POST), contractOf(requesting(obj({ s: { type: "string", enum: ["a"] } })), POST));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".s: enum で値が絞られました");
  });
  it("要求が additionalProperties: false になる(未知のプロパティを受けなくなる)のは breaking", () => {
    const loose: JsonSchema = { type: "object", properties: { id: str }, required: ["id"] };
    const d = contractDiff(contractOf(requesting(loose), POST), contractOf(requesting({ ...loose, additionalProperties: false }), POST));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain("要求が未知のプロパティを受けなくなりました");
  });
  it("既存の引数が必須になるのは breaking", () => {
    const p = (required: boolean) => ({ required, schema: str });
    const d = contractDiff(contractOf({ parameters: { "query:q": p(false) } }), contractOf({ parameters: { "query:q": p(true) } }));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain("引数 query:q が必須になりました");
  });
  it("必須の要求 body の追加は breaking・任意の要求 body の追加は additive", () => {
    const base = contractOf({}, POST);
    const required = contractDiff(base, contractOf(requesting(obj({ id: str }), true), POST));
    expect(required.breaking).toHaveLength(1);
    expect(required.breaking[0]).toContain("必須の要求 body が追加されました");
    const optional = contractDiff(base, contractOf(requesting(obj({ id: str }), false), POST));
    expect(optional.breaking).toEqual([]);
    expect(optional.additive.length).toBeGreaterThan(0);
  });
  it("要求 body が必須になるのは breaking", () => {
    const d = contractDiff(contractOf(requesting(obj({ id: str }), false), POST), contractOf(requesting(obj({ id: str }), true), POST));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain("要求 body が必須になりました");
  });
  it("要求 body のメディアタイプを受けなくなるのは breaking", () => {
    const both = contractOf({ requestBody: { required: true, content: { "application/json": obj({ id: str }), "multipart/form-data": obj({ id: str }) } } }, POST);
    const d = contractDiff(both, contractOf(requesting(obj({ id: str })), POST));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain("要求 body の multipart/form-data を受けなくなりました");
  });
  it("成功の応答のメディアタイプの削除は breaking", () => {
    const both = contractOf({ responses: { "200": { "application/json": obj({ id: str }), "text/plain": str } } });
    const d = contractDiff(both, contractOf(responding(obj({ id: str }))));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain("応答 200 の text/plain が削除されました");
  });
  it("additionalProperties が schema のとき(連想配列の値)の中のプロパティの削除も breaking", () => {
    const map = (value: JsonSchema): JsonSchema => ({ type: "object", additionalProperties: value });
    const d = contractDiff(contractOf(responding(map(obj({ a: str, b: str })))), contractOf(responding(map(obj({ a: str })))));
    expect(d.breaking).toHaveLength(1);
    expect(d.breaking[0]).toContain(".*.b: 応答のプロパティが削除されました");
  });
  it("差分が無ければ breaking も additive も空", () => {
    const c = contractOf(responding(obj({ id: str })));
    expect(contractDiff(c, structuredClone(c))).toEqual({ breaking: [], additive: [] });
  });
  it("基準に足した和は、もう一度足しても変わらない(更新の直後は差分が消える)", () => {
    const prev = contractOf({ ...responding(obj({ id: str, s: { type: "string", enum: ["a"] } })), ...requesting(obj({ a: { type: "string", maxLength: 10 } }, [])) });
    const next = contractOf({
      ...responding(obj({ id: str, name: str, s: { type: "string", enum: ["a", "b"] } })),
      ...requesting(obj({ a: { type: "string", maxLength: 20 }, b: str }, [])),
    });
    const merged = mergeContract(prev, next);
    expect(contractDiff(merged, next)).toEqual({ breaking: [], additive: [] });
    expect(mergeContract(merged, next)).toEqual(merged);
  });
  it("基準より減った・狭まった分は、足すだけの更新では基準から消えない", () => {
    const prev = contractOf(responding(obj({ id: str, s: { type: "string", enum: ["a", "b"] } })));
    const next = contractOf(responding(obj({ id: str, s: { type: "string", enum: ["a"] } })));
    expect(mergeContract(prev, next)).toEqual(prev);
  });
});

describe("normalizeContract (plan12 K7)", () => {
  const doc = (paths: OpenApiDoc["paths"], schemas: Record<string, unknown> = {}): OpenApiDoc => ({ paths, components: { schemas } });

  it("description / summary / example / default を外し、キーと配列の順を揃える", () => {
    const a = doc({
      "/x": { get: { summary: "A", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", description: "d", properties: { b: { type: "string", default: "z", example: "e" }, a: { type: "string", enum: ["y", "x"] } }, required: ["b", "a"] } } } } } } },
    });
    const b = doc({
      "/x": { get: { summary: "B", responses: { "200": { content: { "application/json": { schema: { required: ["a", "b"], properties: { a: { enum: ["x", "y"], type: "string" }, b: { type: "string" } }, type: "object" } } } } } } },
    });
    expect(JSON.stringify(normalizeContract(a))).toBe(JSON.stringify(normalizeContract(b)));
  });
  it("description という名前のプロパティは外さない", () => {
    const c = normalizeContract(doc({ "/x": { get: { responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { description: { type: "string" } } } } } } } } } }));
    expect(c.operations["GET /x"]!.responses["200"]!["application/json"]).toEqual({ type: "object", properties: { description: { type: "string" } } });
  });
  it("$ref(components と祖先の $defs)を展開し、循環は $recursive で止める", () => {
    const c = normalizeContract(
      doc(
        {
          "/x": {
            get: {
              responses: {
                "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Named" } } } },
                "400": {
                  content: {
                    "application/json": {
                      schema: { $defs: { __schema0: { type: "object", properties: { child: { $ref: "#/components/schemas/__schema0" } } } }, type: "array", items: { $ref: "#/components/schemas/__schema0" } },
                    },
                  },
                },
              },
            },
          },
        },
        { Named: { type: "string", description: "x" } },
      ),
    );
    const r = c.operations["GET /x"]!.responses;
    expect(r["200"]!["application/json"]).toEqual({ type: "string" });
    expect(r["400"]!["application/json"]).toEqual({ type: "array", items: { type: "object", properties: { child: { $recursive: "__schema0" } } } });
  });
  it("パスとクエリの引数だけを取り、パス共通の引数も数える", () => {
    const c = normalizeContract(
      doc({
        "/x/{id}": {
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
          get: { parameters: [{ in: "query", name: "q", schema: { type: "string" } }, { in: "header", name: "h", schema: { type: "string" } }], responses: {} },
        },
      }),
    );
    expect(c.operations["GET /x/{id}"]!.parameters).toEqual({ "path:id": { required: true, schema: { type: "string" } }, "query:q": { required: false, schema: { type: "string" } } });
  });
  it("解決できない $ref は黙って通さず落とす", () => {
    expect(() => normalizeContract(doc({ "/x": { get: { responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } } } } } }))).toThrow(/unresolved/);
  });
});

describe("contract snapshot (plan12 K7)", () => {
  /** workerd の中で、本物の app に /openapi.json を作らせる */
  async function currentContract(): Promise<Contract> {
    const res = await call("GET", "/openapi.json");
    expect(res.status).toBe(200);
    return normalizeContract(await json<OpenApiDoc>(res));
  }
  const versions: Versions = { apiContractVersion: API_CONTRACT_VERSION };

  it("今の /openapi.json は、今の版の基準(v<N>.json)と一致している", async () => {
    const verdict = judgeSnapshot(baselineOf(API_CONTRACT_VERSION), await currentContract(), versions);
    expect(verdict.ok, explain(verdict)).toBe(true);
  });

  it("contract_snapshot_blocks_breaking_change_without_version_bump", () => {
    const snapshot: Baseline = { apiContractVersion: 1, contract: contractOf(responding(obj({ id: str, name: str }))) };
    // 破壊的(応答のプロパティの削除): 版を上げるまで落ちる
    const breaking = judgeSnapshot(snapshot, contractOf(responding(obj({ id: str }))), { apiContractVersion: 1 });
    expect(breaking.ok).toBe(false);
    if (!breaking.ok) expect(breaking.message).toBe("互換を外す変更です。API_CONTRACT_VERSION を上げてください");
    // additive(応答のプロパティの追加): 基準の更新を促す
    const additive = judgeSnapshot(snapshot, contractOf(responding(obj({ id: str, name: str, more: str }))), { apiContractVersion: 1 });
    expect(additive.ok).toBe(false);
    if (!additive.ok) expect(additive.message).toBe("契約の基準を更新してください: pnpm -C apps/control contract:update");
    // 差分なし: PASS
    expect(judgeSnapshot(snapshot, structuredClone(snapshot.contract), { apiContractVersion: 1 })).toEqual({ ok: true });
  });

  it("contract_update_does_not_hide_breaking_change_without_version_bump", () => {
    const baseline: Baseline = { apiContractVersion: 1, contract: contractOf(responding(obj({ id: str, name: str }))) };
    const before = structuredClone(baseline);
    const result = updateBaseline(baseline, contractOf(responding(obj({ id: str }))), { apiContractVersion: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(BREAKING_MESSAGE);
      expect(result.details.length).toBeGreaterThan(0);
    }
    // 基準は変わらない(渡した基準そのものも、書き出される中身も)
    expect(baseline).toEqual(before);
  });

  it("additive な差は基準に足され、足した直後は judgeSnapshot が PASS になる", () => {
    const baseline: Baseline = { apiContractVersion: 1, contract: contractOf(responding(obj({ id: str }))) };
    const current = contractOf(responding(obj({ id: str, name: str })));
    const result = updateBaseline(baseline, current, { apiContractVersion: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(judgeSnapshot(result.baseline, current, { apiContractVersion: 1 })).toEqual({ ok: true });
    expect(updateBaseline(result.baseline, current, { apiContractVersion: 1 })).toMatchObject({ ok: true, changed: false });
  });

  it("版を上げた直後(その版の基準が無い)は、今の契約で新しい基準を作る", () => {
    const current = contractOf(responding(obj({ id: str })));
    const result = updateBaseline(undefined, current, { apiContractVersion: 2 });
    expect(result).toMatchObject({ ok: true, changed: true, baseline: { apiContractVersion: 2, contract: current } });
  });

  it("基準ファイルの apiContractVersion は、ファイル名の版と一致している", () => {
    for (const [file, baseline] of Object.entries(baselines)) {
      expect(`./contract/v${baseline.apiContractVersion}.json`, file).toBe(file);
    }
  });
});
