import { describe, it, expect, vi } from "vitest";
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { compile, kvKeys, newRunId, parseCompiledConfig } from "@wtt/core";
import {
  active,
  agePublish,
  beforeD1BatchMatching,
  call,
  createExperiment,
  createSite,
  expectEnvelope,
  failingKv,
  fakeDeployer,
  inviteAndJoin,
  lateFailingActivePut,
  json,
  publishRes,
  runDirect,
  setupOwner,
  siteRow,
  siteWithRunning,
  TEXT_CHANGE,
  testEnv,
  userActor,
} from "./helpers";
import { abortingBindings, settleOrAbort } from "./abort-harness";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { preparePublish, activatePublish, buildCompileInput, compileInputDigest, cleanupOldVersions, publishSite, sha256Hex, type PublishResult } from "../src/publish";

/**
 * `:active` の put の直前に D1 の `active_version` を別の版へ進める KV。
 * 「自分が KV に active を書いている最中に、別 isolate の Publish が activation を済ませた」状況を再現する(rulings §4 CX-High-3 の fence 用)
 */
function kvBumpingActiveOnPut(sid: string, to: number): KVNamespace {
  return new Proxy(env.CONFIG_KV, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (prop === "put")
        return async (key: string, ...rest: unknown[]) => {
          if (/:active$/.test(key)) await getDb(env).updateTable("sites").set({ active_version: to }).where("id", "=", sid).execute();
          return (target.put as (...a: unknown[]) => unknown).apply(target, [key, ...rest]);
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as KVNamespace;
}

/**
 * 古い版の掃除は、配信ファイルが配っている版が分かるまで何も消さない(7i plan K20 ①)。
 * 掃除の挙動を見るテストは、常に deployed を返す偽のデプロイ専用の Worker を入れて、配っている版を記録させる
 */
const deployEnv = (over: Partial<Env> = {}): Env => ({ ...testEnv, DEPLOYER: fakeDeployer(), ...over });

const config = async (sid: string, v: number) => {
  const raw = await env.CONFIG_KV.get(kvKeys.config(sid, v));
  return raw === null ? null : parseCompiledConfig(JSON.parse(raw));
};

describe("publish (spec §13.6)", () => {
  it("deleting a workspace removes every site record from kv", async () => {
    // Task 2 の DELETE /workspaces/:wid が配下 Site の KV(settings / active / config / host)を消すことを、Publish 済みの Site で固定する
    const { token, workspaceId } = await setupOwner();
    await call("POST", "/workspaces", { token, body: { name: "Keeper" } }); // 最後の 1 つは消せない
    const s1 = await createSite(token, workspaceId, { id: "site_ws1", mode: "B", domain: "www.example.com" });
    await createSite(token, workspaceId, { id: "site_ws2", domain: "two.example.com" });
    const { id: eid } = await createExperiment(token, s1.id, { id: "exp_ws" });
    await runDirect(s1.id, eid);
    expect((await json(await call("POST", `/sites/${s1.id}/publish`, { token }))).ok).toBe(true);
    // backlog B36 / 決定 53 (13): 実行中のエクスペリエンスがあるワークスペースは消せない。KV に配信設定を残したまま、D1 の状態だけを終了にする
    await env.DB.prepare(`update experiments set status = 'archived', published_status = 'archived' where site_id = ?1`).bind(s1.id).run();
    expect((await call("DELETE", `/workspaces/${workspaceId}`, { token })).status).toBe(204);
    for (const sid of ["site_ws1", "site_ws2"]) {
      expect(await env.CONFIG_KV.get(kvKeys.settings(sid))).toBeNull();
      expect(await env.CONFIG_KV.get(kvKeys.active(sid))).toBeNull();
      expect(await env.CONFIG_KV.get(kvKeys.config(sid, 1))).toBeNull();
    }
    expect(await env.CONFIG_KV.get(kvKeys.host("www.example.com"))).toBeNull();
  });

  it("publishes running experiments as version 1 and activates it", async () => {
    const { owner, sid } = await siteWithRunning();
    const res = await publishRes(owner.token, sid);
    expect(res.status).toBe(200);
    const r = await json<PublishResult>(res);
    expect(r).toMatchObject({ ok: true, version: 1, needsProfile: false, superseded: false, staticDeploy: "skipped" });
    expect(await active(sid)).toBe("1");
    const cfg = await config(sid, 1);
    expect(cfg?.experiments.map((e) => e.id)).toEqual(["exp_hero"]);
    expect(cfg?.exposurePayloads?.exp_hero?.b?.variantName).toBe("b"); // B77: 外部計測の名前の指定が無ければパターン ID(名前は配らない)
    const exp = await json(await call("GET", `/sites/${sid}/experiments/exp_hero`, { token: owner.token }));
    expect(exp.publishedStatus).toBe("running");
    expect(exp.unpublished).toBe(false);
  });

  it("publish_stores_config_json_in_history", async () => {
    const { owner, sid } = await siteWithRunning();
    await publishRes(owner.token, sid);
    const list = await json<Array<{ version: number; status: string; publishedBy: { name: string } }>>(
      await call("GET", `/sites/${sid}/publishes`, { token: owner.token }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ version: 1, status: "active", publishedBy: { name: "Owner" } });
    const detail = await json<{ config: unknown }>(await call("GET", `/sites/${sid}/publishes/1`, { token: owner.token }));
    expect(detail.config).toEqual(await config(sid, 1)); // D1 の本体 = KV の本体
    const row = await getDb(env).selectFrom("publishes").selectAll().where("site_id", "=", sid).where("version", "=", 1).executeTakeFirstOrThrow();
    expect(row.config_hash).toBe(await sha256Hex((await env.CONFIG_KV.get(kvKeys.config(sid, 1)))!));
  });

  it("returns 404 with a hint for a version whose body was pruned", async () => {
    const { owner, sid } = await siteWithRunning();
    await publishRes(owner.token, sid);
    await env.DB.prepare("update publishes set config_json = null, body_pruned_at = 123 where site_id = ? and version = 1").bind(sid).run();
    const res = await call("GET", `/sites/${sid}/publishes/1`, { token: owner.token });
    expect(res.status).toBe(404);
    const b = await json(res);
    expect(b).toMatchObject({ error: "not_found", bodyPrunedAt: 123 });
    expect(b.hint).toBeTruthy();
    await env.DB.prepare("update publishes set body_pruned_at = null where site_id = ? and version = 1").bind(sid).run();
    const reserved = await call("GET", `/sites/${sid}/publishes/1`, { token: owner.token });
    expect(reserved.status).toBe(404);
    const r = await json(reserved);
    expect(r).not.toHaveProperty("bodyPrunedAt"); expect(r).not.toHaveProperty("hint");
  });

  it("lists bodyPrunedAt per version", async () => {
    const { owner, sid } = await siteWithRunning();
    await publishRes(owner.token, sid); await publishRes(owner.token, sid);
    await env.DB.prepare("update publishes set config_json = null, body_pruned_at = 123 where site_id = ? and version = 1").bind(sid).run();
    const list = await json<Array<{ version: number; bodyPrunedAt: number | null }>>(await call("GET", `/sites/${sid}/publishes`, { token: owner.token }));
    expect(list.map((r) => [r.version, r.bodyPrunedAt])).toEqual([[2, null], [1, 123]]);
  });

  it("publish_failure_before_activation_keeps_old_config", async () => {
    const { owner, sid } = await siteWithRunning();
    await publishRes(owner.token, sid);
    const res = await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/config:v2$/) });
    expect(res.status).toBe(200);
    // 失敗結果の message は UI がそのまま出す日本語の文。生の例外文字列(injected kv put failure …)は載せない(rulings §4 最終レビュー)
    expect(await json(res)).toEqual({ ok: false, version: 2, error: "kv_put_failed", message: "config を KV に書き込めませんでした", hint: "数秒後にもう一度公開してください" });
    expect(await active(sid)).toBe("1");
    expect((await siteRow(sid)).active_version).toBe(1);
    const rows = await getDb(env).selectFrom("publishes").select(["version", "status"]).where("site_id", "=", sid).orderBy("version").execute();
    expect(rows).toEqual([
      { version: 1, status: "active" },
      { version: 2, status: "failed" },
    ]);
    // 読み戻しで hash が一致しない場合も activation しない
    const res2 = await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/config:v3$/, "get") });
    expect(await json(res2)).toMatchObject({ ok: false, version: 3, error: "kv_verify_failed", message: "書き込んだ config の読み戻し検証に失敗しました" });
    expect(await active(sid)).toBe("1");
  });

  it("mark_failed_does_not_touch_active_rows", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    // config の put が失敗を返す前に、同じ id の行が active になった状態を作る。
    const kv = new Proxy(failingKv(/config:v1$/), {
      get(target, prop) {
        if (prop !== "put") return Reflect.get(target, prop);
        return async (key: string, value: string) => {
          await db.updateTable("publishes").set({ status: "active" }).where("site_id", "=", sid).where("version", "=", 1).execute();
          return target.put(key, value);
        };
      },
    }) as KVNamespace;
    const res = await publishRes(owner.token, sid, { CONFIG_KV: kv });
    expect(await json(res)).toMatchObject({ ok: false, error: "publish_reservation_expired" });
    const row = await db.selectFrom("publishes").select(["status", "error"]).where("site_id", "=", sid).where("version", "=", 1).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "active", error: null });
  });

  it("failed_publish_never_overwrites_reserved_version", async () => {
    const { owner, sid } = await siteWithRunning();
    await publishRes(owner.token, sid);
    await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/config:v2$/) });
    const r = await json<PublishResult>(await publishRes(owner.token, sid));
    expect(r).toMatchObject({ ok: true, version: 3 }); // 失敗した v2 は再利用しない
    expect(await config(sid, 2)).toBeNull();
    expect(await active(sid)).toBe("3");
    const v2 = await getDb(env).selectFrom("publishes").select("status").where("site_id", "=", sid).where("version", "=", 2).executeTakeFirstOrThrow();
    expect(v2.status).toBe("failed");
  });

  it("concurrent_publish_has_monotonic_versions", async () => {
    const { owner, sid } = await siteWithRunning();
    const results = await Promise.all([1, 2, 3].map(() => publishRes(owner.token, sid).then((r) => json<PublishResult>(r))));
    const versions = results.map((r) => (r.ok ? r.version : -1)).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await active(sid)).toBe("3");
  });

  it("concurrent_publish_active_hash_matches_d1_record", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    /** KV active の版・D1 sites.active_version・publishes 行・KV 本体の hash が 4 つとも噛み合っていること */
    const expectConsistent = async () => {
      const v = Number(await active(sid));
      const row = await db.selectFrom("publishes").selectAll().where("site_id", "=", sid).where("version", "=", v).executeTakeFirstOrThrow();
      expect(row.status).toBe("active");
      expect((await siteRow(sid)).active_version).toBe(v);
      expect(await sha256Hex((await env.CONFIG_KV.get(kvKeys.config(sid, v)))!)).toBe(row.config_hash);
      return v;
    };
    await Promise.all([1, 2, 3].map(() => publishRes(owner.token, sid)));
    expect(await expectConsistent()).toBe(3);
    // Promise.all は D1 の直列化で歩調が揃いやすい。active put を 1 回失敗させて 1.1 秒待たせ、
    // その間に別の Publish を完走させることで、activation が本当に交差する並びを踏む
    const slow = publishRes(owner.token, sid, { CONFIG_KV: failingKv(/:active$/, "put", 1) }); // v4
    await new Promise((r) => setTimeout(r, 100));
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // v5 が先に完了
    expect((await json<PublishResult>(await slow)).ok).toBe(true);
    expect(await expectConsistent()).toBe(5);
  });

  it("rapid_six_publishes_keep_still_served_versions", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    const site = await siteRow(sid);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 6; i++) expect((await publishSite(deployEnv(), db, site, userActor(owner.userId), t0 + i * 1000)).ok).toBe(true);
    // 6 版すべて 5 分以内に active だったので削除されない
    for (let v = 1; v <= 6; v++) expect(await config(sid, v)).not.toBeNull();
    // 10 分後の 7 回目(plan12 K14 (b): 「直近 5 版」の保持はやめた)。掃除は配信ファイルの出し直しより前に走るので、その時点で配信ファイルが
    // 配っている版は v6。残るのは v6 以上(= 配信ファイルが配る版以上。v6・v7)だけで、v1〜v5 は削除
    expect((await publishSite(deployEnv(), db, await siteRow(sid), userActor(owner.userId), t0 + 600_000)).ok).toBe(true);
    for (let v = 1; v <= 5; v++) expect(await config(sid, v)).toBeNull();
    for (let v = 6; v <= 7; v++) expect(await config(sid, v)).not.toBeNull();
    const deleted = await db.selectFrom("publishes").select(["version", "kv_deleted"]).where("site_id", "=", sid).orderBy("version").execute();
    expect(deleted.filter((r) => r.kv_deleted === 1).map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
  });

  it("failed_publish_cleanup_never_deletes_active_config", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 7; i++) expect((await publishSite(deployEnv(), db, await siteRow(sid), userActor(owner.userId), t0 + i * 1000)).ok).toBe(true);
    expect(await active(sid)).toBe("7");
    // 10 分後に失敗する Publish(put で落ちる)。cleanup は走らず、active の v7 と直近版はそのまま
    const r = await publishSite(deployEnv({ CONFIG_KV: failingKv(/config:v8$/) }), db, await siteRow(sid), userActor(owner.userId), t0 + 600_000);
    expect(r.ok).toBe(false);
    expect(await active(sid)).toBe("7");
    expect(await config(sid, 7)).not.toBeNull();
    for (let v = 3; v <= 6; v++) expect(await config(sid, v)).not.toBeNull(); // 5 分以内に有効だった版も失敗 Publish に巻き込まれない(掃除は走らない)
    // 読み戻し失敗(hash 不一致)でも v9 のキーは片付け、active は触らない
    const r2 = await publishSite(deployEnv({ CONFIG_KV: failingKv(/config:v9$/, "get") }), db, await siteRow(sid), userActor(owner.userId), t0 + 601_000);
    expect(r2.ok).toBe(false);
    expect(await config(sid, 9)).toBeNull();
    expect(await config(sid, 7)).not.toBeNull();
    // verify 失敗で KV から消した版は publishes に kv_deleted = 1 で残す
    expect((await db.selectFrom("publishes").select("kv_deleted").where("site_id", "=", sid).where("version", "=", 9).executeTakeFirstOrThrow()).kv_deleted).toBe(1);
  });

  it("role_viewer_cannot_publish", async () => {
    const { owner, sid } = await siteWithRunning();
    const v = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    const res = await publishRes(v.token, sid);
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: "forbidden", required: "admin" });
    expect(await active(sid)).toBeNull();
  });

  it(
    "publish history is readable by viewer but its body needs admin; the raw error text is admin-only (Plan 10 B1)",
    async () => {
      const { owner, sid } = await siteWithRunning();
      expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true);
      // v2 を KV 書込失敗で failed にする → error 列は "kv_put_failed: <生の例外文字列>"
      expect((await json<PublishResult>(await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/config:v2$/) }))).ok).toBe(false);
      const v = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
      const ed = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
      type Row = { version: number; error: string | null; publishedBy: { id: string } };
      const asOwner = await json<Row[]>(await call("GET", `/sites/${sid}/publishes`, { token: owner.token }));
      expect(asOwner[0]).toMatchObject({ version: 2 });
      expect(asOwner[0]!.error).toMatch(/^kv_put_failed: .+/); // ADMIN 以上は生テキスト込み
      expect(asOwner[1]).toMatchObject({ version: 1, error: null, publishedBy: { id: owner.userId } });
      for (const t of [v.token, ed.token]) {
        const list = await call("GET", `/sites/${sid}/publishes`, { token: t });
        expect(list.status).toBe(200);
        const rows = await json<Row[]>(list);
        expect(rows[0]!.error).toBe("kv_put_failed"); // VIEWER / EDITOR は機械可読コードだけ
        expect(rows[1]!.error).toBeNull();
      }
      // ADMIN 境界と fail-closed: ADMIN にも生テキスト、区切りの無い行(制約の無い TEXT 列)は VIEWER / EDITOR に publish_failed
      const ad = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
      expect((await json<Row[]>(await call("GET", `/sites/${sid}/publishes`, { token: ad.token })))[0]!.error).toMatch(/^kv_put_failed: .+/);
      await getDb(env).updateTable("publishes").set({ error: "raw exception text without a code" }).where("site_id", "=", sid).where("version", "=", 2).execute();
      expect((await json<Row[]>(await call("GET", `/sites/${sid}/publishes`, { token: v.token })))[0]!.error).toBe("publish_failed");
      expect((await json<Row[]>(await call("GET", `/sites/${sid}/publishes`, { token: ed.token })))[0]!.error).toBe("publish_failed");
      expect((await json<Row[]>(await call("GET", `/sites/${sid}/publishes`, { token: ad.token })))[0]!.error).toBe("raw exception text without a code");
      // 区切りが無く正規表現には一致する値(r2 CX-Medium-1): 内容にかかわらず publish_failed に閉じる
      await getDb(env).updateTable("publishes").set({ error: "timeout" }).where("site_id", "=", sid).where("version", "=", 2).execute();
      expect((await json<Row[]>(await call("GET", `/sites/${sid}/publishes`, { token: v.token })))[0]!.error).toBe("publish_failed");
      expect((await json<Row[]>(await call("GET", `/sites/${sid}/publishes`, { token: ad.token })))[0]!.error).toBe("timeout");
      // 区切りはあるが先頭がコードの形でない(大文字・空白など): PUBLISH_ERROR_CODE_RE に落ちて publish_failed
      await getDb(env).updateTable("publishes").set({ error: "Error: boom" }).where("site_id", "=", sid).where("version", "=", 2).execute();
      expect((await json<Row[]>(await call("GET", `/sites/${sid}/publishes`, { token: v.token })))[0]!.error).toBe("publish_failed");
      expect((await json<Row[]>(await call("GET", `/sites/${sid}/publishes`, { token: ad.token })))[0]!.error).toBe("Error: boom");
      const detail = await call("GET", `/sites/${sid}/publishes/1`, { token: v.token });
      expect(detail.status).toBe(403);
      expect((await json(detail)).required).toBe("admin");
      expect((await call("GET", `/sites/${sid}/publishes/99`, { token: owner.token })).status).toBe(404);
      // 非メンバーは 404(存在を漏らさない)
      const other = await json<{ id: string }>(await call("POST", "/workspaces", { token: owner.token, body: { name: "Second" } }));
      const outsider = await inviteAndJoin(owner.token, other.id, "admin");
      expect((await call("GET", `/sites/${sid}/publishes`, { token: outsider.token })).status).toBe(404);
      expect((await call("GET", `/sites/${sid}/publishes/1`, { token: outsider.token })).status).toBe(404);
    },
    20000, // 3 回の inviteAndJoin + 複数回の publish / GET を直列に行うため既定の 5000ms を超える(実測 ~7-8s)
  );

  it("compile errors are reported as failed publishes without touching KV", async () => {
    const owner = await setupOwner();
    const { id: sid } = await createSite(owner.token, owner.workspaceId);
    await call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { id: "g_gone", name: "消える Goal", type: "CUSTOM", config: {} } });
    await createExperiment(owner.token, sid, { id: "exp_x", targeting: { hist: "converted", goal: "g_gone" } });
    await runDirect(sid, "exp_x");
    // 参照中の Goal の削除は 409 で塞いであるので、D1 を直接壊して compile の参照エラーを作る
    await getDb(env).deleteFrom("goals").where("site_id", "=", sid).where("id", "=", "g_gone").execute();
    const r = await json<PublishResult>(await publishRes(owner.token, sid));
    expect(r).toMatchObject({ ok: false, version: 1, error: "unknown_goal", message: "参照している目標が見つかりません" });
    expect((r as { message?: string }).message).not.toContain("g_gone"); // 参照先の ID は場所と直し方(hint)にだけ出し、message には出さない
    expect(await active(sid)).toBeNull();
    expect(await config(sid, 1)).toBeNull();
  });

  it("D1 に残った古い書式の配信条件は Publish を ok: false(legacy_targeting)で止め、場所と書き換え方を hint に出す(v0.9 のデータ)", async () => {
    const { owner, sid, eid } = await siteWithRunning();
    await getDb(env).updateTable("experiments").set({ targeting_json: JSON.stringify({ hist: "visited", pattern: "p_pricing" }) }).where("site_id", "=", sid).where("id", "=", eid).execute();
    const r = await json(await publishRes(owner.token, sid));
    expect(r).toMatchObject({ ok: false, error: "legacy_targeting", message: "古い書式の配信条件があります" });
    expect(r.hint).toContain(`エクスペリエンス ${eid} の配信条件`);
    expect(r.hint).toContain("ページの一致を直接書く形");
  });

  it("D1 に残った入れ子の配信条件(v0.9 では保存できた形)は Publish を ok: false で止め、保存 422 と同じ直し方を hint に出す", async () => {
    const { owner, sid, eid } = await siteWithRunning();
    const nested = { and: [{ ctx: "device", op: "in", value: ["mobile"] }, { or: [{ ctx: "device", op: "in", value: ["tablet"] }, { ctx: "device", op: "in", value: ["desktop"] }] }] };
    await getDb(env).updateTable("experiments").set({ targeting_json: JSON.stringify(nested) }).where("site_id", "=", sid).where("id", "=", eid).execute();
    const r = await json(await publishRes(owner.token, sid));
    expect(r).toMatchObject({ ok: false, error: "invalid_experiment_targeting", message: "この形では配信できない配信条件があります" });
    expect(r.hint).toContain(`エクスペリエンス ${eid} の配信条件: 配信条件ではグループを入れ子にできません`);
    expect(r.hint).toContain("オーディエンスで作って配信条件で選んでください");
  });

  // B69(spec §6.2): 通常の経路では起きない(開始・再開で断り、マイグレーションで一時停止する)が、running のまま残った古いページの条件は
  // compile が止め、Publish の hint に場所と直し方を出す
  it("publish_reports_page_condition_moved_with_hint", async () => {
    const { owner, sid, eid } = await siteWithRunning();
    await getDb(env).updateTable("experiments").set({ targeting_json: JSON.stringify({ ctx: "query", name: "utm", op: "exists" }) }).where("site_id", "=", sid).where("id", "=", eid).execute();
    const r = await json(await publishRes(owner.token, sid));
    expect(r).toMatchObject({ ok: false, error: "page_condition_moved", message: "配信条件・オーディエンスに、使えなくなったページの条件があります" });
    expect(r.hint).toContain(`エクスペリエンス ${eid} の配信条件`);
    expect(r.hint).toContain("対象 URL(urlMatch)で指定してください");
  });

  it("publish_records_experiment_ids_of_the_config", async () => {
    const { owner, sid, eid } = await siteWithRunning();
    const r = await json(await publishRes(owner.token, sid));
    expect(r.ok).toBe(true);
    const row = await getDb(env).selectFrom("publishes").select("experiment_ids_json").where("site_id", "=", sid).where("version", "=", r.version).executeTakeFirstOrThrow();
    expect(JSON.parse(row.experiment_ids_json!)).toEqual([eid]);
  });

  it("active put is retried once and succeeds on the second attempt", async () => {
    const { owner, sid } = await siteWithRunning();
    const res = await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/:active$/, "put", 1) });
    expect(await json(res)).toMatchObject({ ok: true, version: 1 });
    expect(await active(sid)).toBe("1");
  });

  it("active_put_failure_returns_success_with_delivery_warning", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    const res = await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/:active$/, "put") });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      version: 2,
      warnings: expect.arrayContaining([{ path: "delivery", message: "配信への反映が遅れています。通常 15 分以内に自動で反映します" }]),
    });
    expect(await siteRow(sid)).toMatchObject({ active_version: 2, active_kv_stale: 1 });
    expect(await active(sid)).toBe("1");
    const row = await getDb(env).selectFrom("publishes").select("status").where("site_id", "=", sid).where("version", "=", 2).executeTakeFirstOrThrow();
    expect(row.status).toBe("active");
    // 次の Publish の冒頭(reconcileActive)が KV active を D1 最新版に揃え直して旗を下ろす。
    // reconcile 単独の効果を見るため、KV 側を失った状態にしてから、自分では active を書かない
    // (config の put で落ちる)Publish を投げる
    await env.CONFIG_KV.delete(kvKeys.active(sid));
    await agePublish(sid, 30_001);
    const res2 = await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/config:v3$/) });
    expect(await json(res2)).toMatchObject({ ok: false, version: 3, error: "kv_put_failed" });
    expect(await active(sid)).toBe("2"); // reconcile が再 put した
    expect((await siteRow(sid)).active_kv_stale).toBe(0);
  });

  it("active_put_failure_still_cleans_up_and_redeploys_static", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    const actor = userActor(owner.userId);
    const t0 = 1_800_000_000_000;
    const deployer = fakeDeployer();
    const normal = deployEnv({ DEPLOYER: deployer });
    for (let i = 0; i < 2; i++) expect((await publishSite(normal, db, await siteRow(sid), actor, t0 + i * 1000)).ok).toBe(true);
    expect(await active(sid)).toBe("2");
    expect(await config(sid, 1)).not.toBeNull();
    expect((await siteRow(sid)).static_served_version).toBe(2);

    const delayed = deployEnv({ DEPLOYER: deployer, CONFIG_KV: failingKv(/:active$/, "put") });
    const result = await publishSite(delayed, db, await siteRow(sid), actor, t0 + 600_000);
    expect(result).toMatchObject({ ok: true, version: 3, staticDeploy: "deployed" });
    expect(await config(sid, 1)).toBeNull();
    expect(await config(sid, 2)).not.toBeNull(); // KV の active がまだ参照している
    expect(await config(sid, 3)).not.toBeNull(); // D1 の新しい版
    expect(await active(sid)).toBe("2");
    expect((await siteRow(sid)).static_served_version).toBe(3);
  });

  it("cleanup keeps the version kv active points at even when d1 disagrees", async () => {
    // 複合故障: active put の成否が不明で KV が D1 に追いつかないまま Publish が進む状態。
    // D1 の記帳(activated_at / 新しい版)だけで消す判断をすると、edge が読んでいる版を消してしまう
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    const t0 = 1_800_000_000_000;
    expect((await publishSite(deployEnv(), db, await siteRow(sid), userActor(owner.userId), t0)).ok).toBe(true); // v1(KV active = "1")
    // `:active` への put を握りつぶす KV = put は成功を返すが KV は更新されない(= 成否不明のまま取り残された状態)
    const droppedActivePut = new Proxy(env.CONFIG_KV, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p !== "put") return typeof v === "function" ? v.bind(t) : v;
        return async (k: string, ...rest: unknown[]) => {
          if (/:active$/.test(k)) return; // 書いたことにして捨てる
          return (t.put as (...a: unknown[]) => unknown).apply(t, [k, ...rest]);
        };
      },
    }) as KVNamespace;
    const stuck = deployEnv({ CONFIG_KV: droppedActivePut });
    for (let i = 1; i < 7; i++) expect((await publishSite(stuck, db, await siteRow(sid), userActor(owner.userId), t0 + i * 1000)).ok).toBe(true); // v2..v7
    expect(await active(sid)).toBe("1"); // edge はまだ v1 を配信している
    expect((await siteRow(sid)).active_version).toBe(7); // D1 だけが先に進んだ
    // 10 分後の Publish。v1 は新しい版に押し出され activated_at も 10 分前 —
    // 守れるのは「KV の active が v1 を指している」という事実だけ(v8 は今書いた版)
    expect((await publishSite(stuck, db, await siteRow(sid), userActor(owner.userId), t0 + 600_000)).ok).toBe(true); // v8
    expect(await active(sid)).toBe("1");
    expect(await config(sid, 1)).not.toBeNull(); // 配信中の config は消さない
    // 「直近 5 版」は無いので消える。配信ファイルが配っている版(v7。掃除の時点)以上の v7・v8 は残り、v2〜v6 は消える
    for (let v = 2; v <= 6; v++) expect(await config(sid, v)).toBeNull();
    for (let v = 7; v <= 8; v++) expect(await config(sid, v)).not.toBeNull();
  });

  it("cleanup_keeps_only_versions_needed_for_the_switch", async () => {
    // plan12 K14 (b): 公開を 7 回した後に残るのは、配信中の版・配信ファイルが配る版以上・5 分以内に有効だった版だけ
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 7; i++) expect((await publishSite(deployEnv(), db, await siteRow(sid), userActor(owner.userId), t0 + i * 1000)).ok).toBe(true);
    // 7 版目の掃除の時点では 7 版すべてが 5 分以内に有効だった → 全部残る
    for (let v = 1; v <= 7; v++) expect(await config(sid, v)).not.toBeNull();
    // 5 分より後に cleanupOldVersions を呼ぶ(Cron と同じ呼び方)。7 版目だけが残る
    expect((await cleanupOldVersions(deployEnv(), db, sid, 7, t0 + 6 * 60_000)).queries).toBeGreaterThan(0);
    for (let v = 1; v <= 6; v++) expect(await config(sid, v)).toBeNull();
    expect(await config(sid, 7)).not.toBeNull();
    // 何も消すものが無いときは beforeDelete(凍結の確かめ)も呼ばない
    let guarded = 0;
    await cleanupOldVersions(deployEnv(), db, sid, 7, t0 + 7 * 60_000, async () => void guarded++);
    expect(guarded).toBe(0);
  });

  it("delayed retry never overwrites a newer version", async () => {
    // v2 の初回 put を失敗させて 1.1 秒待たせる間に v3 を完了させる。v2 の再試行は D1 最新(3)を書く
    const { owner, sid } = await siteWithRunning();
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    const slow = publishRes(owner.token, sid, { CONFIG_KV: failingKv(/:active$/, "put", 1) }); // v2: 初回 put 失敗 → 1.1 秒待ち
    await new Promise((r) => setTimeout(r, 100));
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // v3 完了
    const r2 = await json<PublishResult>(await slow);
    expect(r2.ok).toBe(true);
    expect(await active(sid)).toBe("3");
    expect((await siteRow(sid)).active_kv_stale).toBe(0);
  });

  it("published_status is guarded when a newer version wins before the activation batch", async () => {
    const { owner, sid, eid } = await siteWithRunning();
    const hook = beforeD1BatchMatching(env.DB, /update "sites" set "active_version"/i, () =>
      getDb(env).updateTable("sites").set({ active_version: 2 }).where("id", "=", sid).execute());
    expect(await json(await publishRes(owner.token, sid, { DB: hook.db }))).toMatchObject({ ok: true, superseded: true });
    expect(hook.ran()).toBe(true);
    const exp = await getDb(env).selectFrom("experiments").select("published_status").where("site_id", "=", sid).where("id", "=", eid).executeTakeFirstOrThrow();
    expect(exp.published_status).toBeNull();
  });

  it("reconcile clears the stale flag only if the version it wrote is still the latest", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    const db = getDb(env);
    await db.updateTable("sites").set({ active_kv_stale: 1 }).where("id", "=", sid).execute();
    await agePublish(sid, 30_001);
    await env.CONFIG_KV.delete(kvKeys.active(sid));
    // reconcile(GET /sites/:sid の自己修復)が v1 を put している最中に D1 が v2 へ進んだ
    const res = await call("GET", `/sites/${sid}`, { token: owner.token, envOverride: { CONFIG_KV: kvBumpingActiveOnPut(sid, 2) } });
    expect(res.status).toBe(200);
    expect(await active(sid)).toBe("1"); // KV は古い版のまま
    expect((await siteRow(sid)).active_kv_stale).toBe(1); // 観測した版(1)がもう最新ではないので旗は下ろさない
    expect((await json(res)).activeKvStale).toBe(true);
  });

  it("a publish overtaken by a newer activation is recorded as superseded", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    expect((await publishSite(testEnv, db, await siteRow(sid), userActor(owner.userId))).ok).toBe(true); // v1
    // 自分より新しい version が先に active になった状態(別 isolate の Publish が勝った)
    await db.updateTable("sites").set({ active_version: 9 }).where("id", "=", sid).execute();
    const r = await publishSite(testEnv, db, await siteRow(sid), userActor(owner.userId));
    expect(r).toMatchObject({ ok: true, version: 2, superseded: true, staticDeploy: "skipped" });
    expect(await active(sid)).toBe("1"); // KV の active は触らない
    const row = await db.selectFrom("publishes").select("status").where("site_id", "=", sid).where("version", "=", 2).executeTakeFirstOrThrow();
    expect(row.status).toBe("superseded");
  });

  // 7n(B48): 予約行が途中で消えた公開(D1 を Time Travel で戻した後に、戻す前から続いていた公開など)は activation しない
  it("publish_fails_without_activation_when_reserved_row_is_gone_7n", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    expect((await publishSite(deployEnv(), db, await siteRow(sid), userActor(owner.userId))).ok).toBe(true); // v1
    // 手順 4(設定の記録)の後、activation の CAS の batch の直前に v2 の予約行を消す
    const hooked = beforeD1BatchMatching(env.DB, /update "sites" set "active_version"/i, async () => {
      await env.DB.prepare("delete from publishes where site_id = ? and version = 2").bind(sid).run();
    });
    const e = deployEnv({ DB: hooked.db });
    const r = await publishSite(e, getDb(e), await siteRow(sid), userActor(owner.userId));
    expect(hooked.ran()).toBe(true);
    expect(r).toMatchObject({ ok: false, version: 2, error: "publish_record_missing" });
    expect((await siteRow(sid)).active_version).toBe(1);
    expect(await env.CONFIG_KV.get(kvKeys.config(sid, 2))).toBeNull(); // 置いた config は消す
    expect(await active(sid)).toBe("1");
    // CAS の batch の後ろの文(届く定義の行)も書かれない
    const delivered = await db.selectFrom("experiment_delivered_definitions").select("publish_version").where("site_id", "=", sid).where("publish_version", "=", 2).execute();
    expect(delivered).toEqual([]);
  });

  it("publish_record_missing_keeps_a_config_another_publish_wrote_under_the_same_version_7n", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    expect((await publishSite(deployEnv(), db, await siteRow(sid), userActor(owner.userId))).ok).toBe(true); // v1
    // 戻した後の公開し直しが同じ版の番号(2)を取り直し、同じキーに別の config を書いた
    const hooked = beforeD1BatchMatching(env.DB, /update "sites" set "active_version"/i, async () => {
      await env.DB.prepare("delete from publishes where site_id = ? and version = 2").bind(sid).run();
      await env.CONFIG_KV.put(kvKeys.config(sid, 2), "{\"other\":true}");
    });
    const e = deployEnv({ DB: hooked.db });
    expect(await publishSite(e, getDb(e), await siteRow(sid), userActor(owner.userId))).toMatchObject({ ok: false, error: "publish_record_missing" });
    expect(await env.CONFIG_KV.get(kvKeys.config(sid, 2))).toBe("{\"other\":true}");
  });

  // 7n レビュー: 戻した後に別の公開が同じ版の番号を取り直していれば(行の id は問わない)、同じ bytes でも KV の config を消さない
  it("publish_record_missing_keeps_the_config_when_the_version_is_taken_by_another_row_7n", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    expect((await publishSite(deployEnv(), db, await siteRow(sid), userActor(owner.userId))).ok).toBe(true); // v1
    let bytes: string | null = null;
    const hooked = beforeD1BatchMatching(env.DB, /update "sites" set "active_version"/i, async () => {
      bytes = await env.CONFIG_KV.get(kvKeys.config(sid, 2)); // 自分(A)が置いた bytes = B が置く bytes と同じ
      await env.DB.prepare("delete from publishes where site_id = ? and version = 2").bind(sid).run();
      await env.DB.prepare("insert into publishes (id, site_id, version, status, published_by, created_at) values ('pub_other', ?, 2, 'active', ?, ?)").bind(sid, owner.userId, Date.now()).run();
    });
    const e = deployEnv({ DB: hooked.db });
    expect(await publishSite(e, getDb(e), await siteRow(sid), userActor(owner.userId))).toMatchObject({ ok: false, error: "publish_record_missing" });
    expect(bytes).not.toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.config(sid, 2))).toBe(bytes);
  });

  // 7n レビュー: 読み直しを使い切った最後の CAS の直前に予約行が消えたら、superseded(と偽の公開の記録)にせず publish_record_missing
  it.each(["publish_record_missing", "publish_reservation_expired", "state_changed", "invalid_transition"] as const)("diagnoses_%s_after_the_last_failed_cas", async (code) => {
    const { owner, sid, eid } = await siteWithRunning();
    const db = getDb(env);
    expect((await publishSite(deployEnv(), db, await siteRow(sid), userActor(owner.userId))).ok).toBe(true); // v1
    // CAS の batch の直前に毎回 active_version を 1 ⇄ null で入れ替えて CAS を外させ、5 回目に予約行の削除または状態変更を差し込む
    const sqlOf = new WeakMap<object, string>();
    let casBatches = 0;
    const racing = new Proxy(env.DB, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "prepare")
          return (q: string) => {
            const remember = (s: D1PreparedStatement): D1PreparedStatement => {
              sqlOf.set(s, q);
              const bind = s.bind.bind(s);
              return Object.assign(s, { bind: (...a: unknown[]) => remember(bind(...a)) });
            };
            return remember(t.prepare(q));
          };
        if (p === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (stmts.some((s) => /update "sites" set "active_version"/i.test(sqlOf.get(s) ?? ""))) {
              casBatches++;
              await t.prepare("update sites set active_version = case when active_version is null then 1 else null end where id = ?").bind(sid).run();
              if (casBatches === 5) {
                const change = code === "publish_record_missing"
                  ? "delete from publishes where site_id = ? and version = 2"
                  : code === "publish_reservation_expired" ? "update publishes set status='failed', error='interrupted: reserved row expired' where site_id=? and version=2"
                  : "update experiments set status = 'paused' where site_id = ?";
                await t.prepare(change).bind(sid).run();
              }
            }
            return t.batch(stmts);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as D1Database;
    const e = deployEnv({ DB: racing });
    if (code === "invalid_transition") {
      const res = await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status: "paused" }, envOverride: e });
      expect(casBatches).toBe(5);
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ error: code, from: "paused" });
      const row = await db.selectFrom("publishes").select(["status", "error"]).where("site_id", "=", sid).where("version", "=", 2).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: "failed", error: expect.stringMatching(/^transition_conflict:/) });
      return;
    }
    const r = await publishSite(e, getDb(e), await siteRow(sid), userActor(owner.userId));
    expect(casBatches).toBe(5);
    expect(r).toMatchObject({ ok: false, version: 2, error: code });
    expect((await env.CONFIG_KV.get(kvKeys.config(sid, 2))) === null).toBe(code === "publish_record_missing");
    const audits = await env.DB.prepare("select detail_json from audit_events where site_id = ? and action = 'publish.publish'").bind(sid).all<{ detail_json: string }>();
    expect(audits.results.map((a) => JSON.parse(a.detail_json))).toEqual([{ version: 1, superseded: false }]);
  });

  // 7n(G04 (b)): KV の削除に失敗した版には「消した」の印を付けない(次の掃除で拾う)
  it("cleanup_marks_only_versions_whose_kv_delete_succeeded_7n", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 4; i++) expect((await publishSite(deployEnv(), db, await siteRow(sid), userActor(owner.userId), t0 + i * 1000)).ok).toBe(true);
    const failingDelete = new Proxy(env.CONFIG_KV, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "delete")
          return async (k: string) => {
            if (k === kvKeys.config(sid, 2)) throw new Error("injected kv delete failure");
            return t.delete(k);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as KVNamespace;
    await cleanupOldVersions(deployEnv({ CONFIG_KV: failingDelete }), db, sid, 4, t0 + 6 * 60_000);
    const marks = await db.selectFrom("publishes").select(["version", "kv_deleted"]).where("site_id", "=", sid).orderBy("version").execute();
    expect(marks).toEqual([
      { version: 1, kv_deleted: 1 },
      { version: 2, kv_deleted: 0 },
      { version: 3, kv_deleted: 1 },
      { version: 4, kv_deleted: 0 },
    ]);
    expect(await config(sid, 2)).not.toBeNull();
    // 次の掃除で消えて印が付く
    await cleanupOldVersions(deployEnv(), db, sid, 4, t0 + 7 * 60_000);
    expect(await config(sid, 2)).toBeNull();
    expect((await db.selectFrom("publishes").select("kv_deleted").where("site_id", "=", sid).where("version", "=", 2).executeTakeFirstOrThrow()).kv_deleted).toBe(1);
  });

  // 7n(G04 (d)): 古い公開の active の put が、新しい公開の put の後・印の前に着いたとき、KV は古い版なのに「食い違いなし」で止まらない
  it("stale_flag_stays_when_an_older_active_put_lands_last_7n", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    // v2 の公開(B)が active = 2 を書いた直後に、v1 を読んでいた公開(A)の put(1)が遅れて着く
    const lateOlderPut = new Proxy(env.CONFIG_KV, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "put")
          return async (k: string, ...rest: unknown[]) => {
            const out = await (t.put as (...a: unknown[]) => Promise<void>).apply(t, [k, ...rest]);
            if (/:active$/.test(k)) await t.put(k, "1");
            return out;
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as KVNamespace;
    const r = await json<PublishResult>(await publishRes(owner.token, sid, { CONFIG_KV: lateOlderPut }));
    expect(r).toMatchObject({ ok: true, version: 2, superseded: false });
    expect(await active(sid)).toBe("1");
    expect((await siteRow(sid)).active_version).toBe(2);
    expect((await siteRow(sid)).active_kv_stale).toBe(1);
    await agePublish(sid, 30_001);
    // 次の GET /sites/:sid の自己修復が KV を D1 に揃える
    expect((await call("GET", `/sites/${sid}`, { token: owner.token })).status).toBe(200);
    expect(await active(sid)).toBe("2");
    expect((await siteRow(sid)).active_kv_stale).toBe(0);
  });

  it("site with a running experiment cannot be deleted until the stop is published", async () => {
    // Task 3 の DELETE /sites/:sid の仕様(/publish と Experiment が要るのでここに置く)
    const { owner, sid, eid } = await siteWithRunning();
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // published_status = running
    const admin = await inviteAndJoin(owner.token, owner.workspaceId, "admin");
    expect((await call("DELETE", `/sites/${sid}`, { token: admin.token })).status).toBe(403); // OWNER 限定
    await runDirect(sid, eid, "archived"); // Desired は archived だが Published は running のまま
    const res = await call("DELETE", `/sites/${sid}`, { token: owner.token });
    expect(res.status).toBe(409);
    const resBody = (await expectEnvelope(res)) as { error: string; message: string };
    expect(resBody.error).toBe("site_has_running_experiments");
    // 管理画面の Site 削除ボタンがそのまま表示する文言(Task 11)
    expect(resBody.message).toBe("配信中または一時停止中のエクスペリエンスがあります。終了を公開してから削除してください");
    await env.ASSETS!.put(`sites/${sid}/experiments/${eid}/x.png`, new Uint8Array([1, 2, 3]));
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // Stop を Publish
    expect((await call("DELETE", `/sites/${sid}`, { token: owner.token })).status).toBe(204);
    expect((await env.ASSETS!.list({ prefix: `sites/${sid}/` })).objects).toEqual([]);
    expect(await env.CONFIG_KV.get(kvKeys.settings(sid))).toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.active(sid))).toBeNull();
  });

  it("blocks site deletion for a paused experiment until its end is published", async () => {
    const { owner, sid, eid } = await siteWithRunning();
    const { token } = owner;
    const expectBlocked = async () => {
      const response = await call("DELETE", `/sites/${sid}`, { token });
      expect(response.status).toBe(409);
      expect(await expectEnvelope(response)).toMatchObject({
        error: "site_has_running_experiments",
        message: "配信中または一時停止中のエクスペリエンスがあります。終了を公開してから削除してください",
      });
      expect(await env.CONFIG_KV.get(kvKeys.settings(sid))).not.toBeNull();
    };

    await runDirect(sid, eid, "paused"); // 状態だけが一時停止中(未公開)
    await expectBlocked();

    expect((await json<PublishResult>(await publishRes(token, sid))).ok).toBe(true);
    await runDirect(sid, eid, "archived"); // 公開済みの状態だけが一時停止中
    await expectBlocked();
    expect(await active(sid)).toBe("1");

    expect((await json<PublishResult>(await publishRes(token, sid))).ok).toBe(true);
    expect((await call("DELETE", `/sites/${sid}`, { token })).status).toBe(204);
  });
});

