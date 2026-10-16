import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { kvKeys, parseCompiledConfig } from "@wtt/core";
import {
  active,
  call,
  createExperiment,
  createSite,
  expectEnvelope,
  failingKv,
  fakeDeployer,
  inviteAndJoin,
  json,
  publishRes,
  runDirect,
  setupOwner,
  siteRow,
  siteWithRunning,
  TEXT_CHANGE,
  testEnv,
} from "./helpers";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { publishSite, sha256Hex, type PublishResult } from "../src/publish";

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
    expect(cfg?.exposurePayloads?.exp_hero?.b?.variantName).toBe("B");
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
    for (let i = 0; i < 6; i++) expect((await publishSite(deployEnv(), db, site, owner.userId, t0 + i * 1000)).ok).toBe(true);
    // 6 版すべて 5 分以内に active だったので削除されない
    for (let v = 1; v <= 6; v++) expect(await config(sid, v)).not.toBeNull();
    // 10 分後の 7 回目: 直近 5 版(v3〜v7)だけ残る。v1 / v2 は削除
    expect((await publishSite(deployEnv(), db, await siteRow(sid), owner.userId, t0 + 600_000)).ok).toBe(true);
    expect(await config(sid, 1)).toBeNull();
    expect(await config(sid, 2)).toBeNull();
    for (let v = 3; v <= 7; v++) expect(await config(sid, v)).not.toBeNull();
    const deleted = await db.selectFrom("publishes").select(["version", "kv_deleted"]).where("site_id", "=", sid).orderBy("version").execute();
    expect(deleted.filter((r) => r.kv_deleted === 1).map((r) => r.version)).toEqual([1, 2]);
  });

  it("failed_publish_cleanup_never_deletes_active_config", async () => {
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 7; i++) expect((await publishSite(deployEnv(), db, await siteRow(sid), owner.userId, t0 + i * 1000)).ok).toBe(true);
    expect(await active(sid)).toBe("7");
    // 10 分後に失敗する Publish(put で落ちる)。cleanup は走らず、active の v7 と直近版はそのまま
    const r = await publishSite(deployEnv({ CONFIG_KV: failingKv(/config:v8$/) }), db, await siteRow(sid), owner.userId, t0 + 600_000);
    expect(r.ok).toBe(false);
    expect(await active(sid)).toBe("7");
    expect(await config(sid, 7)).not.toBeNull();
    for (let v = 3; v <= 6; v++) expect(await config(sid, v)).not.toBeNull(); // 直近 5 版も失敗 Publish に巻き込まれない
    // 読み戻し失敗(hash 不一致)でも v9 のキーは片付け、active は触らない
    const r2 = await publishSite(deployEnv({ CONFIG_KV: failingKv(/config:v9$/, "get") }), db, await siteRow(sid), owner.userId, t0 + 601_000);
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

  it("active put is retried once and succeeds on the second attempt", async () => {
    const { owner, sid } = await siteWithRunning();
    const res = await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/:active$/, "put", 1) });
    expect(await json(res)).toMatchObject({ ok: true, version: 1 });
    expect(await active(sid)).toBe("1");
  });

  it("active put failing twice rolls d1 back to the previous version", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    const res = await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/:active$/, "put", 2) });
    expect(await json(res)).toMatchObject({ ok: false, version: 2, error: "kv_rate_limited", message: "KV への active の書き込みが制限されました", hint: "数秒後にもう一度公開してください" });
    expect((await siteRow(sid)).active_version).toBe(1);
    expect(await active(sid)).toBe("1");
    // put の成否が不明なので Site は stale として記録される(0003_control.sql の active_kv_stale)
    expect((await siteRow(sid)).active_kv_stale).toBe(1);
    // 次の Publish の冒頭(reconcileActive)が KV active を D1 最新版に揃え直して旗を下ろす。
    // reconcile 単独の効果を見るため、KV 側を失った状態にしてから、自分では active を書かない
    // (config の put で落ちる)Publish を投げる
    await env.CONFIG_KV.delete(kvKeys.active(sid));
    const res2 = await publishRes(owner.token, sid, { CONFIG_KV: failingKv(/config:v3$/) });
    expect(await json(res2)).toMatchObject({ ok: false, version: 3, error: "kv_put_failed" });
    expect(await active(sid)).toBe("1"); // reconcile が再 put した
    expect((await siteRow(sid)).active_kv_stale).toBe(0);
  });

  it("cleanup keeps the version kv active points at even when d1 disagrees", async () => {
    // 複合故障: active put の成否が不明で KV が D1 に追いつかないまま Publish が進む状態。
    // D1 の記帳(直近 5 版 / activated_at)だけで消す判断をすると、edge が読んでいる版を消してしまう
    const { owner, sid } = await siteWithRunning();
    const db = getDb(env);
    const t0 = 1_800_000_000_000;
    expect((await publishSite(deployEnv(), db, await siteRow(sid), owner.userId, t0)).ok).toBe(true); // v1(KV active = "1")
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
    for (let i = 1; i < 7; i++) expect((await publishSite(stuck, db, await siteRow(sid), owner.userId, t0 + i * 1000)).ok).toBe(true); // v2..v7
    expect(await active(sid)).toBe("1"); // edge はまだ v1 を配信している
    expect((await siteRow(sid)).active_version).toBe(7); // D1 だけが先に進んだ
    // 10 分後の Publish。直近 5 版は v4〜v8、v1 は押し出され activated_at も 10 分前 —
    // 守れるのは「KV の active が v1 を指している」という事実だけ
    expect((await publishSite(stuck, db, await siteRow(sid), owner.userId, t0 + 600_000)).ok).toBe(true); // v8
    expect(await active(sid)).toBe("1");
    expect(await config(sid, 1)).not.toBeNull(); // 配信中の config は消さない
    expect(await config(sid, 2)).toBeNull();
    expect(await config(sid, 3)).toBeNull();
    for (let v = 4; v <= 8; v++) expect(await config(sid, v)).not.toBeNull();
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

  it("published_status is not written when a newer version activated during the active put (fence)", async () => {
    const { owner, sid, eid } = await siteWithRunning();
    // v1 の activation(CAS)は成功するが、KV active を書いている最中に別の Publish が v2 を activate した
    const r = await json<PublishResult>(await publishRes(owner.token, sid, { CONFIG_KV: kvBumpingActiveOnPut(sid, 2) }));
    expect(r).toMatchObject({ ok: true, version: 1, superseded: false });
    // 追い越された側は published_status を書かない(書くと v2 の Publish が写した状態を古い写しで上書きしてしまう)
    const exp = await getDb(env).selectFrom("experiments").select("published_status").where("site_id", "=", sid).where("id", "=", eid).executeTakeFirstOrThrow();
    expect(exp.published_status).toBeNull();
    // KV には 1 が書かれ D1 は 2 なので stale(次の reconcile が揃える)
    expect(await active(sid)).toBe("1");
    expect((await siteRow(sid)).active_kv_stale).toBe(1);
  });

  it("reconcile clears the stale flag only if the version it wrote is still the latest", async () => {
    const { owner, sid } = await siteWithRunning();
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // v1
    const db = getDb(env);
    await db.updateTable("sites").set({ active_kv_stale: 1 }).where("id", "=", sid).execute();
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
    expect((await publishSite(testEnv, db, await siteRow(sid), owner.userId)).ok).toBe(true); // v1
    // 自分より新しい version が先に active になった状態(別 isolate の Publish が勝った)
    await db.updateTable("sites").set({ active_version: 9 }).where("id", "=", sid).execute();
    const r = await publishSite(testEnv, db, await siteRow(sid), owner.userId);
    expect(r).toMatchObject({ ok: true, version: 2, superseded: true, staticDeploy: "skipped" });
    expect(await active(sid)).toBe("1"); // KV の active は触らない
    const row = await db.selectFrom("publishes").select("status").where("site_id", "=", sid).where("version", "=", 2).executeTakeFirstOrThrow();
    expect(row.status).toBe("superseded");
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
    expect(resBody.message).toBe("配信中のエクスペリエンスがあります。先に終了してから削除してください");
    await env.ASSETS!.put(`sites/${sid}/experiments/${eid}/x.png`, new Uint8Array([1, 2, 3]));
    expect((await json<PublishResult>(await publishRes(owner.token, sid))).ok).toBe(true); // Stop を Publish
    expect((await call("DELETE", `/sites/${sid}`, { token: owner.token })).status).toBe(204);
    expect((await env.ASSETS!.list({ prefix: `sites/${sid}/` })).objects).toEqual([]);
    expect(await env.CONFIG_KV.get(kvKeys.settings(sid))).toBeNull();
    expect(await env.CONFIG_KV.get(kvKeys.active(sid))).toBeNull();
  });
});

describe("publish orders experiments by priority (決定 51、設計書 §3.2・§9.3)", () => {
  it("compiles singles first (oldest created) and tests newest-started first", async () => {
    const { token, workspaceId } = await setupOwner();
    const { id: sid } = await createSite(token, workspaceId);
    const mk = async (id: string, kind: "test" | "single") => {
      expect((await call("POST", `/sites/${sid}/experiments`, { token, body: { id, name: id, kind, urlMatch: { op: "contains", value: "/" } } })).status).toBe(201);
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
      await call("POST", `/sites/${sid}/experiments`, { token, body: { id, name: id, urlMatch: { op: "contains", value: "/" } } });
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
      await call("POST", `/sites/${sid}/experiments`, { token, body: { id, name: id.toUpperCase(), urlMatch: { op: "contains", value: "/" } } });
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
    await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "t3", name: "T3", urlMatch: { op: "contains", value: "/" } } });
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
