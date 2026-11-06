import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { sql, type SqlBool } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, requireSession } from "../src/app";
import type { LoginMethod } from "../src/auth";
import {
  actorFromUser,
  auditActor,
  auditChanged,
  auditFromTo,
  auditStatement,
  auditStatementQuery,
  breakGlassActor,
  changedFieldsDetail,
  sameJsonText,
  unchangedValues,
  systemActor,
  writeAuditAfter,
  writeAuditAfterDb,
  writeAuditBefore,
  type AuditActor,
  type AuditEvent,
} from "../src/audit";
import {
  call,
  countingD1,
  createExperiment,
  createSite,
  experimentRow,
  failingD1Query,
  json,
  nextTestIp,
  sessionTokenOf,
  setupOwner,
  joinWithPassword,
  signInWithPassword,
  siteRow,
  testEnv,
} from "./helpers";

/**
 * B129 Task 2(spec §5.1〜§5.4): 記録の部品(audit.ts)と、操作した人の文脈(requireSession の loginMethod・apiKey)。
 * 部品は要求の文脈(c)を使うので、requireSession だけを通す小さな app(probe)で確かめる(本物のルートの照会を数えに混ぜない)
 */

type Row = Record<string, unknown> & { detail_json: string };

const probe = createApp();
probe.get("/actor", requireSession, (c) => c.json({ actor: auditActor(c), loginMethod: c.get("loginMethod"), apiKey: c.get("apiKey") }));
probe.post("/after", requireSession, async (c) => {
  const mode = c.req.query("mode");
  await writeAuditAfter(c, (): AuditEvent => {
    if (mode === "builder") throw new Error("builder failed");
    if (mode === "json") return { action: "invitation.create", workspaceId: "w1", detail: { n: 1n as unknown as number } };
    return { action: "invitation.create", workspaceId: "w1", target: { type: "invitation", id: "inv1", label: "x@example.com" }, detail: { role: "editor" } };
  });
  return c.json({ ok: true });
});

