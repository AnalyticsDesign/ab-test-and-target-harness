import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { compile, compileRegex, parseCompiledConfig } from "@wtt/core";
import { getDb } from "../src/db";
import { call, createExperiment, createSite, json, publishRes, runDirect, setupOwner } from "./helpers";

async function site(): Promise<{ owner: Awaited<ReturnType<typeof setupOwner>>; sid: string }> {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  return { owner, sid };
}
type PublishBody = { ok: boolean; error?: string; hint?: string; warnings?: Array<{ path: string; message: string }> };

describe("正規表現の規則(決定 49、設計書 §10)", () => {
  it("regex_policy_is_enforced_in_all_three_layers", async () => {
    // (1) control の保存: 理由のコード・日本語の説明・位置・書き換えの例付きの 422
    const { owner, sid } = await site();
    const urlRe = await call("POST", `/sites/${sid}/experiments`, { token: owner.token, body: { id: "exp_re", name: "R", urlMatch: { op: "regex", value: "^/a" } } });
    expect(urlRe.status).toBe(422);
    expect(await json(urlRe)).toMatchObject({ error: "regex_not_allowed_on_url", path: ["urlMatch", "value"] });
    const unbounded = await call("POST", `/sites/${sid}/experiments`, {
      token: owner.token,
      body: { id: "exp_re", name: "R", urlMatch: { op: "contains", value: "/" }, targeting: { and: [{ ctx: "device", op: "in", value: ["mobile"] }, { ctx: "path", op: "regex", value: "a{2,}" }] } },
    });
    expect(unbounded.status).toBe(422);
    expect(await json(unbounded)).toMatchObject({ error: "regex_unbounded_repeat", path: ["targeting", "and", 1, "value"], index: 1, length: 4, hint: "書き換えの例: {2,10}" });
    const goal = await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g_re", name: "G", type: "PAGEVIEW", config: { page: { part: "path", op: "regex", value: "(?=x)" } } } });
    expect(goal.status).toBe(422);
    expect(await json(goal)).toMatchObject({ error: "regex_unsupported_group", path: ["config", "page", "value"] });

    // (2) fixture の compile(`pnpm fixture` が使う関数)
    const exp = (targeting: unknown) => ({
      id: "e", name: "e", urlMatch: { op: "contains", value: "/" }, targeting, trafficPercentage: 100, persistAssignment: false,
      variants: [{ id: "a", name: "A", weight: 50, changes: [] }, { id: "b", name: "B", weight: 50, changes: [] }],
    });
    const input = { siteId: "s", siteSalt: "x", version: 1, goals: [] };
    expect(() => compile({ ...input, experiments: [exp({ ctx: "path", op: "regex", value: "(?=a)" })] })).toThrowError(expect.objectContaining({ code: "invalid_regex" }));

    // (3) edge の読み込み(parseCompiledConfig): 版 2 の url の正規表現・命令列の無い正規表現・サイト全体 500 命令超は読まない
    const ok = compile({ ...input, experiments: [exp({ ctx: "path", op: "regex", value: "^/a" })] });
    expect(parseCompiledConfig(ok)).not.toBeNull();
    const tampered = (patch: (c: Record<string, any>) => void) => {
      const c = JSON.parse(JSON.stringify(ok)) as Record<string, any>;
      patch(c);
      return parseCompiledConfig(c);
    };
    expect(tampered((c) => void (c.experiments[0].targeting = { ctx: "url", op: "regex", value: "a" }))).toBeNull();
    expect(tampered((c) => void delete c.experiments[0].targeting.prog)).toBeNull();
    const big = compileRegex(".{0,98}"); // 197 命令
    if (!big.ok) throw new Error(big.issue.code);
    const p = (v: string) => ({ part: "path", op: "regex", value: v, prog: big.prog });
    expect(tampered((c) => void (c.patterns = { a: p("a"), b: p("b"), c: p("c") }))).toBeNull(); // 591 + 2
  });

  it("保存値を正規化して返す(パスは percent-encoding、ホストは小文字・末尾ドット、正規表現は ¥ を \\ に。part: url は省く)", async () => {
    const { owner, sid } = await site();
    const res = await call("POST", `/sites/${sid}/experiments`, {
      token: owner.token,
      body: {
        id: "exp_n", name: "N", urlMatch: { part: "path", op: "startsWith", value: "/料金/" },
        targeting: { and: [{ ctx: "host", op: "endsWith", value: "Shop.Example.COM." }, { ctx: "path", op: "regex", value: "^/p/¥d+$" }] },
      },
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({
      urlMatch: { part: "path", op: "startsWith", value: "/%E6%96%99%E9%87%91/" },
      targeting: { and: [{ ctx: "host", op: "endsWith", value: "shop.example.com" }, { ctx: "path", op: "regex", value: "^/p/\\d+$" }] },
    });
    const patched = await call("PATCH", `/sites/${sid}/experiments/exp_n`, { token: owner.token, body: { urlMatch: { part: "url", op: "contains", value: "/lp/" } } });
    expect((await json<{ urlMatch: unknown }>(patched)).urlMatch).toEqual({ op: "contains", value: "/lp/" });
    const goal = await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g_jp", name: "J", type: "PAGEVIEW", config: { page: { part: "path", op: "equals", value: "/完了" } } } });
    expect((await json<{ config: unknown }>(goal)).config).toEqual({ page: { part: "path", op: "equals", value: "/%E5%AE%8C%E4%BA%86" } });
  });

  it("Publish は v0.9 から残った URL 全体の正規表現を invalid_regex で止める(hint は日本語の説明)", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_old" });
    await sql`update experiments set url_match_json = ${JSON.stringify({ op: "regex", value: "^https://" })} where site_id = ${sid} and id = ${eid}`.execute(getDb(env));
    await runDirect(sid, eid);
    const r = await json<PublishBody>(await publishRes(owner.token, sid));
    expect(r).toMatchObject({ ok: false, error: "invalid_regex" });
    expect(r.hint).toContain("URL 全体には正規表現を使えません");
  });

  it("Publish はサイト全体の命令数 500 超を regex_budget_exceeded で止め、hint に大きいものから並べる", async () => {
    const { owner, sid } = await site();
    for (const k of [1, 2, 3]) {
      const { id } = await createExperiment(owner.token, sid, { id: `exp_big${k}`, urlMatch: { part: "path", op: "regex", value: `^/${k}.{0,97}` } });
      await runDirect(sid, id);
    }
    const r = await json<PublishBody>(await publishRes(owner.token, sid));
    expect(r).toMatchObject({ ok: false, error: "regex_budget_exceeded" });
    expect(r.hint).toMatch(/エクスペリエンス exp_big\d の対象 URL\(198\)/);
  });
});

describe("bootstrap の大きさ(決定 50)", () => {
  it("runtime + config の gzip が 13,824 B を超えたら Publish の警告に出す(拒否はしない)", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_big" });
    // gzip で縮まない文字列で config を大きくする(runtime 約 9.4KB + これ 約 6KB)
    const noise = Array.from({ length: 10_000 }, () => Math.random().toString(36).charAt(2)).join("");
    await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [{ id: "c1", type: "TEXT", selector: ".a", payload: { text: noise } }] });
    await runDirect(sid, eid);
    const r = await json<PublishBody>(await publishRes(owner.token, sid));
    expect(r.ok).toBe(true);
    expect(r.warnings?.find((w) => w.path === "bootstrap")?.message).toMatch(/往復/);
  });
  it("ふつうの大きさなら警告を出さない", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid, { id: "exp_small" });
    await runDirect(sid, eid);
    const r = await json<PublishBody>(await publishRes(owner.token, sid));
    expect(r.ok).toBe(true);
    expect(r.warnings?.some((w) => w.path === "bootstrap")).toBe(false);
  });
});