describe("publish orders experiments by priority (決定 51、設計書 §3.2・§9.3)", () => {
  it("compiles singles first (oldest created) and tests newest-started first", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const mk = async (id: string, kind: "test" | "single") => {
      expect((await call("POST", `/sites/${sid}/experiments`, { token, body: { id, name: id, kind, urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } })).status).toBe(201);
      const vid = kind === "single" ? "a" : "b";
      await call("PUT", `/sites/${sid}/experiments/${id}/variants/${vid}/changes`, { token, body: [TEXT_CHANGE()] });
    };
    await mk("s1", "single");
    await mk("t1", "test");
    await mk("t2", "test");
    // 開始の時刻を明示する(同じテストの中で Date.now() が同じミリ秒になり得るため、D1 を直接書く)
    await env.DB.prepare("update experiments set status = 'running', last_started_at = ? where site_id = ? and id = ?").bind(1_000, sid, "t1").run();
    await env.DB.prepare("update experiments set status = 'running', last_started_at = ? where site_id = ? and id = ?").bind(5_000, sid, "t2").run();
    await env.DB.prepare("update experiments set status = 'running', last_started_at = ? where site_id = ? and id = ?").bind(9_000, sid, "s1").run();
    const res = await json(await publishRes(token, sid));
    expect(res.ok).toBe(true);
    const detail = await json(await call("GET", `/sites/${sid}/publishes/${res.version}`, { token }));
    expect(detail.config.experiments.map((e: any) => e.id)).toEqual(["s1", "t2", "t1"]);
    expect(detail.config.experiments.every((e: any) => !("kind" in e))).toBe(true);
  });

  it("resumed_test_yields_to_running_test", async () => {
    // T1 を開始 → 一時停止 → T2 を開始 → T1 を再開。T1 は配信に入り直したので、テストの中で優先が最も低い(先頭側)
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    for (const id of ["t1", "t2"]) {
      await call("POST", `/sites/${sid}/experiments`, { token, body: { id, name: id, urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } });
      await call("PUT", `/sites/${sid}/experiments/${id}/variants/b/changes`, { token, body: [TEXT_CHANGE()] });
    }
    const status = (id: string, to: string) => call("POST", `/sites/${sid}/experiments/${id}/status`, { token, body: { status: to } }).then((r) => json(r));
    await status("t1", "running");
    await status("t1", "paused");
    await status("t2", "running");
    const resumed = await status("t1", "running");
    expect(resumed.publish.ok).toBe(true);
    const detail = await json(await call("GET", `/sites/${sid}/publishes/${resumed.publish.version}`, { token }));
    expect(detail.config.experiments.map((e: any) => e.id)).toEqual(["t1", "t2"]);
    const t1 = await env.DB.prepare("select started_at, last_started_at from experiments where site_id = ? and id = 't1'").bind(sid).first<{ started_at: number; last_started_at: number }>();
    expect(t1!.last_started_at).toBeGreaterThanOrEqual(t1!.started_at); // started_at(最初の開始)は動かない
  });
});