async function probeFetch(method: string, path: string, token: string, DB: D1Database = env.DB): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await probe.fetch(
    new Request(`http://control.test${path}`, { method, headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": nextTestIp() } }),
    { ...testEnv, DB },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
const actorOf = async (token: string) => (await json<{ actor: AuditActor; loginMethod: string | null; apiKey: unknown }>(await probeFetch("GET", "/actor", token)));

/**
 * 部品が書いた行。準備のヘルパーが本物の経路で書く行(setupOwner の /setup が書く setup.complete。Task 3)は除く
 * (後の Task で準備の経路が記録を書くようになったら、その action をここに足す)。
 * Task 4 から issueKey(api_key.create × 2)・joinWithPassword(invitation.create・invitation.accept)・signInWithPassword
 * (auth.password_login)も記録を書くが、rows() を見るテストはこれらを呼ばない(呼ぶテストは rows() を見ない)ので、ここには足さない。
 * invitation.create を足すと、部品のテストが書く同じ action の行まで除いてしまう
 */
const FIXTURE_ACTIONS = ["setup.complete"];
const rows = async (): Promise<Row[]> =>
  (await env.DB.prepare(`select * from audit_events where action not in (select value from json_each(?1)) order by id`).bind(JSON.stringify(FIXTURE_ACTIONS)).all<Row>()).results;
const issueKey = async (token: string, workspaceId: string | null, name = "agent key") => {
  const res = await call("POST", "/me/api-keys", { token, body: { name, workspaceId } });
  expect(res.status).toBe(201);
  return json<{ id: string; key: string }>(res);
};

const USER = { id: "u1", email: "hanako@example.com", name: "田中 花子" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("audit actor (B129 Task 2)", () => {
  it("actor_from_google_session", async () => {
    const owner = await setupOwner();
    const r = await actorOf(owner.token);
    expect(r.loginMethod).toBe("google");
    expect(r.apiKey).toBeNull();
    expect(r.actor).toEqual({ via: "google", userId: owner.userId, email: owner.email, name: "Owner", apiKeyId: null, apiKeyName: null });
  });

  it("actor_from_password_session", async () => {
    const owner = await setupOwner();
    const pw = await joinWithPassword(owner);
    const token = await signInWithPassword(pw.email);
    const r = await actorOf(token);
    expect(r.loginMethod).toBe("password");
    expect(r.actor).toEqual({ via: "password", userId: pw.userId, email: pw.email, name: "Pw", apiKeyId: null, apiKeyName: null });
  });

  it("actor_from_unmarked_session", async () => {
    const owner = await setupOwner();
    const updated = await env.DB.prepare(`update session set "loginMethod" = null where token = ?`).bind(sessionTokenOf(owner.token)).run();
    expect(updated.meta.changes).toBe(1);
    const r = await actorOf(owner.token);
    expect(r.loginMethod).toBeNull();
    expect(r.actor.via).toBe("unknown");
    expect(r.actor.userId).toBe(owner.userId);
  });

  it("actor_from_api_key", async () => {
    const owner = await setupOwner();
    for (const workspaceId of [owner.workspaceId, null]) {
      const k = await issueKey(owner.token, workspaceId, `key ${workspaceId ?? "full"}`);
      const r = await actorOf(k.key);
      expect(r.loginMethod).toBeNull();
      expect(r.apiKey).toEqual({ id: k.id, name: `key ${workspaceId ?? "full"}` });
      expect(r.actor).toEqual({ via: "api_key", userId: owner.userId, email: owner.email, name: "Owner", apiKeyId: k.id, apiKeyName: `key ${workspaceId ?? "full"}` });
    }
  });

  it("actor_from_user", () => {
    expect(actorFromUser(USER, "setup")).toEqual({ via: "setup", userId: "u1", email: USER.email, name: USER.name, apiKeyId: null, apiKeyName: null });
    // 経路は loginMethod の値をそのまま渡せる(招待の受諾の Bearer あり。NULL・想定外の値は unknown)
    expect(actorFromUser(USER, "password").via).toBe("password");
    expect(actorFromUser(USER, null).via).toBe("unknown");
    expect(actorFromUser(USER, "something" as LoginMethod).via).toBe("unknown");
    expect(actorFromUser(USER, "api_key" as LoginMethod).via).toBe("unknown");
    expect(systemActor).toEqual({ via: "system", userId: null, email: null, name: null, apiKeyId: null, apiKeyName: null });
    expect(breakGlassActor).toEqual({ via: "break_glass", userId: null, email: null, name: null, apiKeyId: null, apiKeyName: null });
  });

  /**
   * 操作した人の情報は requireSession が既に読む値から作る(spec §5.1。追加の照会なし)。
   * control が出す照会は等号で固定する: セッション = 0、ワークスペースの鍵 = 2(鍵の情報 = apikey + apikey_revocations + instance_admins の 1 回と、
   * member のロール)、フルの鍵 = 1(鍵の情報)。better-auth が出す照会(session・user・apikey の読み書き)は版で変わり、apiKey プラグインの
   * 期限切れの鍵の削除(一定の間隔ごと・await しない)が混ざりうるので、合計は上限で見る(2026-11-03 の main 7d2e3f83 の実測は 2 / 5 / 4。
   * 上限はそれに 1 を足した値)。B179(better-auth 1.7)で合計と better-auth の照会の見分け方(BETTER_AUTH)は数え直す
   */
  it("require_session_adds_no_d1_query", async () => {
    const owner = await setupOwner();
    const ws = await issueKey(owner.token, owner.workspaceId);
    const full = await issueKey(owner.token, null);
    const KEY_INFO = /from "apikey" left join "apikey_revocations"/;
    const MEMBER_ROLE = /^select "role" from "member"/;
    /** better-auth の adapter が出す形(1.4.21・1.7.15 とも `select "primary".* from (…)`・`update "apikey" set …`・`delete from "apikey"`。B179 Task 6 で 1.7.15 でも当たることを確かめた) */
    const BETTER_AUTH = /^select "primary"\.\* from|^update "apikey" set|^delete from "apikey"/;
    for (const [label, token, keyInfo, memberRole, maxTotal] of [
      ["session", owner.token, 0, 0, 3],
      ["workspace key", ws.key, 1, 1, 6],
      ["full key", full.key, 1, 0, 5],
    ] as const) {
      const counting = countingD1(env.DB);
      const res = await probeFetch("GET", "/actor", token, counting.db);
      expect(res.status, label).toBe(200);
      const n = counting.counts();
      const all = `${label}: ${n.sql.join("\n")}`;
      expect(n.batches, label).toBe(0);
      expect(n.sql.filter((s) => KEY_INFO.test(s)).length, all).toBe(keyInfo);
      expect(n.sql.filter((s) => MEMBER_ROLE.test(s)).length, all).toBe(memberRole);
      expect(n.sql.filter((s) => !BETTER_AUTH.test(s)).length, all).toBe(keyInfo + memberRole);
      expect(n.queries, all).toBeLessThanOrEqual(maxTotal);
    }
  });
});

describe("audit statement (B129 Task 2)", () => {
  const actor = actorFromUser(USER, "google");

  it("statement_writes_one_row_with_snapshot", async () => {
    const at = 1_730_000_000_000;
    await env.DB.batch([
      auditStatement(env.DB, { ...actor, via: "api_key", apiKeyId: "k1", apiKeyName: "key" }, {
        action: "member.role_change",
        workspaceId: "w1",
        target: { type: "user", id: "u2", label: "jiro@example.com" },
        // undefined の鍵は書かない
        detail: { from: "editor", to: "admin", note: undefined },
      }, { now: at }),
    ]);
    expect(await rows()).toEqual([
      {
        id: 1, at, category: "access", action: "member.role_change", workspace_id: "w1", site_id: null, experiment_id: null,
        site_generation: null, experiment_generation: null, via: "api_key", actor_user_id: "u1", actor_email: USER.email, actor_name: USER.name,
        api_key_id: "k1", api_key_name: "key", target_type: "user", target_id: "u2", target_label: "jiro@example.com",
        detail_json: '{"from":"editor","to":"admin"}',
      },
    ]);
  });

  it("statement_respects_guard", async () => {
    const event: AuditEvent = { action: "static.rebuild", detail: { after: null } };
    await env.DB.batch([auditStatement(env.DB, systemActor, event, { guard: sql<SqlBool>`1 = 0` })]);
    expect(await rows()).toEqual([]);
    await env.DB.batch([auditStatement(env.DB, systemActor, event, { guard: sql<SqlBool>`1 = ${1}` })]);
    expect((await rows()).map((r) => [r.action, r.via, r.detail_json])).toEqual([["static.rebuild", "system", '{"after":null}']]);
  });

  /**
   * SQL で作る target・detail(spec §5.1): targetFrom は t として FROM に入り、target_id・target_label の列と、detail・guard が読む列を返す。
   * 値の detail と SQL の detail を混ぜられ、bind は書いた順に付く(呼び出し元は番号を振らない)。targetFrom が 0 行なら記録しない
   */
  it("statement_reads_target_and_detail_in_sql", async () => {
    const owner = await setupOwner();
    const targetFrom = (id: string) => sql`select u.id as target_id, u.email as target_label, m.role as role from member m join "user" u on u.id = m."userId" where m."userId" = ${id} and m."organizationId" = ${owner.workspaceId}`;
    const event = (id: string): AuditEvent => ({
      action: "member.role_change",
      workspaceId: owner.workspaceId,
      target: { type: "user" },
      targetFrom: targetFrom(id),
      detail: { from: sql`t.role`, to: "admin", skipped: undefined, keys: sql`(select count(*) from apikey where "userId" = ${id})`, nested: { a: [1, "b"] }, on: true },
    });
    const statements = [
      auditStatement(env.DB, actor, event(owner.userId), { guard: sql<SqlBool>`t.role != ${"admin"}` }),
      // 同じロールへの変更(guard が偽)と、メンバーでない人(targetFrom が 0 行)は記録しない
      auditStatement(env.DB, actor, event(owner.userId), { guard: sql<SqlBool>`t.role != ${"owner"}` }),
      auditStatement(env.DB, actor, event("nobody"), { guard: sql<SqlBool>`t.role != ${"admin"}` }),
    ];
    await env.DB.batch(statements);
    const got = await rows();
    expect(got.map((r) => [r.target_type, r.target_id, r.target_label, JSON.parse(r.detail_json)])).toEqual([
      ["user", owner.userId, owner.email, { from: "owner", to: "admin", keys: 0, nested: { a: [1, "b"] }, on: true }],
    ]);
  });

  it("detail_is_capped", async () => {
    const long = "あ".repeat(250);
    await env.DB.batch([
      // Worker で作る detail: 文字列は 200 文字で切り、JSON の UTF-8 が 2,048 バイトを超えたら置き換える(200 文字 × 4 = 2,400 バイト)
      auditStatement(env.DB, actor, { action: "site.update", detail: { a: long, b: long, c: long, d: long } }),
      auditStatement(env.DB, actor, { action: "site.update", detail: { a: long } }),
      // SQL で作る detail にも同じ上限(700 文字 = 2,100 バイト。文字数ではなくバイト数で見る)
      auditStatement(env.DB, actor, { action: "site.update", detail: { a: sql`replace(hex(zeroblob(350)), '0', 'あ')` } }),
      auditStatement(env.DB, actor, { action: "site.update", detail: { a: sql`replace(hex(zeroblob(300)), '0', 'a')`, b: "x" } }),
      // 名前・対象の控えは 200 文字で切る(SQL で読んだ控えも同じ)
      auditStatement(env.DB, { ...actor, name: long, apiKeyName: long }, { action: "site.update", target: { type: "site", id: "s1", label: long } }),
      auditStatement(env.DB, actor, { action: "site.update", target: { type: "site" }, targetFrom: sql`select 's2' as target_id, ${long} as target_label` }),
    ]);
    const got = await rows();
    expect(got[0]!.detail_json).toBe('{"truncated":true}');
    expect(JSON.parse(got[1]!.detail_json)).toEqual({ a: "あ".repeat(200) });
    expect(got[2]!.detail_json).toBe('{"truncated":true}');
    expect(JSON.parse(got[3]!.detail_json)).toEqual({ a: "a".repeat(600), b: "x" });
    expect([got[4]!.actor_name, got[4]!.api_key_name, got[4]!.target_label]).toEqual(["あ".repeat(200), "あ".repeat(200), "あ".repeat(200)]);
    expect([got[5]!.target_id, got[5]!.target_label]).toEqual(["s2", "あ".repeat(200)]);
  });

  /**
   * 外側の limit 1 で内側の select の展開(flatten)を止め、detail の式(json_object とその中の副問い合わせ)を 1 回だけ評価する。
   * EXPLAIN のバイトコードで json_object を呼ぶ命令の数を数える(展開されると CASE の length と else の 2 か所で 2 回になる)
   */
  it("detail_is_evaluated_once", async () => {
    const detail = { from: sql`t.role`, keys: sql`(select count(*) from apikey where "userId" = ${"u1"})`, to: "admin" };
    for (const event of [
      { action: "member.role_change", target: { type: "user" }, targetFrom: sql`select id as target_id, "userId" as target_label, role from member where id = ${"m1"}`, detail },
      { action: "site.update", detail: { n: sql`(select count(*) from sites)` } },
    ] satisfies AuditEvent[]) {
      const q = auditStatementQuery(actor, event, { guard: sql<SqlBool>`1 = ${1}` });
      const ops = (await env.DB.prepare(`explain ${q.sql}`).bind(...q.parameters).all<{ opcode: string; p4: string | null }>()).results;
      expect(ops.filter((o) => /^json_object\(/.test(String(o.p4))).length, event.action).toBe(1);
      const plan = (await env.DB.prepare(`explain query plan ${q.sql}`).bind(...q.parameters).all<{ detail: string }>()).results;
      expect(plan.some((p) => p.detail.startsWith("CO-ROUTINE")), JSON.stringify(plan)).toBe(true);
    }
  });

  /**
   * B129 final review(R64): 更新の記録は、値が変わった欄だけを fields に入れ、前後を持つ欄も変わった欄だけ {from, to} を持つ。
   * 比べるのは記録の文の中(今の行の値と、保存する値・それと同じとみなす値)。変わった欄が無ければ fields: []
   */
  it("changed_fields_detail_keeps_only_changed (final review)", async () => {
    const t = sql`select 's1' as target_id, 'S' as target_label, 'Hero' as name, 30 as days, null as budget, '{"b":1,"a":2}' as json_col`;
    const detail = (next: { name: string; days: number; budget: number | null; json: string }) =>
      changedFieldsDetail([
        { key: "name", changed: auditChanged(sql`t.name`, [next.name]), fromTo: auditFromTo(sql`t.name`, next.name) },
        { key: "days", changed: auditChanged(sql`t.days`, [next.days]), fromTo: auditFromTo(sql`t.days`, next.days) },
        { key: "budget", changed: auditChanged(sql`t.budget`, [next.budget]), fromTo: auditFromTo(sql`t.budget`, next.budget) },
        // 長い値の欄は名前だけ。読んだ行と鍵の順だけが違う値は「変わらず」に数える
        { key: "json", changed: auditChanged(sql`t.json_col`, unchangedValues(next.json, '{"b":1,"a":2}', sameJsonText)) },
      ]);
    const long = "x".repeat(250);
    await env.DB.batch([
      auditStatement(env.DB, actor, { action: "site.update", target: { type: "site" }, targetFrom: t, detail: detail({ name: "Hero", days: 30, budget: null, json: '{"a":2,"b":1}' }) }),
      auditStatement(env.DB, actor, { action: "site.update", target: { type: "site" }, targetFrom: t, detail: detail({ name: "Hero", days: 7, budget: 5, json: '{"a":3}' }) }),
      auditStatement(env.DB, actor, { action: "site.update", target: { type: "site" }, targetFrom: t, detail: detail({ name: long, days: 30, budget: null, json: '{"b":1,"a":2}' }) }),
      // 名前を出さない形(使用状況の設定: 鍵そのものが変えた項目)。変わらなければ {}
      auditStatement(env.DB, actor, {
        action: "usage.settings_change",
        detail: changedFieldsDetail([{ key: "days", changed: auditChanged(sql`30`, [30]), fromTo: auditFromTo(sql`30`, 30) }], { names: false }),
      }),
      auditStatement(env.DB, actor, { action: "site.update", detail: changedFieldsDetail([]) }),
    ]);
    expect((await rows()).map((r) => JSON.parse(r.detail_json))).toEqual([
      { fields: [] },
      { fields: ["days", "budget", "json"], days: { from: 30, to: 7 }, budget: { from: null, to: 5 } },
      // to も from と同じく 200 文字で切る
      { fields: ["name"], name: { from: "Hero", to: "x".repeat(200) } },
      {},
      { fields: [] },
    ]);
  });

  it("statement_sets_generations", async () => {
    const owner = await setupOwner();
    const site = await createSite(owner.token, owner.workspaceId);
    const exp = await createExperiment(owner.token, site.id);
    const siteGen = (await siteRow(site.id)).generation;
    const expGen = (await experimentRow(site.id, exp.id)).generation;
    // 準備の作成の記録(Task 6 の experiment.create)は見ない
    const setupRows = (await rows()).length;
    await env.DB.batch([
      // (1) 値を渡す口: サイトの作成・エクスペリエンスの作成(insert と同じ値)・複製(新しいエクスペリエンスの世代は値、サイトは行から)
      auditStatement(env.DB, actor, { action: "site.create", workspaceId: owner.workspaceId, siteId: "s_new", generation: { site: "sg-new" } }),
      auditStatement(env.DB, actor, { action: "experiment.create", workspaceId: owner.workspaceId, siteId: site.id, experimentId: "e_new", generation: { site: siteGen, experiment: "eg-new" } }),
      auditStatement(env.DB, actor, { action: "experiment.duplicate", workspaceId: owner.workspaceId, siteId: site.id, experimentId: "e_dup", generation: { experiment: "eg-dup" } }),
      // (2) 渡さない口: 更新(対象の行から読む)
      auditStatement(env.DB, actor, { action: "experiment.update", workspaceId: owner.workspaceId, siteId: site.id, experimentId: exp.id }),
    ]);
    // 削除の前に置いた記録は、消す前の行の世代を読む
    await env.DB.batch([
      auditStatement(env.DB, actor, { action: "experiment.delete", workspaceId: owner.workspaceId, siteId: site.id, experimentId: exp.id }),
      env.DB.prepare(`delete from experiments where site_id = ? and id = ?`).bind(site.id, exp.id),
      auditStatement(env.DB, actor, { action: "site.delete", workspaceId: owner.workspaceId, siteId: site.id }),
      env.DB.prepare(`delete from sites where id = ?`).bind(site.id),
    ]);
    expect((await rows()).slice(setupRows).map((r) => [r.action, r.site_id, r.experiment_id, r.site_generation, r.experiment_generation])).toEqual([
      ["site.create", "s_new", null, "sg-new", null],
      ["experiment.create", site.id, "e_new", siteGen, "eg-new"],
      ["experiment.duplicate", site.id, "e_dup", siteGen, "eg-dup"],
      ["experiment.update", site.id, exp.id, siteGen, expGen],
      ["experiment.delete", site.id, exp.id, siteGen, expGen],
      ["site.delete", site.id, null, siteGen, null],
    ]);
  });
});

describe("audit writers (B129 Task 2)", () => {
  const actor = actorFromUser(USER, "password");
  const failingInsert = () => failingD1Query(env.DB, /insert into audit_events/i);

  it("before_write_throws", async () => {
    await writeAuditBefore(env.DB, breakGlassActor, { action: "break_glass.reset_link", target: { type: "user", id: "u1", label: USER.email } });
    expect((await rows()).map((r) => [r.action, r.via, r.actor_user_id, r.target_id])).toEqual([["break_glass.reset_link", "break_glass", null, "u1"]]);
    await expect(writeAuditBefore(failingInsert(), actor, { action: "member.reset_link", detail: { outcome: "failed" } })).rejects.toThrow();
  });

  it("after_write_swallows_errors", async () => {
    const owner = await setupOwner();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // INSERT の失敗(c なし・c あり)
    await expect(writeAuditAfterDb(failingInsert(), () => ({ actor, event: { action: "auth.password_login" } }))).resolves.toBeUndefined();
    expect((await probeFetch("POST", "/after", owner.token, failingInsert())).status).toBe(200);
    // 組み立て(detail の JSON 化)の失敗
    await expect(writeAuditAfterDb(env.DB, () => ({ actor, event: { action: "auth.password_login", detail: { n: 1n as unknown as number } } }))).resolves.toBeUndefined();
    expect((await probeFetch("POST", "/after?mode=json", owner.token)).status).toBe(200);
    expect(errors).toHaveBeenCalledTimes(4);
    for (const callArgs of errors.mock.calls) {
      expect(callArgs[0]).toBe("audit: failed to record");
      // メールアドレスはログに出さない(例外はそのまま渡さず name と message だけ)
      expect(JSON.stringify(callArgs[1])).not.toMatch(/@/);
      expect(Object.keys(callArgs[2] as object).sort()).toEqual(["message", "name"]);
      expect(JSON.stringify(callArgs[2])).not.toMatch(/@/);
    }
    expect(errors.mock.calls[1]![1]).toEqual({ action: "invitation.create", targetId: "inv1" });
    expect(await rows()).toEqual([]);
    // 成功すれば 1 行(c のある方は操作した人を要求の文脈から作る)
    expect((await probeFetch("POST", "/after", owner.token)).status).toBe(200);
    expect((await rows()).map((r) => [r.action, r.via, r.actor_user_id, r.target_id, r.detail_json])).toEqual([["invitation.create", "google", owner.userId, "inv1", '{"role":"editor"}']]);
  });

  it("after_write_takes_builder_function", async () => {
    const owner = await setupOwner();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      writeAuditAfterDb(env.DB, () => {
        throw new Error("builder failed");
      }),
    ).resolves.toBeUndefined();
    expect((await probeFetch("POST", "/after?mode=builder", owner.token)).status).toBe(200);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["audit: failed to record", { action: null, targetId: null }],
      ["audit: failed to record", { action: null, targetId: null }],
    ]);
    expect(await rows()).toEqual([]);
  });
});
