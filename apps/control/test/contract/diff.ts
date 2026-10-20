/**
 * plan12 K7: 契約(normalize.ts の Contract)の差分と、基準への「足すだけ」の更新。純粋な関数だけ。
 *
 * - `contractDiff(prev, next)`: breaking(古いクライアントを壊す) と additive(基準に足すべき差) を返す
 * - `mergeContract(prev, next)`: 基準 prev に next で増えた分を足した和。減った分・狭まった分は prev のまま残す
 * - `updateBaseline(baseline, current, versions)`: contract:update の本体。breaking があれば基準を変えずに失敗を返す
 *
 * additive は「prev と mergeContract(prev, next) の差」で決める。こうすると、基準を更新した直後は必ず差が無くなる
 * (減っただけの差を additive と数えて、更新しても消えない堂々巡りが起きない)
 *
 * 向き(dir): request = 古いクライアントが送る側(狭めると壊れる) / response = 古いクライアントが読む側(消すと壊れる)
 */
import { canonical, sortKeys, type Baseline, type Contract, type JsonSchema, type OperationContract, type ParameterContract, type RequestBodyContract } from "./normalize";

export const BREAKING_MESSAGE = "互換を外す変更です。API_CONTRACT_VERSION を上げてください";
export const UPDATE_MESSAGE = "契約の基準を更新してください: pnpm -C apps/control contract:update";