describe("overlap warnings (決定 51、設計書 §3.3)", () => {
  async function siteWithTwoTests() {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    for (const [id, started] of [["t1", 1_000], ["t2", 5_000]] as const) {
      await call("POST", `/sites/${sid}/experiments`, { token, body: { id, name: id.toUpperCase(), urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } });
      await call("PUT", `/sites/${sid}/experiments/${id}/variants/b/changes`, { token, body: [TEXT_CHANGE()] });
      await env.DB.prepare("update experiments set status = 'running', last_started_at = ? where site_id = ? and id = ?").bind(started, sid, id).run();
    }
    return { token, sid };
  }

  it("adds the overlap to the publish warnings without refusing", async () => {
    const { token, sid } = await siteWithTwoTests();
    const res = await json<any>(await publishRes(token, sid));
    expect(res.ok).toBe(true);
    expect(res.warnings).toContainEqual({ path: "experiments.t2", message: expect.stringContaining("「T1」(先に開始・再開)が優先され") });
  });

  it("publish-preview lists overlaps, and ?starting= treats a draft as started now", async () => {
    const { token, sid } = await siteWithTwoTests();
    const preview = await json<any>(await call("GET", `/sites/${sid}/publish-preview`, { token }));
    expect(preview.overlaps).toEqual([expect.objectContaining({ path: "experiments.t2", experimentIds: ["t2", "t1"] })]);
    await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "t3", name: "T3", urlMatch: { include: [{ page: { op: "contains", value: "/" } }] } } });
    await call("PUT", `/sites/${sid}/experiments/t3/variants/b/changes`, { token, body: [TEXT_CHANGE()] });
    const starting = await json<any>(await call("GET", `/sites/${sid}/publish-preview?starting=t3`, { token }));
    // t3 は今開始した = テストの中で優先が最も低い。t3 を含む組だけを返す
    expect(starting.overlaps.map((o: any) => o.experimentIds)).toEqual([["t3", "t2"], ["t3", "t1"]]);
    expect(starting.compileError).toEqual(preview.compileError); // starting は overlaps だけに効く
    expect((await call("GET", `/sites/${sid}/publish-preview?starting=Bad!`, { token })).status).toBe(422);
    // 一時停止中のテストも「今再開した」として並べる(t1 を止めると、再開したときは t2 より優先が低い)
    await env.DB.prepare("update experiments set status = 'paused' where site_id = ? and id = 't1'").bind(sid).run();
    const resuming = await json<any>(await call("GET", `/sites/${sid}/publish-preview?starting=t1`, { token }));
    expect(resuming.overlaps.map((o: any) => o.experimentIds)).toEqual([["t1", "t2"]]);
  });

  it("publish-preview keeps overlaps even when the draft cannot be compiled", async () => {
    const { token, sid } = await siteWithTwoTests();
    await env.DB.prepare("update experiments set targeting_json = ? where site_id = ? and id = 't1'").bind(JSON.stringify({ audience: "aud_missing" }), sid).run();
    const preview = await json<any>(await call("GET", `/sites/${sid}/publish-preview`, { token }));
    expect(preview.compileError).not.toBeNull();
    expect(preview.overlaps).toHaveLength(1);
  });
});

