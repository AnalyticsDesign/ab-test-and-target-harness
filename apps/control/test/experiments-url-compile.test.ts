import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// B69 追補(追 §5): 保存の検査は対象 URL の正規表現を 1 回だけコンパイルし、合計の命令数が上限を超えた時点で止める。
// core の検査(urlMatchIssue)が内部で呼ぶ regex-compile を直接包む(@wtt/core の export を包んでも core の内部の呼び出しは数えられない)。
// 素通しの spy なので挙動は変わらない。
// setupFiles(apply-migrations.ts → helpers → app)が先に core を読み込んでいて、そのままでは spy が効かないので、
// vi.resetModules() の後に app(helpers)と core を読み直す(spy と app が同じ core を見る)
vi.mock("../../../packages/core/src/regex-compile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../packages/core/src/regex-compile")>();
  return { ...mod, compileRegex: vi.fn(mod.compileRegex) };
});

type Helpers = typeof import("./helpers");
let h: Helpers;
let spy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  vi.resetModules();
  h = await import("./helpers");
  const rc = await import("../../../packages/core/src/regex-compile");
  expect(vi.isMockFunction(rc.compileRegex)).toBe(true);
  spy = vi.mocked(rc.compileRegex) as unknown as ReturnType<typeof vi.fn>;
});

const rx = (value: string, part: "path" | "host" = "path") => ({ part, op: "regex", value });
const R = "^/[a-z]{21}$"; // 25 命令

async function setup() {
  const owner = await h.setupOwner();
  const { id: sid } = await h.createSite(owner.token, owner.workspaceId);
  const { id: eid } = await h.createExperiment(owner.token, sid);
  return { owner, sid, eid };
}

describe("対象 URL の保存での正規表現のコンパイル(B69 and)", () => {
  beforeEach(() => {
    spy?.mockClear(); // 波括弧で包む(関数を返すと vitest が後始末として呼ぶ)
  });

  it("save_compiles_each_regex_once", async () => {
    const { owner, sid, eid } = await setup();
    // 正規表現は page に 1 つ・and に 1 つだけ(目標・オーディエンスなど、他の正規表現はこの要求に無い)
    const urlMatch = { include: [{ page: rx("^/lp/[a-z]+$"), and: [rx("^www\\.", "host"), { part: "path", op: "contains", value: "x" }] }] };
    spy.mockClear(); // 作成の分は数えない
    const res = await h.call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { urlMatch } });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2); // 正規表現の要素の数と同じ(文字列の照合はコンパイルしない)
    // POST も同じ
    spy.mockClear();
    const post = await h.call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_post", name: "P", urlMatch } });
    expect(post.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("save_stops_compiling_after_instruction_limit", async () => {
    const { owner, sid, eid } = await setup();
    // 1 つ 25 命令 × 30 個(6 個 × 5 行)。21 個目(500 + 25)で止まり、残りはコンパイルしない
    const row = { page: rx(R), and: [rx(R), rx(R), rx(R), rx(R), rx(R)] };
    spy.mockClear();
    const res = await h.call("PATCH", `/sites/${sid}/experiments/${eid}`, { token: owner.token, body: { urlMatch: { include: Array.from({ length: 5 }, () => row) } } });
    expect(res.status).toBe(422);
    expect(await h.json(res)).toMatchObject({ error: "url_match_too_large", path: ["urlMatch"] });
    expect(spy).toHaveBeenCalledTimes(21);
  });
});
