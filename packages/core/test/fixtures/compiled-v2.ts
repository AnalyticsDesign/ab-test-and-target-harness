import { compileRegex } from "../../src/regex-compile";
import type { CompiledConfigV2 } from "../../src/schema-v2";

/**
 * 版 2 の compiled config(B69 の版 2 の読み取りの fixture)。版 3 に切り替える前の compile(版 2)が出した値をそのまま写した
 * (命令列は手で書かない)。
 * - e_path_re: 対象 URL がパスの正規表現。配信条件なし
 * - e_host_re: 対象 URL がホストの正規表現。配信条件は端末だけ
 * - e_query: 配信条件にクエリの条件を持つ(版 3 で表せない = upgradeV2 が外す)。persistAssignment: true の唯一のエクスペリエンス
 *   (外すと needsProfile が true → false になる)
 * - e_plain: 対象 URL が URL の「で始まる」。配信率 50
 * results.runs は e_path_re・e_query・e_plain
 */
export const COMPILED_V2: CompiledConfigV2 = {
  schemaVersion: 2, version: 7, siteId: "site_v2", siteSalt: "salt_v2", needsProfile: true, timezone: "Asia/Tokyo",
  patterns: {},
  prehide: { e_path_re: ["#e_path_re"], e_host_re: ["#e_host_re"], e_query: ["#e_query"], e_plain: ["#e_plain"] },
  exposureSelectors: { e_path_re: ["#e_path_re"], e_host_re: ["#e_host_re"], e_query: ["#e_query"], e_plain: ["#e_plain"] },
  goals: [{ id: "g_buy", type: "PAGEVIEW", config: { page: { part: "path", op: "startsWith", value: "/thanks" } } }],
  experiments: [
    {
      id: "e_path_re", trafficPercentage: 100, persistAssignment: false,
      urlMatch: {
        part: "path", op: "regex", value: "^/products/\\d+$",
        prog: {
          v: 1,
          sets: [[0, 32768, 0, 0], [0, 0, 0, 65536], [0, 0, 0, 262144], [0, 0, 0, 32768], [0, 0, 0, 16], [0, 0, 0, 2097152], [0, 0, 0, 8], [0, 0, 0, 1048576], [0, 0, 0, 524288], [0, 67043328, 0, 0]],
          code: [3, 0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0, 6, 0, 0, 7, 0, 0, 8, 0, 0, 0, 0, 0, 9, 0, 1, 11, 13, 4, 0, 0, 5, 0, 0],
        },
      },
      variants: [{ id: "a", weight: 50, changes: [{ id: "c1", type: "TEXT", selector: "#e_path_re", payload: { text: "x" } }] }, { id: "b", weight: 50, changes: [] }],
    },
    {
      id: "e_host_re", trafficPercentage: 100, persistAssignment: false,
      urlMatch: {
        part: "host", op: "regex", value: "^(www|shop)\\.example\\.com$",
        prog: {
          v: 1,
          sets: [[0, 0, 0, 8388608], [0, 0, 0, 524288], [0, 0, 0, 256], [0, 0, 0, 32768], [0, 0, 0, 65536], [0, 16384, 0, 0], [0, 0, 0, 32], [0, 0, 0, 16777216], [0, 0, 0, 2], [0, 0, 0, 8192], [0, 0, 0, 4096], [0, 0, 0, 8]],
          code: [3, 0, 0, 1, 2, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 10, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0, 6, 0, 0, 7, 0, 0, 8, 0, 0, 9, 0, 0, 4, 0, 0, 10, 0, 0, 6, 0, 0, 5, 0, 0, 11, 0, 0, 3, 0, 0, 9, 0, 4, 0, 0, 5, 0, 0],
        },
      },
      targeting: { ctx: "device", op: "in", value: ["mobile"] },
      variants: [{ id: "a", weight: 50, changes: [{ id: "c1", type: "TEXT", selector: "#e_host_re", payload: { text: "x" } }] }, { id: "b", weight: 50, changes: [] }],
    },
    {
      id: "e_query", trafficPercentage: 100, persistAssignment: true,
      urlMatch: { op: "contains", value: "/" },
      targeting: { and: [{ ctx: "device", op: "in", value: ["mobile"] }, { ctx: "query", name: "utm", op: "equals", value: "mail" }] },
      variants: [{ id: "a", weight: 50, changes: [{ id: "c1", type: "TEXT", selector: "#e_query", payload: { text: "x" } }] }, { id: "b", weight: 50, changes: [] }],
    },
    {
      id: "e_plain", trafficPercentage: 50, persistAssignment: false,
      urlMatch: { op: "startsWith", value: "https://www.example.com/lp/" },
      variants: [{ id: "a", weight: 50, changes: [{ id: "c1", type: "TEXT", selector: "#e_plain", payload: { text: "x" } }] }, { id: "b", weight: 50, changes: [] }],
    },
  ],
  exposurePayloads: {
    e_path_re: { a: { experimentId: "e_path_re", experimentName: "e_path_re", variantId: "a", variantName: "a", extra: {} }, b: { experimentId: "e_path_re", experimentName: "e_path_re", variantId: "b", variantName: "b", extra: {} } },
    e_host_re: { a: { experimentId: "e_host_re", experimentName: "e_host_re", variantId: "a", variantName: "a", extra: {} }, b: { experimentId: "e_host_re", experimentName: "e_host_re", variantId: "b", variantName: "b", extra: {} } },
    e_query: { a: { experimentId: "e_query", experimentName: "e_query", variantId: "a", variantName: "a", extra: {} }, b: { experimentId: "e_query", experimentName: "e_query", variantId: "b", variantName: "b", extra: {} } },
    e_plain: { a: { experimentId: "e_plain", experimentName: "e_plain", variantId: "a", variantName: "a", extra: {} }, b: { experimentId: "e_plain", experimentName: "e_plain", variantId: "b", variantName: "b", extra: {} } },
  },
  conversionPayloads: { g_buy: { goalId: "g_buy", goalName: "g_buy" } },
  results: { forget: true, runs: { e_path_re: "runAAAAAAAAAAAAAAAAAAA", e_query: "runBBBBBBBBBBBBBBBBBBB", e_plain: "runCCCCCCCCCCCCCCCCCCC" } },
};