describe("dataLayer names are baked into payloads (B77)", () => {
  it("publish_bakes_conversion_payloads", async () => {
    // K5: 目標名は「外部計測で指定 ?? 目標 ID」で conversionPayloads に焼き、goals[] には名前を出さない
    const { owner, sid } = await siteWithRunning();
    const goal = (body: Record<string, unknown>) => call("POST", `/sites/${sid}/goals`, { token: owner.token, body: { type: "CUSTOM", config: {}, ...body } });
    expect((await goal({ id: "g_named", name: "購入(社内名)", analytics: { overrides: { goalName: "purchase" } } })).status).toBe(201);
    expect((await goal({ id: "g_plain", name: "資料請求(社内名)" })).status).toBe(201);
    const r = await json<PublishResult & { ok: true }>(await publishRes(owner.token, sid));
    expect(r.ok).toBe(true);
    const raw = JSON.parse((await env.CONFIG_KV.get(kvKeys.config(sid, r.version)))!);
    expect(raw.conversionPayloads).toEqual({ g_named: { goalId: "g_named", goalName: "purchase" }, g_plain: { goalId: "g_plain", goalName: "g_plain" } });
    expect(raw.goals.map((g: Record<string, unknown>) => g.id).sort()).toEqual(["g_named", "g_plain"]);
    for (const g of raw.goals) expect(g).not.toHaveProperty("name");
    expect(JSON.stringify(raw)).not.toContain("社内名");
  });

  it("backfill_keeps_compiled_names", async () => {
    // K7 / Review Focus 3: 外部計測が空の開始済みのテストと目標は、マイグレーションで名前を写すので、
    // その後の compile の出力の名前は写す前(名前を出していたころ)と同じ
    const mine = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_variant_original_and_memo.sql"))!.name;
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < mine));
    const t = 1_700_000_000_000;
    const insertVar = `insert into variants (site_id, experiment_id, id, name, weight, position, analytics_json) values ('s1', 'e_run', ?1, ?2, 50, ?3, ?4)`;
    const insertGoal = `insert into goals (site_id, id, name, type, config_json, created_at, updated_at) values ('s1', ?1, ?2, 'CUSTOM', '{}', ?3, ?3)`;
    await env.DB.batch([
      env.DB.prepare(`insert into organization (id, name, slug, "createdAt") values ('w1', 'W', 'ws-1', '2026-09-01T00:00:00.000Z')`),
      env.DB.prepare(
        `insert into sites (id, workspace_id, name, domain, site_salt, content_updated_at, created_at, updated_at) values ('s1', 'w1', 'S', 'example.com', 'salt', ?1, ?1, ?1)`,
      ).bind(t),
      env.DB.prepare(
        `insert into experiments (site_id, id, name, status, url_match_json, analytics_json, started_at, created_by, updated_by, created_at, updated_at) values ('s1', 'e_run', '購入ボタンのテスト', 'running', '{"include":[{"page":{"op":"contains","value":"/"}}]}', null, ?1, 'u', 'u', ?1, ?1)`,
      ).bind(t),
      env.DB.prepare(insertVar).bind("a", "元のボタン", 0, null),
      env.DB.prepare(insertVar).bind("b", "赤いボタン", 1, JSON.stringify({ overrides: { variantName: "red" } })),
      env.DB.prepare(insertGoal).bind("g_buy", "購入", t),
    ]);
    const names = async () => {
      const config = compile(await buildCompileInput(getDb(env), await siteRow("s1"), 1));
      return { exposure: config.exposurePayloads, conversion: config.conversionPayloads };
    };
    // 写す前の行をそのまま compile すると、上書きの無い名前は ID になる(写さなければ出力が変わる)
    expect((await names()).conversion).toEqual({ g_buy: { goalId: "g_buy", goalName: "g_buy" } });
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    // 写した後は、名前を出していたころの「上書き ?? 名前」と同じ
    expect(await names()).toEqual({
      exposure: {
        e_run: {
          a: { experimentId: "e_run", experimentName: "購入ボタンのテスト", variantId: "a", variantName: "元のボタン", extra: {} },
          b: { experimentId: "e_run", experimentName: "購入ボタンのテスト", variantId: "b", variantName: "red", extra: {} },
        },
      },
      conversion: { g_buy: { goalId: "g_buy", goalName: "購入" } },
    });
  });
});

