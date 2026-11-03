import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * router.refresh() の直接の呼び出しは、入口(lib/use-refresh-and-wait.ts の useRefreshAndWait)だけに置く(B173 第 1 段)。
 * router.refresh() は「読み直しが終わるまで待つ」「待っている間の表示を出す」「移動に切り替わったら捨てる」を持たないので、
 * 直接呼ぶと保存のあとの画面が固まったように見えたり、古い読み直しが新しい画面に被さったりする。入口を通せばこの 3 つが付く。
 * 入口へ移していない呼び出しは下の許可の一覧に残し、移し終えたファイルは一覧から消す(一覧は減らす一方。増やさない)
 */
const ROOT = path.join(import.meta.dirname, "..");
const DIRS = ["app", "components", "lib"];
/** router.refresh() を直接呼んでよい入口 */
const ENTRY = "lib/use-refresh-and-wait.ts";
/** 入口へ移し終えていない呼び出しの許可の一覧(第 2 段・第 3 段で減らす) */
const ALLOWLIST = [
  "components/ApiKeysPanel.tsx",
  "components/audience/AudienceBuilder.tsx",
  "components/GoalsPanel.tsx",
  "components/InstanceAdminsPanel.tsx",
  "components/MembersPanel.tsx",
  "components/PublishPanel.tsx",
  "components/StaticStaleBanner.tsx",
  "components/targeting/ConditionFields.tsx",
  "components/usage/UsagePanel.tsx",
  "components/WorkspaceApiKeysPanel.tsx",
];

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(?:ts|tsx)$/.test(e.name) ? [p] : [];
  });

/**
 * router.refresh() を呼んでいる行があるか。行の先頭が // か * か /* の行(説明のコメント)は除く。
 * 行の途中の // は消さない("https://…" などの文字列の中の // で行の残りを落とさないため)。
 * 受け手を router に絞るのは、lib/run-busy.ts の deps.refresh() のように、router ではない注入された関数を拾わないため
 */
const callsRouterRefresh = (src: string): boolean =>
  src.split("\n").some((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line) && /\brouter\.refresh\(\)/.test(line));

const callers = DIRS.flatMap((d) => walk(path.join(ROOT, d)))
  .map((f) => path.relative(ROOT, f))
  .filter((f) => callsRouterRefresh(readFileSync(path.join(ROOT, f), "utf8")));

describe("router.refresh() の直接の呼び出し", () => {
  it("router.refresh() is called only from the entry or the allowlist", () => {
    expect(callers.filter((f) => f !== ENTRY && !ALLOWLIST.includes(f))).toEqual([]);
  });

  it("the entry itself still calls router.refresh() (the check above would pass vacuously if the entry moved)", () => {
    expect(callers).toContain(ENTRY);
  });

  it("every allowlisted file still calls router.refresh() (shrink the list when you migrate a caller)", () => {
    expect(ALLOWLIST.filter((f) => !callers.includes(f))).toEqual([]);
  });
});
