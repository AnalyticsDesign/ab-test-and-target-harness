/**
 * plan12 K7: `/openapi.json` から「契約」の正規化した写しを作る(版ごとの基準 test/contract/v<N>.json の中身)。
 * 純粋な関数だけ(Node のスクリプト scripts/contract-update.ts と、workerd で走るテストの両方から読む)。
 *
 * 正規化の方針:
 * - 見るのは「パス × メソッド」ごとの、パスとクエリの引数・要求の body の schema・応答の status ごとの schema だけ
 * - `$ref` は展開する(循環は `{ "$recursive": 名前 }` で止める)。hono-openapi は入れ子の再帰 schema を
 *   「祖先の `$defs` に置き、`#/components/schemas/<名前>` で参照する」形で出すので、祖先の `$defs` を先に引き、無ければ components を引く
 * - 説明・例・既定値(`description` / `summary` / `example(s)` / `title` / `default` …)は外す。文言を直しただけで基準を動かさないため。
 *   意味や既定値の変更は基準に出ないので、レビューで見る(docs/dev/compatibility_rules.md)
 * - キーは並べ替え、順序に意味の無い配列(`enum` / `required` / `anyOf` / `oneOf` / `allOf` / `type` の配列)も並べ替える。
 *   同じ契約からはいつも同じ文字列ができる(基準の diff を安定させる)
 */

export type JsonSchema = { [key: string]: unknown };
export interface ParameterContract {
  required: boolean;
  schema: JsonSchema;
}
export interface RequestBodyContract {
  required: boolean;
  /** メディアタイプ → schema */
  content: Record<string, JsonSchema>;
}
export interface OperationContract {
  /** `path:sid` / `query:limit` のようにキーを付ける */
  parameters: Record<string, ParameterContract>;
  requestBody?: RequestBodyContract;
  /** status → メディアタイプ → schema(本文の無い応答は `{}`) */
  responses: Record<string, Record<string, JsonSchema>>;
}
export interface Contract {
  /** `GET /sites/{sid}` のようにキーを付ける */
  operations: Record<string, OperationContract>;
}
/** 版ごとの基準ファイル(test/contract/v<N>.json)の形 */
export interface Baseline {
  apiContractVersion: number;
  contract: Contract;
}

/** 必要な範囲だけ型を付けた OpenAPI 文書(hono-openapi の出力) */
export interface OpenApiDoc {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown>; parameters?: Record<string, unknown>; responses?: Record<string, unknown> };
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
/** 文言・例・既定値など、契約の形に関係しない注釈(schema の node から外す) */
const STRIP = new Set(["description", "summary", "example", "examples", "title", "default", "deprecated", "$schema", "$comment", "$id"]);
/** キーが「名前 → schema」の対応表になっている keyword(名前が STRIP と衝突しても外さない) */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);
/** 順序に意味の無い、schema の配列 */
const SORTED_SCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** キーを並べ替えた JSON 文字列(等しいかの比較と並べ替えの鍵に使う) */
export function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const byCanonical = (a: unknown, b: unknown): number => {
  const x = canonical(a);
  const y = canonical(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

interface Ctx {
  doc: OpenApiDoc;
  /** 外側から内側の順の `$defs` */
  defs: Array<Record<string, unknown>>;
  /** 展開中の `$ref` の名前(循環の検出) */
  expanding: string[];
}

function resolveRef(ref: string, ctx: Ctx): { name: string; target: unknown; defs: Record<string, unknown> | null } {
  const name = ref.slice(ref.lastIndexOf("/") + 1);
  for (let i = ctx.defs.length - 1; i >= 0; i--) {
    const defs = ctx.defs[i]!;
    if (name in defs) return { name, target: defs[name], defs };
  }
  const target = ctx.doc.components?.schemas?.[name];
  if (target !== undefined) return { name, target, defs: null };
  throw new Error(`contract: unresolved $ref ${ref}`);
}

/** schema の node 1 つを正規化する */
function normSchema(node: unknown, ctx: Ctx): unknown {
  if (!isRecord(node)) return node; // true / false(additionalProperties など)
  const defs = isRecord(node.$defs) ? node.$defs : null;
  const scoped: Ctx = defs ? { ...ctx, defs: [...ctx.defs, defs] } : ctx;
  const out: Record<string, unknown> = {};

  if (typeof node.$ref === "string") {
    const { name, target } = resolveRef(node.$ref, scoped);
    if (scoped.expanding.includes(name)) out.$recursive = name;
    else Object.assign(out, normSchema(target, { ...scoped, expanding: [...scoped.expanding, name] }));
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" || k === "$defs" || STRIP.has(k)) continue;
    if (SCHEMA_MAPS.has(k) && isRecord(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, normSchema(s, scoped)]));
    } else if (SORTED_SCHEMA_LISTS.has(k) && Array.isArray(v)) {
      out[k] = v.map((s) => normSchema(s, scoped)).sort(byCanonical);
    } else if (k === "prefixItems" && Array.isArray(v)) {
      out[k] = v.map((s) => normSchema(s, scoped)); // 位置に意味がある
    } else if (k === "enum" && Array.isArray(v)) {
      out[k] = [...v].sort(byCanonical);
    } else if (k === "required" && Array.isArray(v)) {
      out[k] = [...v].sort();
    } else if (k === "type" && Array.isArray(v)) {
      out[k] = [...v].sort();
    } else if (k === "const") {
      out[k] = v; // 値そのもの(中を schema として読まない)
    } else if (Array.isArray(v)) {
      out[k] = v.map((s) => normSchema(s, scoped));
    } else if (isRecord(v)) {
      out[k] = normSchema(v, scoped);
    } else out[k] = v;
  }
  return sortKeys(out);
}