describe("publish expected preview digest", () => {
  const digestFor = async (sid: string) => compileInputDigest(await buildCompileInput(getDb(env), await siteRow(sid), 1));

  it("publish_without_body_keeps_working", async () => {
    const { owner, sid } = await siteWithRunning();
    expect(await json(await call("POST", `/sites/${sid}/publish`, { token: owner.token }))).toMatchObject({ ok: true });
  });
  it("publish_with_matching_digest_succeeds", async () => {
    const { owner, sid } = await siteWithRunning();
    expect(await json(await call("POST", `/sites/${sid}/publish`, { token: owner.token, body: { expectDigest: await digestFor(sid) } }))).toMatchObject({ ok: true });
  });
  it("publish_with_stale_digest_fails_and_keeps_active", async () => {
    const { owner, sid, eid } = await siteWithRunning();
    await publishRes(owner.token, sid);
    const digest = await digestFor(sid);
    const editor = await inviteAndJoin(owner.token, owner.workspaceId, "editor");
    const saved = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: editor.token, body: [{ ...TEXT_CHANGE(), payload: { text: "After preview" } }] });
    expect(saved.status).toBe(200);
    expect(await json(await call("POST", `/sites/${sid}/publish`, { token: owner.token, body: { expectDigest: digest } }))).toMatchObject({
      ok: false, error: "stale_preview", message: "確認した後に、公開する内容が変わりました",
    });
    expect((await siteRow(sid)).active_version).toBe(1);
    expect(await active(sid)).toBe("1");
    expect(await getDb(env).selectFrom("publishes").select("status").where("site_id", "=", sid).where("version", "=", 2).executeTakeFirst()).toEqual({ status: "failed" });
  });
  it("publish_same_content_twice_with_same_digest_succeeds", async () => {
    const { owner, sid } = await siteWithRunning();
    const expectDigest = await digestFor(sid);
    for (const version of [1, 2]) expect(await json(await call("POST", `/sites/${sid}/publish`, { token: owner.token, body: { expectDigest } }))).toMatchObject({ ok: true, version });
  });
  it("publish_rejects_malformed_expect_digest", async () => {
    const { owner, sid } = await siteWithRunning();
    for (const body of [{ expectDigest: "x" }, { other: 1 }, null, []]) {
      const res = await call("POST", `/sites/${sid}/publish`, { token: owner.token, body });
      expect(res.status).toBe(422);
      expect(await json(res)).toMatchObject({ error: "validation_failed" });
    }
    const res = await call("POST", `/sites/${sid}/publish`, { token: owner.token, raw: "{", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: "bad_request" });
  });
  it("publish_accepts_empty_body_with_json_content_type", async () => {
    const { owner, sid } = await siteWithRunning();
    expect(await json(await call("POST", `/sites/${sid}/publish`, { token: owner.token, headers: { "content-type": "application/json" } }))).toMatchObject({ ok: true });
  });
});