export interface ContractDiff {
  breaking: string[];
  additive: string[];
}
type Dir = "request" | "response";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const show = (v: unknown): string => (v === undefined ? "なし" : canonical(v));
const byCanonical = (a: unknown, b: unknown): number => {
  const x = canonical(a);
  const y = canonical(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
const sortedKeys = (...objs: Array<Record<string, unknown>>): string[] => [...new Set(objs.flatMap((o) => Object.keys(o)))].sort();
/** 成功系(2xx / 3xx)の応答か。エラー応答の宣言の増減は実際の挙動ではなく文書の整理のことが多いので、削除を breaking に数えない */
const isSuccessStatus = (status: string): boolean => /^[23]/.test(status);

// 値の制約。要求で狭める(max を減らす / min を増やす / 足す)と、送り続けている古いクライアントが 422 になる
const MAX_KEYS = ["maxLength", "maxItems", "maximum", "maxProperties", "exclusiveMaximum"];
const MIN_KEYS = ["minLength", "minItems", "minimum", "minProperties", "exclusiveMinimum"];
const VARIANT_KEYS = ["anyOf", "oneOf", "allOf"];

// ---- 変種(anyOf / oneOf / allOf)の対応づけ ----

/** 変種を対応づける目印: type と、プロパティの const(判別用)。中身が変わっても同じ変種なら同じ目印になる */
function variantSignature(v: unknown): string {
  if (!isRecord(v)) return canonical(v);
  const consts = isRecord(v.properties)
    ? Object.keys(v.properties)
        .sort()
        .flatMap((k) => {
          const p = (v.properties as Record<string, unknown>)[k];
          return isRecord(p) && "const" in p ? [`${k}=${canonical(p.const)}`] : [];
        })
    : [];
  return [canonical(v.type), canonical(v.const), canonical(v.$recursive), ...consts].join("|");
}

/** 同じ変種(中身も同じ)を除き、残りを目印で 1 対 1 に組む */
function pairVariants(av: unknown[], bv: unknown[]): { identical: unknown[]; pairs: Array<[unknown, unknown]>; onlyA: unknown[]; onlyB: unknown[] } {
  const identical: unknown[] = [];
  const restA: unknown[] = [];
  const restB = [...bv];
  for (const a of av) {
    const i = restB.findIndex((b) => same(a, b));
    if (i >= 0) {
      identical.push(a);
      restB.splice(i, 1);
    } else restA.push(a);
  }
  const pairs: Array<[unknown, unknown]> = [];
  const onlyA: unknown[] = [];
  for (const a of restA) {
    const i = restB.findIndex((b) => variantSignature(a) === variantSignature(b));
    if (i >= 0) pairs.push([a, restB.splice(i, 1)[0]]);
    else onlyA.push(a);
  }
  return { identical, pairs, onlyA, onlyB: restB };
}

// ---- breaking ----

function breakingSchema(a: unknown, b: unknown, dir: Dir, at: string, out: string[]): void {
  if (!isRecord(a) || !isRecord(b) || same(a, b)) return;
  const typeA = canonical(a.type);
  if (typeA !== canonical(b.type)) {
    out.push(`${at}: 型が変わりました(${show(a.type)} → ${show(b.type)})`);
    return;
  }
  if (("const" in a || "const" in b) && !same(a.const, b.const)) out.push(`${at}: const が変わりました(${show(a.const)} → ${show(b.const)})`);

  // enum: 値の削除は両方向で breaking(要求は受けなくなる / 応答は古いクライアントが扱う値が変わる)
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    for (const v of a.enum) if (!b.enum.some((w) => same(v, w))) out.push(`${at}: enum の値 ${canonical(v)} が削除されました`);
  } else if (dir === "request" && a.enum === undefined && Array.isArray(b.enum)) out.push(`${at}: enum で値が絞られました`);

  const propsA = isRecord(a.properties) ? a.properties : {};
  const propsB = isRecord(b.properties) ? b.properties : {};
  const requiredA = Array.isArray(a.required) ? (a.required as string[]) : [];
  const requiredB = Array.isArray(b.required) ? (b.required as string[]) : [];
  // 要求の object が additionalProperties: false(z.strictObject)なら、消したプロパティを送り続ける古いクライアントは 422 になる
  const strictRequest = dir === "request" && a.additionalProperties === false;
  for (const name of Object.keys(propsA).sort()) {
    if (!(name in propsB)) {
      if (dir === "response") out.push(`${at}.${name}: 応答のプロパティが削除されました`);
      else if (strictRequest) out.push(`${at}.${name}: 要求のプロパティが削除されました(未知のプロパティは 422 になります)`);
    } else breakingSchema(propsA[name], propsB[name], dir, `${at}.${name}`, out);
  }
  if (dir === "request") {
    for (const name of requiredB) {
      if (requiredA.includes(name)) continue;
      if (name in propsA) out.push(`${at}.${name}: 要求のプロパティが必須になりました`);
      else if (name in propsB) out.push(`${at}.${name}: 要求の必須プロパティが追加されました`);
    }
    if (b.additionalProperties === false && a.additionalProperties !== false) out.push(`${at}: 要求が未知のプロパティを受けなくなりました`);
  } else {
    // 応答で必須でなくなると、古いクライアントは「必ずある」前提で読んでいるので壊れる
    for (const name of requiredA) if (!requiredB.includes(name) && name in propsB) out.push(`${at}.${name}: 応答のプロパティが必須でなくなりました`);
  }

  for (const key of ["additionalProperties", "items", "not", "propertyNames"]) {
    if (isRecord(a[key]) && isRecord(b[key])) breakingSchema(a[key], b[key], dir, `${at}.${key === "items" ? "[]" : key === "additionalProperties" ? "*" : key}`, out);
  }
  if (Array.isArray(a.prefixItems) && Array.isArray(b.prefixItems)) {
    a.prefixItems.forEach((s, i) => breakingSchema(s, (b.prefixItems as unknown[])[i], dir, `${at}[${i}]`, out));
  }
  for (const key of VARIANT_KEYS) {
    if (!Array.isArray(a[key]) || !Array.isArray(b[key])) continue;
    const { pairs, onlyA } = pairVariants(a[key] as unknown[], b[key] as unknown[]);
    for (const [x, y] of pairs) breakingSchema(x, y, dir, `${at}.${key}`, out);
    // 変種(const で判別する union など)の削除・改名は、enum の値の削除と同じ: 要求は受けなくなり、応答は古いクライアントが扱う形が変わる
    for (const x of onlyA) {
      out.push(`${at}.${key}: ${dir === "request" ? "受け付ける形" : "応答の形"}が削除されました(${show(variantSignature(x))})`);
    }
  }

  if (dir === "request") breakingConstraints(a, b, at, out);
}

/** 要求の値の制約を狭める変更(足す・max を減らす・min を増やす・pattern を変える) */
function breakingConstraints(a: Record<string, unknown>, b: Record<string, unknown>, at: string, out: string[]): void {
  for (const key of MAX_KEYS) {
    const x = a[key];
    const y = b[key];
    if (typeof y === "number" && (typeof x !== "number" || y < x)) out.push(`${at}: ${key} が狭まりました(${show(x)} → ${y})`);
  }
  for (const key of MIN_KEYS) {
    const x = a[key];
    const y = b[key];
    if (typeof y === "number" && (typeof x !== "number" || y > x)) out.push(`${at}: ${key} が狭まりました(${show(x)} → ${y})`);
  }
  if (typeof b.pattern === "string" && b.pattern !== a.pattern) out.push(`${at}: pattern が変わりました(${show(a.pattern)} → ${b.pattern})`);
}

function breakingOperation(key: string, a: OperationContract, b: OperationContract, out: string[]): void {
  for (const name of Object.keys(b.parameters).sort()) {
    const pb = b.parameters[name]!;
    const pa = a.parameters[name];
    if (!pa) {
      if (pb.required) out.push(`${key}: 必須の引数 ${name} が追加されました`);
      continue;
    }
    if (!pa.required && pb.required) out.push(`${key}: 引数 ${name} が必須になりました`);
    breakingSchema(pa.schema, pb.schema, "request", `${key} 引数 ${name}`, out);
  }
  if (b.requestBody) {
    if (!a.requestBody) {
      if (b.requestBody.required) out.push(`${key}: 必須の要求 body が追加されました`);
    } else {
      if (!a.requestBody.required && b.requestBody.required) out.push(`${key}: 要求 body が必須になりました`);
      for (const media of Object.keys(a.requestBody.content).sort()) {
        const sb = b.requestBody.content[media];
        if (sb === undefined) out.push(`${key}: 要求 body の ${media} を受けなくなりました`);
        else breakingSchema(a.requestBody.content[media], sb, "request", `${key} 要求 ${media}`, out);
      }
    }
  }
  for (const status of Object.keys(a.responses).sort()) {
    const ra = a.responses[status]!;
    const rb = b.responses[status];
    if (!rb) {
      if (isSuccessStatus(status)) out.push(`${key}: 応答 ${status} が削除されました`);
      continue;
    }
    for (const media of Object.keys(ra).sort()) {
      const sb = rb[media];
      if (sb === undefined) {
        if (isSuccessStatus(status)) out.push(`${key}: 応答 ${status} の ${media} が削除されました`);
      } else breakingSchema(ra[media], sb, "response", `${key} 応答 ${status} ${media}`, out);
    }
  }
}

// ---- 和(足すだけ) ----

function mergeSchema(a: unknown, b: unknown, dir: Dir): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (!isRecord(a) || !isRecord(b)) return a; // true / false など。基準を勝手に書き換えない
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys(a, b)) {
    const x = a[key];
    const y = b[key];
    let merged: unknown;
    if (MAX_KEYS.includes(key) || MIN_KEYS.includes(key)) {
      // 緩い側を残す(どちらかに無ければ制約なし = 緩い側)。要求で狭める変更は breaking として別に止まる
      merged = typeof x === "number" && typeof y === "number" ? (MAX_KEYS.includes(key) ? Math.max(x, y) : Math.min(x, y)) : undefined;
    } else if (key === "pattern") {
      merged = typeof x === "string" && typeof y === "string" ? x : undefined;
    } else if (key === "properties" && isRecord(x) && isRecord(y)) {
      merged = Object.fromEntries(sortedKeys(x, y).map((n) => [n, mergeSchema(x[n], y[n], dir)]));
    } else if (key === "required") {
      const xs = Array.isArray(x) ? (x as string[]) : [];
      const ys = Array.isArray(y) ? (y as string[]) : [];
      // 要求は必須が減る側(緩い側 = 共通部分)、応答は必須が増える側(合併)を残す
      const list = dir === "request" ? xs.filter((n) => ys.includes(n)) : [...new Set([...xs, ...ys])].sort();
      merged = list.length > 0 ? list : undefined;
    } else if (key === "enum" && Array.isArray(x) && Array.isArray(y)) {
      merged = [...x, ...y.filter((v) => !x.some((w) => same(v, w)))].sort(byCanonical);
    } else if (VARIANT_KEYS.includes(key) && Array.isArray(x) && Array.isArray(y)) {
      const { identical, pairs, onlyA, onlyB } = pairVariants(x, y);
      merged = [...identical, ...pairs.map(([p, q]) => mergeSchema(p, q, dir)), ...onlyA, ...onlyB].sort(byCanonical);
    } else if (key === "prefixItems" && Array.isArray(x) && Array.isArray(y)) {
      merged = Array.from({ length: Math.max(x.length, y.length) }, (_, i) => mergeSchema(x[i], y[i], dir));
    } else if (["additionalProperties", "items", "not", "propertyNames"].includes(key) && isRecord(x) && isRecord(y)) {
      merged = mergeSchema(x, y, dir);
    } else if (x === undefined) {
      merged = y;
    } else {
      merged = x; // type / const など。変わった差は breaking として別に止まる
    }
    if (merged !== undefined) out[key] = merged;
  }
  return sortKeys(out);
}