describe("サイトのタイムゾーン(決定 49、設計書 §8)", () => {
  it("既定は Asia/Tokyo。ADMIN が IANA 名で変え、未公開の変更に数え、Publish で config に入る", async () => {
    const { owner, sid } = await site();
    const { id: eid } = await createExperiment(owner.token, sid);
    await runDirect(sid, eid);
    expect((await json<PublishBody>(await publishRes(owner.token, sid))).ok).toBe(true);
    const get = async () => json<{ timezone: string; hasUnpublishedChanges: boolean }>(await call("GET", `/sites/${sid}`, { token: owner.token }));
    expect(await get()).toMatchObject({ timezone: "Asia/Tokyo", hasUnpublishedChanges: false });
    const bad = await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { timezone: "Mars/Olympus" } });
    expect(bad.status).toBe(422);
    expect(await json(bad)).toMatchObject({ error: "invalid_timezone", path: ["timezone"] });
    // 大文字小文字だけを一覧の綴りにそろえて保存する(別名は置き換えない)。オフセット形式は IANA 名ではないので 422(plan ② P14)
    expect((await json(await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { timezone: "asia/tokyo" } }))).timezone).toBe("Asia/Tokyo");
    expect((await json(await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { timezone: "Asia/Kolkata" } }))).timezone).toBe("Asia/Kolkata"); // Workers の実行環境でも別名に置き換えない
    expect(await json(await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { timezone: "+09:00" } }))).toMatchObject({ error: "invalid_timezone" });
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { timezone: "America/New_York" } })).status).toBe(200);
    expect(await get()).toMatchObject({ timezone: "America/New_York", hasUnpublishedChanges: true });
    expect((await json<PublishBody>(await publishRes(owner.token, sid))).ok).toBe(true);
    const row = await getDb(env).selectFrom("publishes").select("config_json").where("site_id", "=", sid).where("status", "=", "active").orderBy("version", "desc").executeTakeFirstOrThrow();
    expect(JSON.parse(row.config_json!).timezone).toBe("America/New_York");
  });
});

describe("UUID Cookie(決定 49 §7.2)", () => {
  it("BYOID(Mode C)でも UUID Cookie を有効にできる", async () => {
    const { owner, sid } = await site();
    const res = await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { idSource: "cookie:_site_uid", uuidCookieEnabled: true } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ idSource: "cookie:_site_uid", uuidCookieEnabled: true });
  });
});