it("ambiguous late publish put raises the flag cleared by a newer publish", async () => {
  const { sid, owner } = await siteWithRunning();
  const kv = lateFailingActivePut(sid, async () => {
    expect(await json(await publishRes(owner.token, sid))).toMatchObject({ ok: true, version: 2 });
    expect(await siteRow(sid)).toMatchObject({ active_version: 2, active_kv_stale: 0 });
    expect(await active(sid)).toBe("2");
  });
  expect(await json(await publishRes(owner.token, sid, { CONFIG_KV: kv }))).toMatchObject({ ok: true, version: 1 });
  expect(await active(sid)).toBe("1");
  expect(await siteRow(sid)).toMatchObject({ active_version: 2, active_kv_stale: 1 });
});

it("site_settings_read_with_compile_rows", async () => {
  const { owner, sid } = await siteWithRunning();
  const hook = beforeD1BatchMatching(env.DB, /select \* from "audiences"/i, () =>
    getDb(env).updateTable("sites").set({ timezone: "Europe/Paris" }).where("id", "=", sid).execute());
  expect(await json(await publishRes(owner.token, sid, { DB: hook.db }))).toMatchObject({ ok: true });
  expect(hook.ran()).toBe(true);
  expect(await config(sid, 1)).toMatchObject({ timezone: "Europe/Paris" });
});

