// apps/control/test/write-freeze.test.ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { kvKeys } from "@wtt/core";
import { AUTH_ALLOW } from "../src/auth-paths";
import { freezeHint, isFreezeExempt, isWriteFrozen, parseWriteFreeze, readWriteFreeze, retryAfterSeconds, writeFrozenError, type WriteFreeze } from "../src/write-freeze";
import { active, BREAK_GLASS, call, createExperiment, createSite, expectEnvelope, failingD1Query, fakeDeployer, json, publishRes, setupOwner, siteRow, siteWithRunning } from "./helpers";

/** 凍結の行を直接書く(運用者が deploy.md の SQL で書くのと同じ形) */
async function freeze(value: string, updatedAt = 1_000): Promise<void> {
  await env.DB.prepare("insert into instance_settings (key, value, updated_at, updated_by) values ('writeFreeze', ?, ?, null) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at")
    .bind(value, updatedAt)
    .run();
}

const NOW = Date.parse("2026-10-10T02:00:00Z");

// backlog D13 / 決定 56 (2)(6): 行の有無が正。読めない値・D1 が読めないときも凍結中
describe("write freeze switch (D13 / decision 56 (2)(6))", () => {
  it("parses only a non-empty reason and an ISO 8601 until with an offset; unknown fields are ignored", () => {
    expect(parseWriteFreeze('{"reason":"v1.1 への更新"}')).toEqual({ reason: "v1.1 への更新", until: null });
    expect(parseWriteFreeze('{"reason":"r","until":"2026-10-10T12:00:00+09:00","by":"ops"}')).toEqual({ reason: "r", until: "2026-10-10T12:00:00+09:00" });
    expect(parseWriteFreeze('{"reason":"r","until":"2026-10-10T03:00:00Z"}')?.until).toBe("2026-10-10T03:00:00Z");
    // SQLite の json_object('until', NULL) が書く形 = 見込み無し(レビュー r1 CL-Low-1)。理由の長さに上限は無い
    expect(parseWriteFreeze('{"reason":"r","until":null}')).toEqual({ reason: "r", until: null });
    expect(parseWriteFreeze(`{"reason":"${"x".repeat(500)}"}`)?.reason).toHaveLength(500);
    for (const bad of ["not json", "[]", '"r"', "{}", '{"reason":""}', '{"reason":"  "}', '{"reason":"r","until":"2026-10-10 12:00"}', '{"reason":"r","until":"2026-10-10T12:00:00"}']) {
      expect(parseWriteFreeze(bad), bad).toBeNull();
    }
  });

  it("no row = not frozen", async () => {
    expect(await readWriteFreeze(getDb(env))).toBeNull();
    expect(await isWriteFrozen(getDb(env))).toBe(false);
  });

  it("a readable row = frozen with its reason, until and since", async () => {
    await freeze('{"reason":"v1.1 への更新","until":"2026-10-10T12:00:00+09:00"}', 1234);
    expect(await readWriteFreeze(getDb(env))).toEqual({ reason: "v1.1 への更新", until: "2026-10-10T12:00:00+09:00", since: 1234 });
    expect(await isWriteFrozen(getDb(env))).toBe(true);
  });

  it("an unreadable row is still frozen (reason null): someone meant to freeze", async () => {
    await freeze("not json", 5);
    expect(await readWriteFreeze(getDb(env))).toEqual({ reason: null, until: null, since: 5 });
  });

  it("a D1 read failure is frozen (fail closed)", async () => {
    const db = getDb({ ...(env as unknown as Env), DB: failingD1Query(env.DB, /instance_settings/) });
    expect(await readWriteFreeze(db)).toEqual({ reason: null, until: null, since: null });
  });

  it("hint covers until in the future, none, passed and unreadable", () => {
    const f = (o: Partial<WriteFreeze>): WriteFreeze => ({ reason: "v1.1 への更新", until: null, since: 1, ...o });
    expect(freezeHint(f({ until: "2026-10-10T12:00:00+09:00" }), NOW)).toBe("理由: v1.1 への更新。再開の見込み: 2026-10-10T12:00:00+09:00。メンテナンスが終わってから、もう一度実行してください");
    expect(freezeHint(f({}), NOW)).toBe("理由: v1.1 への更新。メンテナンスが終わってから、もう一度実行してください");
    expect(freezeHint(f({ until: "2026-10-10T10:00:00+09:00" }), NOW)).toBe("理由: v1.1 への更新。再開の見込み(2026-10-10T10:00:00+09:00)を過ぎています。作業者に確認してください");
    expect(freezeHint({ reason: null, until: null, since: null }, NOW)).toBe("凍結の設定が読めません。作業者に確認してください");
  });

  it("Retry-After is the seconds until `until`, else 300", () => {
    expect(retryAfterSeconds({ reason: "r", until: "2026-10-10T02:10:00.500Z", since: 1 }, NOW)).toBe(601);
    expect(retryAfterSeconds({ reason: "r", until: null, since: 1 }, NOW)).toBe(300);
    expect(retryAfterSeconds({ reason: "r", until: "2026-10-10T01:00:00Z", since: 1 }, NOW)).toBe(300);
    expect(retryAfterSeconds({ reason: null, until: null, since: null }, NOW)).toBe(300);
  });

  it("the 503 envelope carries message, hint, reason, until and the retry seconds", () => {
    const e = writeFrozenError({ reason: "r", until: "2026-10-10T02:10:00Z", since: 1 }, NOW);
    expect(e.status).toBe(503);
    expect(e.toBody()).toEqual({
      error: "write_frozen",
      message: "メンテナンス中のため、変更を保存できません",
      hint: "理由: r。再開の見込み: 2026-10-10T02:10:00Z。メンテナンスが終わってから、もう一度実行してください",
      reason: "r",
      until: "2026-10-10T02:10:00Z",
      retryAfter: 600,
    });
  });
});

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const fill = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, "x").replace("/*", "/get-session");