const normalizeRoot = (schema: unknown, doc: OpenApiDoc): JsonSchema => (schema === undefined ? {} : (normSchema(schema, { doc, defs: [], expanding: [] }) as JsonSchema));

/** `content` → メディアタイプごとの schema */
function normContent(content: unknown, doc: OpenApiDoc): Record<string, JsonSchema> {
  if (!isRecord(content)) return {};
  return Object.fromEntries(
    Object.keys(content)
      .sort()
      .map((media) => [media, normalizeRoot((content[media] as { schema?: unknown } | undefined)?.schema, doc)]),
  );
}

/** `#/components/<kind>/<name>` を 1 段だけ引く(parameters / responses) */
function deref(v: unknown, kind: "parameters" | "responses", doc: OpenApiDoc): Record<string, unknown> {
  if (isRecord(v) && typeof v.$ref === "string") {
    const target = doc.components?.[kind]?.[v.$ref.slice(v.$ref.lastIndexOf("/") + 1)];
    if (!isRecord(target)) throw new Error(`contract: unresolved $ref ${v.$ref}`);
    return target;
  }
  return isRecord(v) ? v : {};
}

export function normalizeContract(doc: OpenApiDoc): Contract {
  const operations: Record<string, OperationContract> = {};
  for (const path of Object.keys(doc.paths ?? {}).sort()) {
    const item = doc.paths![path]!;
    const shared = Array.isArray(item.parameters) ? (item.parameters as unknown[]) : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      // パスとクエリの引数だけ(ヘッダーは契約に含めない)。パス共通の引数も、その操作の引数として数える
      const parameters: Record<string, ParameterContract> = {};
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [])]) {
        const p = deref(raw, "parameters", doc);
        if (p.in !== "path" && p.in !== "query") continue;
        parameters[`${p.in}:${String(p.name)}`] = { required: p.in === "path" || p.required === true, schema: normalizeRoot(p.schema, doc) };
      }
      const operation: OperationContract = { parameters: sortKeys(parameters) as Record<string, ParameterContract>, responses: {} };
      if (isRecord(op.requestBody)) {
        // requestBody の $ref は hono-openapi が出さない(出たら content が空になり、diff が要求の消失として落ちる)
        operation.requestBody = { required: op.requestBody.required === true, content: normContent(op.requestBody.content, doc) };
      }
      const responses = isRecord(op.responses) ? op.responses : {};
      for (const status of Object.keys(responses).sort()) {
        operation.responses[status] = normContent(deref(responses[status], "responses", doc).content, doc);
      }
      operations[`${method.toUpperCase()} ${path}`] = operation;
    }
  }
  return { operations };
}