it("site_settings_changed_after_preview_reject_confirmed_publish", async () => {
  const { owner: { token }, sid } = await siteWithRunning();
  const { digest } = await json(await call("GET", `/sites/${sid}/publish-preview`, { token }));
  const hook = beforeD1BatchMatching(env.DB, /select \* from "audiences"/i, () =>
    getDb(env).updateTable("sites").set({ retention_days: 45 }).where("id", "=", sid).execute());
  const response = await call("POST", `/sites/${sid}/publish`, { token, body: { expectDigest: digest }, envOverride: { DB: hook.db } });
  expect(hook.ran()).toBe(true);
  expect(await json(response)).toMatchObject({ ok: false, error: "stale_preview" });
  expect(await active(sid)).toBeNull();
});

it("edit_after_read_stays_unpublished", async () => {
  const { owner, sid } = await siteWithRunning();
  const hook = beforeD1BatchMatching(env.DB, /update "sites" set "active_version"/i, () =>
    createExperiment(owner.token, sid, { id: "exp_concurrent" }));
  expect(await json(await publishRes(owner.token, sid, { DB: hook.db }))).toMatchObject({ ok: true });
  expect(hook.ran()).toBe(true);
  expect(await json(await call("GET", `/sites/${sid}`, { token: owner.token }))).toMatchObject({ hasUnpublishedChanges: true });
});