// backlog D13 / 決定 56 (4): ログインまわり以外の書き込みはすべて断る(後から足したルートも自動で対象に入る)
describe("write freeze guard (D13 / decision 56 (4))", () => {
  it("exempt routes are only login and evaluate (adding a business write under /auth or /break-glass must fail this test)", () => {
    // ALL で登録されたもの(/auth/* の catch-all と、SESSION_ONLY の同じパスのミドルウェア)も数える(レビュー r1 CX-Medium-5)。
    // ALL は POST として通るかで判定する(/* などのミドルウェアは通す側に入らない)
    const exempt = [
      ...new Set(
        app.routes
          .filter((r) => (WRITE.has(r.method) && isFreezeExempt(r.method, r.path)) || (r.method === "ALL" && isFreezeExempt("POST", r.path)))
          .map((r) => `${r.method} ${r.path}`),
      ),
    ].sort();
    expect(exempt).toEqual(["ALL /auth/*", "POST /auth/handoff/exchange", "POST /break-glass/reset-link", "POST /sites/:sid/evaluate"]);
    // catch-all が実際に開くパス。ここに業務の書き込みを足すと凍結から素通しになるので、足すなら凍結の判定を見直す(レビュー r1 CL-Low-3)
    expect([...AUTH_ALLOW].sort()).toEqual(["/auth/get-session", "/auth/request-password-reset", "/auth/reset-password", "/auth/sign-in/email", "/auth/sign-out", "/auth/sign-up/email"]);
    expect(isFreezeExempt("POST", "/auth/sign-out")).toBe(true);
    // 何も書かない what-if の計算(ユーザー決定 2026-10-08)。パスの形が違えば通さない
    expect(isFreezeExempt("POST", "/sites/site_a/evaluate")).toBe(true);
    expect(isFreezeExempt("POST", "/sites/site_a/evaluate/x")).toBe(false);
    expect(isFreezeExempt("POST", "/sites/site_a/experiments/e/evaluate")).toBe(false);
    expect(isFreezeExempt("PUT", "/sites/site_a/evaluate")).toBe(false);
    expect(isFreezeExempt("POST", "/auth/sign-in/email")).toBe(true);
    expect(isFreezeExempt("GET", "/sites")).toBe(true);
    expect(isFreezeExempt("HEAD", "/sites")).toBe(true);
    expect(isFreezeExempt("POST", "/authx")).toBe(false);
    expect(isFreezeExempt("POST", "/break-glassx")).toBe(false);
    expect(isFreezeExempt("POST", "/invitations/x/accept")).toBe(false);
    expect(isFreezeExempt("POST", "/setup")).toBe(false);
  });

  it("every mounted write route answers 503 write_frozen while frozen (sweep)", async () => {
    await freeze('{"reason":"v1.1 への更新","until":"2099-01-01T00:00:00+09:00"}');
    const routes = [...new Set(app.routes.filter((r) => WRITE.has(r.method) && !isFreezeExempt(r.method, r.path)).map((r) => `${r.method} ${r.path}`))];
    expect(routes.length).toBeGreaterThan(30);
    for (const r of routes) {
      const [method, path] = r.split(" ") as [string, string];
      const res = await call(method, fill(path), { body: method === "DELETE" ? undefined : {} });
      expect(res.status, r).toBe(503);
      const body = await expectEnvelope(res);
      expect(body, r).toMatchObject({ error: "write_frozen", reason: "v1.1 への更新", until: "2099-01-01T00:00:00+09:00" });
      expect(Number(res.headers.get("retry-after")), r).toBeGreaterThan(300);
    }
  });

  it("reads, login and logout keep working while frozen; a signed-in owner is refused on writes", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    const { id: eid } = await createExperiment(owner.token, sid);
    await freeze('{"reason":"r"}');
    expect((await call("GET", `/sites/${sid}`, { token: owner.token })).status).toBe(200);
    expect((await call("GET", "/me", { token: owner.token })).status).toBe(200);
    // 配信条件の what-if は通す(凍結の判定ではなく本来の応答。本文の検証で 400 になっても 503 でなければよい)
    expect((await call("POST", `/sites/${sid}/evaluate`, { token: owner.token, body: { url: "https://example.com/" } })).status).not.toBe(503);
    // 一時停止・公開も断る(決定 56 (4))
    const status = await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "paused" } });
    expect(status.status).toBe(503);
    expect((await call("POST", `/sites/${sid}/publish`, { token: owner.token })).status).toBe(503);
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { name: "x" } })).status).toBe(503);
    expect(Number((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: {} })).headers.get("retry-after"))).toBe(300);
    // ログインまわりは通す(凍結の判定ではなく、それぞれの経路の本来の応答が返る)
    expect((await call("POST", "/auth/handoff/exchange", { body: { code: "bogus" } })).status).not.toBe(503);
    expect((await call("POST", "/auth/sign-out", { token: owner.token, body: {}, headers: { origin: "http://localhost:3000" } })).status).not.toBe(503);
    expect((await call("POST", "/break-glass/reset-link", { body: {}, envOverride: BREAK_GLASS })).status).not.toBe(503);
  });

  it("an unreadable switch refuses writes with the 'cannot read' hint", async () => {
    await freeze("not json");
    const res = await call("POST", "/workspaces", {});
    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({ error: "write_frozen", reason: null, until: null, hint: "凍結の設定が読めません。作業者に確認してください" });
  });

  it("writes pass again once the row is deleted", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await freeze('{"reason":"r"}');
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { name: "x" } })).status).toBe(503);
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    expect((await call("PATCH", `/sites/${sid}`, { token: owner.token, body: { name: "x" } })).status).toBe(200);
  });

  it("reads do not touch the switch (a broken D1 read of the switch does not break GET)", async () => {
    const owner = await setupOwner();
    const res = await call("GET", "/me", { token: owner.token, envOverride: { DB: failingD1Query(env.DB, /instance_settings/, 100) } });
    expect(res.status).toBe(200);
  });

  // 決定 56 (7) / P16: GET に伴う業務データの書き込み(配信の写しの自己修復)は凍結中は書かずに応答し、解除後の GET で直る(レビュー r1 CX-High-1)
  it("GET /sites/:sid skips the self-repair while frozen and repairs after the thaw", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    // 配信の写し(KV active)が D1 と食い違った状態を直接作る(publish の成否不明の後と同じ形)
    await env.CONFIG_KV.delete(kvKeys.active(sid));
    await env.DB.prepare("update sites set active_kv_stale = 1 where id = ?").bind(sid).run();
    await freeze('{"reason":"r"}');
    const frozen = await call("GET", `/sites/${sid}`, { token: owner.token });
    expect(frozen.status).toBe(200);
    expect((await json(frozen)).activeKvStale).toBe(true); // 直していないので印のまま
    expect(await active(sid)).toBeNull(); // KV に書いていない
    expect((await siteRow(sid)).active_kv_stale).toBe(1); // D1 に書いていない
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    expect((await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).activeKvStale).toBe(false);
    expect(await active(sid)).toBe("1");
    expect((await siteRow(sid)).active_kv_stale).toBe(0);
  });

  it("GET /sites/:sid also skips the self-repair when the switch cannot be read (fail closed) and still answers", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true);
    await env.DB.prepare("update sites set active_kv_stale = 1 where id = ?").bind(sid).run();
    const res = await call("GET", `/sites/${sid}`, { token: owner.token, envOverride: { DB: failingD1Query(env.DB, /instance_settings/, 100) } });
    expect(res.status).toBe(200);
    expect((await siteRow(sid)).active_kv_stale).toBe(1);
  });

  // 決定 56 (7) / P16(7i): 配信ファイルの自己修復(reconcileStatic)も凍結中は見送る。デプロイ専用の Worker への問い合わせも出し直しの依頼もしない
  it("GET /sites/:sid skips the static self-repair while frozen", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json(await publishRes(owner.token, sid))).ok).toBe(true);
    await env.DB.prepare("update sites set static_stale = 1 where id = ?").bind(sid).run();
    const fake = fakeDeployer(); // status は accepted: null = 凍結していなければ出し直しを依頼する状態
    let statusCalls = 0;
    const deployer = { ...fake, siteStatus: (id: string) => (statusCalls++, fake.siteStatus(id)) };
    await freeze('{"reason":"r"}');
    const frozen = await call("GET", `/sites/${sid}`, { token: owner.token, envOverride: { DEPLOYER: deployer } });
    expect(frozen.status).toBe(200);
    expect((await json(frozen)).staticStale).toBe(true);
    expect((await siteRow(sid)).static_stale).toBe(1);
    expect(statusCalls).toBe(0);
    expect(fake.deploys).toHaveLength(0);
    // 解除後の GET では従来どおり問い合わせて依頼し直す(差し替えが効いていることの確認)
    await env.DB.prepare("delete from instance_settings where key = 'writeFreeze'").run();
    expect((await call("GET", `/sites/${sid}`, { token: owner.token, envOverride: { DEPLOYER: deployer } })).status).toBe(200);
    expect(statusCalls).toBe(1);
    expect(fake.deploys).toHaveLength(1);
  });
});