function mergeMedia(a: Record<string, JsonSchema>, b: Record<string, JsonSchema>, dir: Dir): Record<string, JsonSchema> {
  return Object.fromEntries(sortedKeys(a, b).map((m) => [m, mergeSchema(a[m], b[m], dir) as JsonSchema]));
}

function mergeOperation(a: OperationContract, b: OperationContract): OperationContract {
  const parameters: Record<string, ParameterContract> = {};
  for (const name of sortedKeys(a.parameters, b.parameters)) {
    const pa = a.parameters[name];
    const pb = b.parameters[name];
    parameters[name] = pa && pb ? { required: pa.required && pb.required, schema: mergeSchema(pa.schema, pb.schema, "request") as JsonSchema } : (pa ?? pb)!;
  }
  const responses: Record<string, Record<string, JsonSchema>> = {};
  for (const status of sortedKeys(a.responses, b.responses)) responses[status] = mergeMedia(a.responses[status] ?? {}, b.responses[status] ?? {}, "response");
  const out: OperationContract = { parameters, responses };
  const ra = a.requestBody;
  const rb = b.requestBody;
  if (ra && rb) {
    const body: RequestBodyContract = { required: ra.required && rb.required, content: mergeMedia(ra.content, rb.content, "request") };
    out.requestBody = body;
  } else if (ra ?? rb) out.requestBody = (ra ?? rb)!;
  return out;
}