it("preview_after_site_row_added", async () => {
  const { owner: { token }, sid, eid } = await siteWithRunning();
  const targeting = { hist: "visited", page: { part: "path", op: "contains", value: "/before" } };
  await getDb(env).updateTable("experiments").set({ targeting_json: JSON.stringify(targeting) }).where("site_id", "=", sid).where("id", "=", eid).execute();
  expect(await json(await publishRes(token, sid))).toMatchObject({ ok: true, version: 1 });
  const res = await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token, body: [TEXT_CHANGE("c_updated")] });
  expect(res.status).toBe(200);
  const aud = await call("POST", `/sites/${sid}/audiences`, { token, body: {
    id: "aud_updated", name: "Mobile", definition: { ctx: "device", op: "in", value: ["mobile"] },
  } });
  expect(aud.status).toBe(201);
  // 前の版のみにあるページ条件が落ちた差分を作る。
  await getDb(env).updateTable("experiments").set({ targeting_json: null, updated_at: Date.now() }).where("site_id", "=", sid).where("id", "=", eid).execute();
  const site = await siteRow(sid);
  const digest = await compileInputDigest(await buildCompileInput(getDb(env), site, 2));
  const preview = await json(await call("GET", `/sites/${sid}/publish-preview`, { token }));
  expect(preview).toMatchObject({
    digest, lastActivatedAt: site.last_activated_at, compileError: null,
    experiments: [{ id: eid, changedChanges: [{ id: "c_updated" }] }],
    audienceChanges: [{ id: "aud_updated" }], droppedPageConditions: [targeting.page],
  });
});

async function collectionFixture() {
  const f = await siteWithRunning();
  await env.DB.batch([
    env.DB.prepare("update sites set results_enabled = 1 where id = ?").bind(f.sid),
    env.DB.prepare("update experiments set run_id = ? where site_id = ? and id = ?").bind(newRunId(), f.sid, f.eid),
    env.DB.prepare("update changes set payload_json = ? where site_id = ? and experiment_id = ?")
      .bind(JSON.stringify({ text: "asset_0123456789" }), f.sid, f.eid),
    env.DB.prepare("insert into results_interim_cache (site_id, experiment_id, computed_at, rows_read, result_json) values (?, ?, 1, 1, '{}')").bind(f.sid, f.eid),
  ]);
  return f;
}

it("post_processing_is_in_activation_batch", async () => {
  const { owner, sid, eid } = await collectionFixture();
  const db = getDb(env);
  const prep = await preparePublish(testEnv, db, await siteRow(sid), userActor(owner.userId), Date.now(), {});
  if (!prep.ok) throw new Error("公開の準備に失敗");
  const stop = abortingBindings(testEnv, { at: 2, mode: "after" });
  expect(await settleOrAbort(activatePublish(stop.env, getDb(stop.env), prep.prepared), stop.reached)).toEqual({ aborted: true });
  expect(stop.calls[1]).toMatch(/update "sites" set "active_version"/i);
  expect(await env.DB.prepare("select publish_version from experiment_delivered_definitions where site_id = ?").bind(sid).first("publish_version")).toBe(1);
  expect(await env.DB.prepare("select asset_id from asset_delivered_refs where site_id = ?").bind(sid).first("asset_id")).toBe("asset_0123456789");
  expect(await env.DB.prepare("select status from publishes where id = ?").bind(prep.prepared.rowId).first("status")).toBe("active");
  expect(await env.DB.prepare("select published_status from experiments where site_id = ? and id = ?").bind(sid, eid).first("published_status")).toBe("running");
  expect(await env.DB.prepare("select enabled from results_collection_log where site_id = ?").bind(sid).first("enabled")).toBe(1);
  expect(await env.DB.prepare("select 1 from results_interim_cache where site_id = ?").bind(sid).first()).toBeNull();
});

it("collection_log_time_is_just_before_batch", async () => {
  const { owner, sid } = await collectionFixture();
  const start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  try {
    const kv = new Proxy(env.CONFIG_KV, { get(target, prop) {
      const method = Reflect.get(target, prop);
      if (prop === "get") return (key: string, ...args: unknown[]) => {
        if (key === kvKeys.config(sid, 1)) clock.mockReturnValue(start + 5000);
        return method.apply(target, [key, ...args]);
      };
      return typeof method === "function" ? method.bind(target) : method;
    } });
    const e = deployEnv({ CONFIG_KV: kv });
    expect(await publishSite(e, getDb(e), await siteRow(sid), userActor(owner.userId), start)).toMatchObject({ ok: true });
    expect((await siteRow(sid)).last_activated_at).toBe(start);
    expect(await env.DB.prepare("select at from results_collection_log where site_id = ?").bind(sid).first<number>("at")).toBeGreaterThanOrEqual(start + 5000);
  } finally {
    clock.mockRestore();
  }
});

it("guard_blocks_writes_when_same_version_taken_by_other_row", async () => {
  const { owner, sid, eid } = await collectionFixture();
  const hook = beforeD1BatchMatching(env.DB, /update "sites" set "active_version"/i, async () => {
    await env.DB.batch([
      env.DB.prepare("delete from publishes where site_id = ? and version = 1").bind(sid),
      env.DB.prepare("insert into publishes (id, site_id, version, status, published_by, created_at) values ('pub_other', ?, 1, 'active', ?, 1)").bind(sid, owner.userId),
      env.DB.prepare("update sites set active_version = 1 where id = ?").bind(sid),
    ]);
  });
  expect(await json(await publishRes(owner.token, sid, { DB: hook.db }))).toMatchObject({ ok: false, error: "publish_record_missing" });
  expect(hook.ran()).toBe(true);
  expect(await env.DB.prepare("select 1 from experiment_delivered_definitions where site_id = ?").bind(sid).first()).toBeNull();
  expect(await env.DB.prepare("select 1 from asset_delivered_refs where site_id = ?").bind(sid).first()).toBeNull();
  expect(await env.DB.prepare("select id, activated_at from publishes where site_id = ?").bind(sid).first()).toEqual({ id: "pub_other", activated_at: null });
  expect(await env.DB.prepare("select published_status from experiments where site_id = ? and id = ?").bind(sid, eid).first("published_status")).toBeNull();
  expect(await env.DB.prepare("select 1 from results_collection_log where site_id = ?").bind(sid).first()).toBeNull();
  expect(await env.DB.prepare("select experiment_id from results_interim_cache where site_id = ?").bind(sid).first("experiment_id")).toBe(eid);
  expect(await env.DB.prepare("select 1 from audit_events where site_id = ? and action = 'publish.publish'").bind(sid).first()).toBeNull();
});