const progOf = (src: string) => {
  const r = compileRegex(src);
  if (!r.ok) throw new Error(r.issue.code);
  return r.prog; // regex-compile.ts は B69 で変えていないので、版 2 の compile が出した命令列と同じ
};
const twoVariants = [{ id: "a", weight: 50, changes: [] }, { id: "b", weight: 50, changes: [] }];
/** 版 2 の配る形の配信条件に書けたページの条件(KV に残る形。正規表現は命令列つき) */
export const V2_PAGE_TARGETINGS = {
  e_url: { ctx: "url", op: "contains", value: "/lp/" },
  e_host: { ctx: "host", op: "endsWith", value: "example.com" },
  e_path_re: { ctx: "path", op: "regex", value: "^/products/\\d+$", prog: progOf("^/products/\\d+$") },
  e_host_re: { ctx: "host", op: "regex", value: "^shop\\.", prog: progOf("^shop\\.") },
  e_q_contains: { ctx: "query", name: "utm", op: "contains", value: "mail" },
  e_q_exists: { ctx: "query", name: "ref", op: "exists" },
  e_nested: { and: [{ ctx: "device", op: "in", value: ["mobile"] }, { not: { ctx: "path", op: "regex", value: "^/a/", prog: progOf("^/a/") } }] },
} as const;

/**
 * 配信条件にページの条件(版 2 で書けた 4 種類のすべての形)を持つ版 2。e_keep だけが持たない。
 * 版 2 の凍結したスキーマが読めること(読めないとサイト全体が配られない)と、upgradeV2 が持つものだけを外すことを確かめる
 */
export const PAGE_CTX_V2: CompiledConfigV2 = {
  schemaVersion: 2, version: 3, siteId: "site_pc", siteSalt: "salt_pc", needsProfile: false,
  patterns: {},
  prehide: Object.fromEntries([...Object.keys(V2_PAGE_TARGETINGS), "e_keep"].map((id) => [id, [`#${id}`]])),
  exposureSelectors: Object.fromEntries([...Object.keys(V2_PAGE_TARGETINGS), "e_keep"].map((id) => [id, [`#${id}`]])),
  goals: [],
  experiments: [
    ...Object.entries(V2_PAGE_TARGETINGS).map(([id, targeting]) => ({
      id, trafficPercentage: 100, persistAssignment: false, urlMatch: { op: "contains" as const, value: "/" }, targeting: targeting as CompiledConfigV2["experiments"][number]["targeting"], variants: twoVariants,
    })),
    { id: "e_keep", trafficPercentage: 100, persistAssignment: false, urlMatch: { op: "contains", value: "/" }, targeting: { ctx: "referrer", op: "isEmpty" }, variants: twoVariants },
  ],
  results: { forget: true, runs: { e_path_re: "runDDDDDDDDDDDDDDDDDDD", e_keep: "runEEEEEEEEEEEEEEEEEEE" } },
};

/**
 * 名前付きの版 2(B77 より前の compile が出した形)。payload を持たず、名前だけを持つ(dataLayer の名前は名前から出ていた)
 */
export const NAMED_V2: CompiledConfigV2 = {
  schemaVersion: 2, version: 4, siteId: "site_l", siteSalt: "s", needsProfile: false,
  patterns: {}, prehide: {}, exposureSelectors: {},
  goals: [{ id: "g_buy", name: "購入完了", type: "CUSTOM", config: {} }],
  experiments: [{
    id: "exp1", name: "社内のヒーロー検証", trafficPercentage: 100, persistAssignment: false,
    urlMatch: { op: "contains", value: "/lp/" },
    variants: [{ id: "a", name: "A案", weight: 50, changes: [] }, { id: "b", name: "社内の部長案", weight: 50, changes: [] }],
  }],
};