/** 基準 prev に、next で増えた分を足した和(減った分・狭まった分は prev のまま) */
export function mergeContract(prev: Contract, next: Contract): Contract {
  const operations: Record<string, OperationContract> = {};
  for (const key of sortedKeys(prev.operations, next.operations)) {
    const a = prev.operations[key];
    const b = next.operations[key];
    operations[key] = a && b ? mergeOperation(a, b) : (a ?? b)!;
  }
  return { operations };
}

/** prev と merged の差を、人が読める行にする(足された・緩んだ所) */
function describeChanges(a: unknown, m: unknown, at: string, out: string[]): void {
  if (same(a, m)) return;
  if (isRecord(a) && isRecord(m)) {
    for (const k of sortedKeys(a, m)) {
      if (!(k in a)) out.push(`${at}.${k}: 追加`);
      else if (!(k in m)) out.push(`${at}.${k}: 緩和(制約が外れる)`);
      else describeChanges(a[k], m[k], `${at}.${k}`, out);
    }
    return;
  }
  out.push(`${at}: 変更`);
}

export function contractDiff(prev: Contract, next: Contract): ContractDiff {
  const breaking: string[] = [];
  for (const key of Object.keys(prev.operations).sort()) {
    const b = next.operations[key];
    if (!b) breaking.push(`${key}: パスまたはメソッドが削除されました`);
    else breakingOperation(key, prev.operations[key]!, b, breaking);
  }
  const additive: string[] = [];
  describeChanges(prev.operations, mergeContract(prev, next).operations, "", additive);
  return { breaking, additive: additive.map((s) => s.replace(/^\./, "")) };
}

// ---- 基準の更新(contract:update の本体) ----

export interface Versions {
  /** 今の API_CONTRACT_VERSION */
  apiContractVersion: number;
}
export type UpdateResult =
  | { ok: true; baseline: Baseline; additive: string[]; changed: boolean }
  | { ok: false; message: string; details: string[] };

/**
 * 今の契約を基準に足す。基準が無ければ(版を上げた直後)今の契約で新しく作る。
 * breaking な差があれば、基準を変えずに失敗を返す(版を上げずに互換を外す変更を、基準の更新で隠せないように)
 */
export function updateBaseline(baseline: Baseline | undefined, current: Contract, versions: Versions): UpdateResult {
  if (!baseline) return { ok: true, baseline: { apiContractVersion: versions.apiContractVersion, contract: current }, additive: [], changed: true };
  if (baseline.apiContractVersion !== versions.apiContractVersion) {
    return { ok: false, message: `基準の版(${baseline.apiContractVersion})が API_CONTRACT_VERSION(${versions.apiContractVersion})と合いません`, details: [] };
  }
  const { breaking, additive } = contractDiff(baseline.contract, current);
  if (breaking.length > 0) return { ok: false, message: BREAKING_MESSAGE, details: breaking };
  const contract = mergeContract(baseline.contract, current);
  return { ok: true, baseline: { apiContractVersion: baseline.apiContractVersion, contract }, additive, changed: additive.length > 0 };
}
