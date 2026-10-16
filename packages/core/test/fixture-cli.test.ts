import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CompiledConfigSchema } from "../src/schema";
import { SiteSettingsSchema } from "../src/settings";
import { compile, LIMITS } from "../src/index";

const ROOT = new URL("../../..", import.meta.url).pathname;

describe("fixture CLI", () => {
  it("all_change_types_compile_round_trip", () => {
    const out = `${ROOT}/packages/core/test/.tmp-config.json`;
    rmSync(out, { force: true });
    execFileSync("pnpm", ["fixture", "fixtures/demo.json", out], { cwd: ROOT, stdio: "pipe" });
    const cfg = CompiledConfigSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    const input = JSON.parse(readFileSync(`${ROOT}/fixtures/demo.json`, "utf8"));
    const changes = cfg.experiments[0]!.variants[1]!.changes;
    expect(new Set(changes.map((c) => c.type))).toEqual(new Set(["TEXT", "IMAGE", "HIDE", "ATTRIBUTE", "HTML", "CSS", "CUSTOM_JS"]));
    expect(changes).toEqual(input.experiments[0].variants[1].changes);
    expect(cfg.prehide["exp_hero"]).toContain(".hero-title");
    expect(cfg.goals).toEqual(input.goals);
    rmSync(out, { force: true });
  });
  it("exits 1 with legacy_targeting on stderr and creates no output", () => {
    const badPath = `${ROOT}/packages/core/test/.tmp-bad.json`;
    const outPath = `${ROOT}/packages/core/test/.tmp-out.json`;
    const bad = JSON.parse(readFileSync(`${ROOT}/fixtures/demo.json`, "utf8"));
    bad.experiments[0].targeting = { hist: "visited", pattern: "p_nope" };
    writeFileSync(badPath, JSON.stringify(bad));
    rmSync(outPath, { force: true });
    try {
      execFileSync("pnpm", ["fixture", badPath, outPath], { cwd: ROOT, stdio: "pipe" });
      throw new Error("expected failure");
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      expect(err.status).toBe(1);
      expect(String(err.stderr)).toContain("legacy_targeting");
    }
    expect(existsSync(outPath)).toBe(false);
    rmSync(badPath, { force: true });
  });
  it("cli_malformed_json_prints_invalid_input_and_creates_no_output", () => {
    const badPath = `${ROOT}/packages/core/test/.tmp-notjson.json`;
    const outPath = `${ROOT}/packages/core/test/.tmp-out2.json`;
    writeFileSync(badPath, "{ not json");
    rmSync(outPath, { force: true });
    try {
      execFileSync("pnpm", ["fixture", badPath, outPath], { cwd: ROOT, stdio: "pipe" });
      throw new Error("expected failure");
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      expect(err.status).toBe(1);
      expect(String(err.stderr)).toContain("invalid_input");
    }
    expect(existsSync(outPath)).toBe(false);
    rmSync(badPath, { force: true });
  });
  it("kv_bulk_output_uses_compact_json_and_settings_defaults(繰越 2・3)", () => {
    const out = `${ROOT}/packages/core/test/.tmp-config-kv.json`;
    const bulk = `${ROOT}/packages/core/test/.tmp-bulk.json`;
    rmSync(out, { force: true });
    rmSync(bulk, { force: true });
    execFileSync("pnpm", ["fixture", "fixtures/demo.json", out, "--kv-bulk", bulk], { cwd: ROOT, stdio: "pipe" });
    const entries = JSON.parse(readFileSync(bulk, "utf8")) as Array<{ key: string; value: string }>;
    const byKey = new Map(entries.map((e) => [e.key, e.value]));
    const compact = byKey.get("site:site_demo:config:v1")!;
    // KV 値は compact = pretty 出力を re-stringify したものと 1 バイトも違わない(512KB 計測との整合)
    expect(compact).toBe(JSON.stringify(JSON.parse(readFileSync(out, "utf8"))));
    expect(compact).not.toContain("\n");
    expect(byKey.get("site:site_demo:active")).toBe("1");
    const settings = SiteSettingsSchema.parse(JSON.parse(byKey.get("site:site_demo:settings")!));
    expect(settings.siteId).toBe("site_demo");
    expect(settings.visitorCookieName).toBe("_ab_vid");
    expect(settings.uuidCookieEnabled).toBe(true); // fixtures/demo.json は E2E harness 用に明示 true(plan 3 task 8)
    expect(settings.hosts).toEqual([]);
    expect(entries.some((e) => e.key.startsWith("host:"))).toBe(false);
    rmSync(out, { force: true });
    rmSync(bulk, { force: true });
  });
  it("kv_bulk_emits_host_keys_for_dlite_fixture", () => {
    const out = `${ROOT}/packages/core/test/.tmp-dlite-config.json`;
    const bulk = `${ROOT}/packages/core/test/.tmp-dlite-bulk.json`;
    rmSync(out, { force: true });
    rmSync(bulk, { force: true });
    execFileSync("pnpm", ["fixture", "fixtures/demo-dlite.json", out, "--kv-bulk", bulk], { cwd: ROOT, stdio: "pipe" });
    const entries = JSON.parse(readFileSync(bulk, "utf8")) as Array<{ key: string; value: string }>;
    const byKey = new Map(entries.map((e) => [e.key, e.value]));
    expect(byKey.get("host:localhost")).toBe("site_demo_dlite");
    const settings = SiteSettingsSchema.parse(JSON.parse(byKey.get("site:site_demo_dlite:settings")!));
    expect(settings.mode).toBe("B");
    rmSync(out, { force: true });
    rmSync(bulk, { force: true });
  });
  it("--static-dir は配信専用の Worker と同じパスで焼いたファイルを書く(apiBase と runtime のハッシュ入り。決定 52)", async () => {
    const { PREVIEW_HASH, RUNTIME_HASH } = await import("../../runtime/generated/source");
    const out = `${ROOT}/packages/core/test/.tmp-static`;
    rmSync(out, { recursive: true, force: true });
    execFileSync("pnpm", ["fixture", "fixtures/demo.json", `${out}/c.json`, "--static-dir", `${out}/static`, "--api-base", "http://localhost:4173"], { cwd: ROOT, stdio: "pipe" });
    const cfg = CompiledConfigSchema.parse(JSON.parse(readFileSync(`${out}/c.json`, "utf8")));
    const text = readFileSync(`${out}/static/s/${cfg.siteId}.js`, "utf8");
    expect(text.startsWith(`/* AB Test and Target Harness bootstrap (site ${cfg.siteId}, config v${cfg.version}, runtime ${RUNTIME_HASH}) */\n`)).toBe(true);
    expect(text).toContain('"apiBase":"http://localhost:4173"');
    expect(existsSync(`${out}/static/s/preview/${PREVIEW_HASH}.js`)).toBe(true);
    rmSync(out, { recursive: true, force: true });
  });
  it("invalid_settings_block_exits_1_with_invalid_input_and_no_output", () => {
    const badPath = `${ROOT}/packages/core/test/.tmp-badsettings.json`;
    const outPath = `${ROOT}/packages/core/test/.tmp-out3.json`;
    const bad = JSON.parse(readFileSync(`${ROOT}/fixtures/demo.json`, "utf8"));
    bad.settings = { uuidCookieName: "_ab_vid" }; // 正本名と同名 → refine 違反
    writeFileSync(badPath, JSON.stringify(bad));
    rmSync(outPath, { force: true });
    try {
      execFileSync("pnpm", ["fixture", badPath, outPath], { cwd: ROOT, stdio: "pipe" });
      throw new Error("expected failure");
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      expect(err.status).toBe(1);
      expect(String(err.stderr)).toContain("invalid_input");
    }
    expect(existsSync(outPath)).toBe(false);
    rmSync(badPath, { force: true });
  });
  it("settings_block_cannot_override_reserved_fields", () => {
    const badPath = `${ROOT}/packages/core/test/.tmp-reserved.json`;
    const outPath = `${ROOT}/packages/core/test/.tmp-out4.json`;
    const bad = JSON.parse(readFileSync(`${ROOT}/fixtures/demo.json`, "utf8"));
    bad.settings = { siteId: "evil" }; // 予約フィールドは settings ブロックから注入できない
    writeFileSync(badPath, JSON.stringify(bad));
    rmSync(outPath, { force: true });
    try {
      execFileSync("pnpm", ["fixture", badPath, outPath], { cwd: ROOT, stdio: "pipe" });
      throw new Error("expected failure");
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      expect(err.status).toBe(1);
      expect(String(err.stderr)).toContain("invalid_input");
    }
    expect(existsSync(outPath)).toBe(false);
    rmSync(badPath, { force: true });
  });
  it("cli_creates_missing_output_directories", () => {
    const dir1 = `${ROOT}/packages/core/test/.tmp-newdir`;
    const dir2 = `${ROOT}/packages/core/test/.tmp-newdir2`;
    const out = `${dir1}/out.json`;
    const bulk = `${dir2}/bulk.json`;
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
    execFileSync("pnpm", ["fixture", "fixtures/demo.json", out, "--kv-bulk", bulk], { cwd: ROOT, stdio: "pipe" });
    expect(existsSync(out)).toBe(true);
    expect(existsSync(bulk)).toBe(true);
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });
  it("kv_value_bytes_match_compile_size_check", () => {
    const out = `${ROOT}/packages/core/test/.tmp-size-out.json`;
    const bulk = `${ROOT}/packages/core/test/.tmp-size-bulk.json`;
    rmSync(out, { force: true });
    rmSync(bulk, { force: true });
    execFileSync("pnpm", ["fixture", "fixtures/demo.json", out, "--kv-bulk", bulk], { cwd: ROOT, stdio: "pipe" });
    const entries = JSON.parse(readFileSync(bulk, "utf8")) as Array<{ key: string; value: string }>;
    const byKey = new Map(entries.map((e) => [e.key, e.value]));
    const compact = byKey.get("site:site_demo:config:v1")!;
    const input = JSON.parse(readFileSync(`${ROOT}/fixtures/demo.json`, "utf8"));
    const { settings: _s, ...def } = input;
    // bulk の KV 値 = compile() の計測対象と同一バイト列、かつ 512KB 以内
    expect(compact).toBe(JSON.stringify(compile(def)));
    expect(new TextEncoder().encode(compact).length).toBeLessThanOrEqual(LIMITS.configMaxBytes);
    rmSync(out, { force: true });
    rmSync(bulk, { force: true });
  });
  it("cli_warns_when_derived_name_exceeds_100_chars_but_still_writes_output", () => {
    // spec §10.9 / §13.5: 導出値(name)の 100 字上限は共有スキーマに入れない。fixture CLI は警告のみで出力は書く。
    // 元の name を直接見るので、短い override で隠れていても警告される(CX-Medium-1)
    const inPath = `${ROOT}/packages/core/test/.tmp-longname.json`;
    const outPath = `${ROOT}/packages/core/test/.tmp-longname-out.json`;
    const def = JSON.parse(readFileSync(`${ROOT}/fixtures/demo.json`, "utf8"));
    def.experiments[0].name = "x".repeat(101);
    def.experiments[0].analytics = { overrides: { experimentName: "Short" } }; // override は短い → payload 側は 100 字以内
    def.experiments[0].variants[1].name = "z".repeat(101);
    def.experiments[0].variants[1].analytics = { overrides: { variantName: "Short B" } };
    def.goals[0].name = "y".repeat(101);
    writeFileSync(inPath, JSON.stringify(def));
    rmSync(outPath, { force: true });
    // execFileSync は成功時に stderr を返さないので、警告の検証には spawnSync を使う(exit 0 + stderr の両方を見る)
    const r = spawnSync("pnpm", ["fixture", inPath, outPath], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/warning: experiments\.exp_hero\.name: experiment exp_hero: name is 101 chars/);
    expect(r.stderr).toMatch(/warning: experiments\.exp_hero\.variants\.vB\.name: experiment exp_hero variant vB: name is 101 chars/);
    expect(r.stderr).toMatch(/warning: goals\.g_lead\.name: goal g_lead: name is 101 chars/);
    expect(r.stderr).not.toMatch(/exposurePayloads\./); // 解決済み payload は override で 100 字以内なので警告なし
    expect(existsSync(outPath)).toBe(true);
    const cfg = CompiledConfigSchema.parse(JSON.parse(readFileSync(outPath, "utf8")));
    expect(cfg.exposurePayloads!["exp_hero"]!["vA"]!.experimentName).toBe("Short");
    expect(cfg.experiments[0]!.name).toHaveLength(101); // 共有スキーマは長い name を拒否しない(§10.9)
    rmSync(inPath, { force: true });
    rmSync(outPath, { force: true });
  });
});
