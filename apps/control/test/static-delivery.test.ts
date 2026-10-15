import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { kvKeys, SITE_REMOVED_SEQ } from "@wtt/core";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { publishSite, type PublishResult } from "../src/publish";
import { bootstrapSettingsChanged, reconcileStatic, requestStaticDeploy } from "../src/static-delivery";
import { call, fakeDeployer, inviteAndJoin, json, setupOwner, statusOf, testEnv } from "./helpers";

/** Site を作って 1 回 Publish する(DEPLOYER は無し = skipped)。戻り値は D1 の行 */
async function publishedSite() {
  const { token, workspaceId, userId } = await setupOwner();
  const site = await json(await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { name: "S", domain: "www.example.com" } }));
  const pub = await json(await call("POST", `/sites/${site.id}/publish`, { token }));
  expect(pub.ok).toBe(true);
  const db = getDb(env as unknown as Env);
  return { token, workspaceId, userId, siteId: site.id as string, db, row: async () => db.selectFrom("sites").selectAll().where("id", "=", site.id).executeTakeFirstOrThrow() };
}

describe("static delivery (決定 52)", () => {
  it("requestStaticDeploy は世代を進めた行から入力を作り、出し直しが済めば stale を下ろす", async () => {
    const s = await publishedSite();
    const fake = fakeDeployer();
    const before = await s.row();
    const out = await requestStaticDeploy({ ...testEnv, DEPLOYER: fake, AB_EDGE_ORIGIN: "https://www.example.com/" }, s.db, s.siteId);
    expect(out.state).toBe("deployed");
    const after = await s.row();
    expect(after.static_seq).toBe(before.static_seq + 1);
    expect(after.static_stale).toBe(0);
    expect(after.static_served_version).toBe(after.active_version); // 配っている版を記録する(K20)
    expect(out.generation).toEqual({ epoch: after.created_at, seq: after.static_seq });
    const sent = fake.deploys[0]!;
    expect(sent).toMatchObject({ protocol: 1, siteId: s.siteId, generation: { epoch: after.created_at, seq: after.static_seq }, apiBase: "https://www.example.com" });
    expect((sent.config as { version: number }).version).toBe(after.active_version);
    expect((sent.settings as { siteId: string }).siteId).toBe(s.siteId);
  });

  it("static_redeploy_failure_keeps_publish_ok_and_marks_stale", async () => {
    const s = await publishedSite();
    for (const mode of ["pending", "throw", "hang"] as const) {
      const res = await json(await call("POST", `/sites/${s.siteId}/publish`, { token: s.token, envOverride: { DEPLOYER: fakeDeployer(mode) } }));
      expect(res).toMatchObject({ ok: true, staticDeploy: "pending" });
      expect(res.purge).toBeUndefined();
      expect(res.staticGeneration).toBeUndefined(); // 内部用の値は応答に出さない
      expect((await s.row()).static_stale).toBe(1);
    }
  }, 60_000);

  it("static_stale_is_set_with_activation", async () => {
    const s = await publishedSite();
    await requestStaticDeploy({ ...testEnv, DEPLOYER: fakeDeployer() }, s.db, s.siteId); // 印を下ろしておく
    expect((await s.row()).static_stale).toBe(0);
    // 出し直しの依頼が throw しても、印は activation の UPDATE で立っている
    const res = await json(await call("POST", `/sites/${s.siteId}/publish`, { token: s.token, envOverride: { DEPLOYER: fakeDeployer("throw") } }));
    expect(res).toMatchObject({ ok: true, staticDeploy: "pending" });
    expect((await s.row()).static_stale).toBe(1);
    // 世代を進める D1 の UPDATE が失敗しても例外を投げない(Publish を失敗にしない)
    const brokenDb = new Proxy(s.db, {
      get: (t, p) => {
        if (p === "updateTable") return () => { throw new Error("D1 down"); };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    expect((await requestStaticDeploy({ ...testEnv, DEPLOYER: fakeDeployer() }, brokenDb, s.siteId)).state).toBe("pending");
  });

  it("DEPLOYER が無い(ローカル・設定漏れ)なら skipped で、stale の印を立てたまま", async () => {
    const s = await publishedSite();
    const res = await json(await call("POST", `/sites/${s.siteId}/publish`, { token: s.token }));
    expect(res).toMatchObject({ ok: true, staticDeploy: "skipped" });
    expect((await s.row()).static_stale).toBe(1);
  });

  it("公開中の版が無い Site の出し直しは削除の依頼になる", async () => {
    const { token, workspaceId } = await setupOwner();
    const site = await json(await call("POST", `/workspaces/${workspaceId}/sites`, { token, body: { name: "S", domain: "www.example.com" } }));
    const fake = fakeDeployer();
    await requestStaticDeploy({ ...testEnv, DEPLOYER: fake }, getDb(env as unknown as Env), site.id);
    expect(fake.deploys).toHaveLength(0);
    expect(fake.removes[0]).toMatchObject({ siteId: site.id, generation: { seq: 1 } });
  });

  it("identity_settings_save_redeploys_static", async () => {
    const s = await publishedSite();
    const fake = fakeDeployer();
    await call("PATCH", `/sites/${s.siteId}`, { token: s.token, body: { visitorCookieName: "_ab_vid2" }, envOverride: { DEPLOYER: fake } });
    expect(fake.deploys).toHaveLength(1);
    expect((fake.deploys[0]!.settings as { visitorCookieName: string }).visitorCookieName).toBe("_ab_vid2");
    // bootstrap に焼かない値(名前)だけの変更では出し直さない
    await call("PATCH", `/sites/${s.siteId}`, { token: s.token, body: { name: "S2" }, envOverride: { DEPLOYER: fake } });
    expect(fake.deploys).toHaveLength(1);
  });

  it("site_delete_removes_static_file", async () => {
    const s = await publishedSite();
    const fake = fakeDeployer();
    const created = (await s.row()).created_at;
    expect((await call("DELETE", `/sites/${s.siteId}`, { token: s.token, envOverride: { DEPLOYER: fake } })).status).toBe(204);
    expect(fake.removes[0]).toEqual({ protocol: 1, siteId: s.siteId, generation: { epoch: created, seq: SITE_REMOVED_SEQ } });
  });

  it("配信ファイルを消せない(RPC が落ちる)ときは Site を消さずに 503", async () => {
    const s = await publishedSite();
    const res = await call("DELETE", `/sites/${s.siteId}`, { token: s.token, envOverride: { DEPLOYER: fakeDeployer("throw") } });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("static_remove_failed");
    expect(await s.row()).toBeTruthy();
  });

  it("site_delete_keeps_site_when_static_removal_times_out", async () => {
    // 待ち切れない = デプロイ専用の Worker が墓標を受け付けたか分からない。削除へ進まない(STATIC_WAIT_MS の 8 秒を待つので、テストのタイムアウトを延ばす)
    const s = await publishedSite();
    const res = await call("DELETE", `/sites/${s.siteId}`, { token: s.token, envOverride: { DEPLOYER: fakeDeployer("hang") } });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("static_remove_failed");
    expect(await s.row()).toBeTruthy();
  }, 30_000);

  it("workspace_delete_removes_static_files", async () => {
    const s = await publishedSite(); // setupOwner の人はシステム管理者(ワークスペースを削除できる)
    await call("POST", "/workspaces", { token: s.token, body: { name: "Keeper" } }); // 最後の 1 つは消せないので、もう 1 つ作っておく
    const fake = fakeDeployer();
    const created = (await s.row()).created_at;
    expect((await call("DELETE", `/workspaces/${s.workspaceId}`, { token: s.token, envOverride: { DEPLOYER: fake } })).status).toBe(204);
    expect(fake.removes).toEqual([{ protocol: 1, siteId: s.siteId, generation: { epoch: created, seq: SITE_REMOVED_SEQ } }]);
  });

  it("ワークスペースの削除: 配信ファイルを消せないときは 503 で残し、最後の 1 つは配信ファイルを消す前に 409", async () => {
    const s = await publishedSite(); // ワークスペースはこの 1 つだけ(テストごとに D1 が分かれる。access.test.ts の last_workspace のテストと同じ前提)
    const fake = fakeDeployer();
    const last = await call("DELETE", `/workspaces/${s.workspaceId}`, { token: s.token, envOverride: { DEPLOYER: fake } });
    expect(last.status).toBe(409);
    expect((await json(last)).error).toBe("last_workspace");
    expect(fake.removes).toHaveLength(0); // 断る前に配信ファイルを消していない(消すと墓標で戻らない)
    await call("POST", "/workspaces", { token: s.token, body: { name: "Keeper" } });
    const res = await call("DELETE", `/workspaces/${s.workspaceId}`, { token: s.token, envOverride: { DEPLOYER: fakeDeployer("throw") } });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("static_remove_failed");
    expect(await s.row()).toBeTruthy(); // Site もワークスペースも残る
  });

  it("workspace_delete_keeps_workspace_when_static_removal_times_out", async () => {
    const s = await publishedSite();
    await call("POST", "/workspaces", { token: s.token, body: { name: "Keeper" } });
    const res = await call("DELETE", `/workspaces/${s.workspaceId}`, { token: s.token, envOverride: { DEPLOYER: fakeDeployer("hang") } });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("static_remove_failed");
    expect(await s.row()).toBeTruthy(); // Site もワークスペースも残る
  }, 30_000);

  it("publish_does_not_report_deployed_over_tombstone", async () => {
    // 削除が途中で止まり、デプロイ専用の Worker には墓標だけが残っている。Publish は「配信済み」にせず、自動では戻さない(plan K2・K23)
    const s = await publishedSite();
    const row = await s.row();
    const fake = fakeDeployer();
    fake.setTombstone(row.created_at);
    const res = await json(await call("POST", `/sites/${s.siteId}/publish`, { token: s.token, envOverride: { DEPLOYER: fake } }));
    expect(res).toMatchObject({ ok: true, staticDeploy: "pending" });
    expect(fake.deploys).toHaveLength(1); // epoch を進めて出し直さない
    const after = await s.row();
    expect(after.static_epoch).toBe(row.static_epoch); // epoch は変わらない
    expect(after.static_stale).toBe(1); // 印は立ったまま
  });

  it("get_site_keeps_stale_over_tombstone", async () => {
    const s = await publishedSite(); // DEPLOYER 無しの Publish なので stale
    const row = await s.row();
    await s.db.updateTable("sites").set({ static_removing: "token-of-stopped-delete" }).where("id", "=", s.siteId).execute(); // 削除が途中で止まった
    const fake = fakeDeployer();
    fake.setStatus(statusOf({ epoch: row.created_at, seq: SITE_REMOVED_SEQ })); // 墓標が配られている
    const got = await json(await call("GET", `/sites/${s.siteId}`, { token: s.token, envOverride: { DEPLOYER: fake } }));
    expect(got.staticStale).toBe(true);
    expect(got.staticRemoving).toBe(true); // 画面が「削除が途中で止まっています」を出す
    expect((await s.row()).static_epoch).toBe(row.static_epoch); // GET は epoch を進めない
    expect(fake.deploys).toHaveLength(0); // 依頼もしない
  });

  it("static_redeploy_recovers_from_tombstone_and_cancels_delete", async () => {
    const s = await publishedSite();
    const row = await s.row();
    const oldToken = "token-of-stopped-delete";
    await s.db.updateTable("sites").set({ static_removing: oldToken, static_stale: 1 }).where("id", "=", s.siteId).execute(); // 印の立った Site
    const fake = fakeDeployer();
    fake.setTombstone(row.created_at);
    const res = await call("POST", `/sites/${s.siteId}/static/redeploy`, { token: s.token, envOverride: { DEPLOYER: fake } });
    expect(await json(res)).toEqual({ staticDeploy: "deployed" });
    // 1 回目の結果(墓標)では「配信済み」にせず、印を消した後に epoch を墓標 + 1 に進めて 1 回だけ出し直す
    expect(fake.deploys).toHaveLength(2);
    expect(fake.deploys[1]!.generation.epoch).toBe(row.created_at + 1);
    const after = await s.row();
    expect(after.static_removing).toBeNull();
    expect(after.static_epoch).toBe(row.created_at + 1);
    expect(after.static_stale).toBe(0);
    // その後に古い token で D1 の削除の文を走らせても、印が違うので行は残る
    await sql`delete from sites where id = ${s.siteId} and static_removing = ${oldToken}`.execute(s.db);
    expect(await s.row()).toBeTruthy();
  });

  it("static_redeploy_recovers_from_accepted_only_tombstone", async () => {
    // 墓標は受け付けられたが CF API の失敗で配り終えていない(accepted = 墓標 / deployed = 前の通常の世代)。
    // ここで「作り直す」を押しても、墓標の方が新しいので依頼は捨てられる。epoch を墓標 + 1 に進めて出し直さないと、後の alarm でファイルが消える
    const s = await publishedSite();
    const row = await s.row();
    await s.db.updateTable("sites").set({ static_removing: "token-of-stopped-delete", static_stale: 1 }).where("id", "=", s.siteId).execute();
    const fake = fakeDeployer();
    fake.setTombstone(row.created_at, { epoch: row.created_at, seq: 1 });
    const res = await call("POST", `/sites/${s.siteId}/static/redeploy`, { token: s.token, envOverride: { DEPLOYER: fake } });
    expect(await json(res)).toEqual({ staticDeploy: "deployed" });
    expect(fake.deploys).toHaveLength(2);
    expect(fake.deploys[1]!.generation.epoch).toBe(row.created_at + 1);
    const after = await s.row();
    expect(after.static_removing).toBeNull();
    expect(after.static_epoch).toBe(row.created_at + 1);
    expect(after.static_stale).toBe(0);
  });

  it("static_redeploy_does_not_recover_while_new_delete_started", async () => {
    // 作り直しが印を消した後(ルートの最初の UPDATE の後)に、新しい削除が始まって印を立てた状態。
    // 作り直しの続き(recoverTombstone の出し直し)を直接呼ぶ
    const s = await publishedSite();
    const row = await s.row();
    await s.db.updateTable("sites").set({ static_removing: "token-of-new-delete", static_stale: 1 }).where("id", "=", s.siteId).execute();
    const fake = fakeDeployer();
    fake.setTombstone(row.created_at); // 新しい削除の墓標が受け付けられている
    const out = await requestStaticDeploy({ ...testEnv, DEPLOYER: fake }, s.db, s.siteId, { force: true, recoverTombstone: true });
    expect(out.state).toBe("pending"); // 配信を戻さない
    expect(fake.deploys).toHaveLength(1); // 墓標の結果の後に出し直しの依頼を出さない
    const after = await s.row();
    expect(after.static_epoch).toBe(row.static_epoch); // epoch は進まない
    expect(after.static_removing).toBe("token-of-new-delete"); // 新しい削除の印はそのまま(その削除が D1 の行を消せる)
  });

  it("site_delete_aborts_when_newer_deploy_overtook_tombstone", async () => {
    // 墓標を送ったが、より新しい通常の世代(作り直し)が受け付けられていた。墓標を削除の成功と取り違えない(plan K23)
    const s = await publishedSite();
    const fake = fakeDeployer();
    fake.onRemove(async (req) => {
      const newer = { epoch: req.generation.epoch + 1, seq: 1 };
      return { state: "deployed", accepted: newer, deployed: newer, deployedAt: new Date().toISOString() };
    });
    const res = await call("DELETE", `/sites/${s.siteId}`, { token: s.token, envOverride: { DEPLOYER: fake } });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe("static_remove_failed");
    expect(await s.row()).toBeTruthy();
    // 墓標は受け付けられていない(何も消していない)ので、自分の印を消してから断る(「削除が途中で止まっています」を出さない)
    expect((await s.row()).static_removing).toBeNull();
  });

  it("site_delete_conflicts_when_redeployed_during_delete", async () => {
    // 墓標の応答の後・D1 の削除の前に、「配信ファイルを作り直す」が削除の印を消した。削除を取りやめる
    const s = await publishedSite();
    const fake = fakeDeployer();
    fake.onRemove(async () => {
      await s.db.updateTable("sites").set({ static_removing: null }).where("id", "=", s.siteId).execute();
    });
    const res = await call("DELETE", `/sites/${s.siteId}`, { token: s.token, envOverride: { DEPLOYER: fake } });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("static_remove_conflict");
    expect(await s.row()).toBeTruthy();
    expect(await env.CONFIG_KV.get(kvKeys.settings(s.siteId))).not.toBeNull(); // KV の設定も消えていない
  });

  it("workspace_delete_conflicts_when_site_redeployed_during_delete", async () => {
    const s = await publishedSite();
    await call("POST", "/workspaces", { token: s.token, body: { name: "Keeper" } }); // 最後の 1 つではない
    const fake = fakeDeployer();
    fake.onRemove(async () => {
      await s.db.updateTable("sites").set({ static_removing: null }).where("id", "=", s.siteId).execute();
    });
    const res = await call("DELETE", `/workspaces/${s.workspaceId}`, { token: s.token, envOverride: { DEPLOYER: fake } });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe("static_remove_conflict");
    expect(await s.db.selectFrom("organization").select("id").where("id", "=", s.workspaceId).executeTakeFirst()).toBeTruthy(); // ワークスペースが残る
    expect(await s.row()).toBeTruthy();
    expect(await env.CONFIG_KV.get(kvKeys.settings(s.siteId))).not.toBeNull(); // KV の設定も消えていない
  });

  it("stale_flag_not_cleared_by_result_of_previous_epoch", async () => {
    const s = await publishedSite(); // stale
    const old = await s.row();
    // 読んだ後に、別の処理が epoch を進めた(墓標からの復旧と同じ形)。seq は同じ
    await s.db.updateTable("sites").set({ static_epoch: old.created_at + 1 }).where("id", "=", s.siteId).execute();
    const fake = fakeDeployer();
    fake.setStatus(statusOf({ epoch: old.created_at, seq: old.static_seq })); // 前の epoch の世代が配られている
    expect(await reconcileStatic({ ...testEnv, DEPLOYER: fake }, s.db, old, () => {})).toBe(true);
    expect((await s.row()).static_stale).toBe(1); // 前の epoch の結果では下ろさない
  });

  it("cleanup_keeps_version_served_by_stale_static_file", async () => {
    const s = await publishedSite();
    await requestStaticDeploy({ ...testEnv, DEPLOYER: fakeDeployer() }, s.db, s.siteId); // 今の版を配った
    const served = (await s.row()).static_served_version!;
    // 以後の配信ファイルの更新は pending のまま、5 分を越えて 6 版 Publish する
    const pendingEnv = { ...testEnv, DEPLOYER: fakeDeployer("pending") };
    let t = Date.now();
    for (let i = 0; i < 6; i++) {
      t += 5 * 60_000 + 1;
      expect(await publishSite(pendingEnv, s.db, await s.row(), s.userId, t)).toMatchObject({ ok: true, staticDeploy: "pending" });
    }
    expect(await env.CONFIG_KV.get(kvKeys.config(s.siteId, served))).not.toBeNull(); // 配信ファイルが配っている版の config は残る
  });

  it("cleanup_keeps_versions_deployed_by_alarm_after_confirmed", async () => {
    const s = await publishedSite();
    await requestStaticDeploy({ ...testEnv, DEPLOYER: fakeDeployer() }, s.db, s.siteId); // 今の版を配ったことを確かめた
    const confirmed = (await s.row()).static_served_version!;
    const pendingEnv = { ...testEnv, DEPLOYER: fakeDeployer("pending") };
    let t = Date.now();
    // 次の版は pending のまま(デプロイ専用の Worker の alarm で後から成功し、配信ファイルはこの版を配っている想定。control は確かめていない)
    t += 1;
    const next = await publishSite(pendingEnv, s.db, await s.row(), s.userId, t);
    expect(next).toMatchObject({ ok: true, staticDeploy: "pending" });
    const alarmVersion = (next as { version: number }).version;
    // GET なし(自己修復で確かめない)で、さらに 6 版を 5 分を越えて Publish する
    for (let i = 0; i < 6; i++) {
      t += 5 * 60_000 + 1;
      expect(await publishSite(pendingEnv, s.db, await s.row(), s.userId, t)).toMatchObject({ ok: true, staticDeploy: "pending" });
    }
    expect((await s.row()).static_served_version).toBe(confirmed);
    // 確かめ済みの版以上は残す(配る版は前にしか進まない)ので、alarm で配られた版の config も残る
    expect(await env.CONFIG_KV.get(kvKeys.config(s.siteId, alarmVersion))).not.toBeNull();
  });

  it("cleanup_keeps_previous_served_version_right_after_switch", async () => {
    const s = await publishedSite();
    await requestStaticDeploy({ ...testEnv, DEPLOYER: fakeDeployer() }, s.db, s.siteId); // 最初の版を配った
    const first = (await s.row()).static_served_version!;
    const pendingEnv = { ...testEnv, DEPLOYER: fakeDeployer("pending") };
    const deployEnv = { ...testEnv, DEPLOYER: fakeDeployer() };
    let t = Date.now();
    // 最初の版を長く配る(配信ファイルの更新は pending のまま 5 版、5 分を越えて Publish する)
    for (let i = 0; i < 5; i++) {
      t += 5 * 60_000 + 1;
      await publishSite(pendingEnv, s.db, await s.row(), s.userId, t);
    }
    // 次の Publish で配信ファイルが新しい版に切り替わる
    t += 5 * 60_000 + 1;
    expect(await publishSite(deployEnv, s.db, await s.row(), s.userId, t)).toMatchObject({ ok: true, staticDeploy: "deployed" });
    expect((await s.row()).static_prev_served_version).toBe(first);
    // settle は実時刻で static_served_at を書くので、テストの時刻 t に合わせる
    await s.db.updateTable("sites").set({ static_served_at: t }).where("id", "=", s.siteId).execute();
    // 切り替えの直後の掃除: 前に配っていた版は残る(ブラウザに残る前の bootstrap が decision でその版を求める)
    t += 1;
    await publishSite(pendingEnv, s.db, await s.row(), s.userId, t);
    expect(await env.CONFIG_KV.get(kvKeys.config(s.siteId, first))).not.toBeNull();
    // 切り替えから 5 分の後の掃除で消える
    t += 5 * 60_000 + 1;
    await publishSite(pendingEnv, s.db, await s.row(), s.userId, t);
    expect(await env.CONFIG_KV.get(kvKeys.config(s.siteId, first))).toBeNull();
  });

  it("publish_returns_generation_only_for_its_own_version", async () => {
    // 先の Publish の activation の後・末尾の出し直しの前に、後の Publish が activation する。
    // 差し込む場所 = 古い版の掃除が KV の active を読むところ(activation の後で、末尾の出し直しの前に 1 回だけ通る)
    const s = await publishedSite();
    const fake = fakeDeployer();
    const plainEnv = { ...testEnv, DEPLOYER: fake };
    const hook: { fired: boolean; later?: PublishResult } = { fired: false };
    const kv = testEnv.CONFIG_KV;
    const hookedKv = new Proxy(kv, {
      get: (t, p) => {
        if (p === "get") {
          return async (key: string, ...rest: unknown[]) => {
            if (!hook.fired && key === kvKeys.active(s.siteId)) {
              hook.fired = true;
              hook.later = await publishSite(plainEnv, s.db, await s.row(), s.userId, Date.now()); // 後の Publish を最後まで走らせる
            }
            return (t.get as (...a: unknown[]) => unknown).call(t, key, ...rest);
          };
        }
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const earlier = await publishSite({ ...plainEnv, CONFIG_KV: hookedKv }, s.db, await s.row(), s.userId, Date.now());
    const later = hook.later!;
    if (!earlier.ok || !later.ok) throw new Error("publish failed");
    expect(later.version).toBeGreaterThan(earlier.version);
    // 後の Publish は自分の版を焼いた自分の世代を返す
    expect(fake.deploys[0]!.generation).toEqual(later.staticGeneration);
    expect((fake.deploys[0]!.config as { version: number }).version).toBe(later.version);
    // 先の Publish の末尾の出し直しは後の版を焼いた(最新の D1 から作る)。自分の版ではないので世代を返さない(D9 は配信済みにしない)
    expect((fake.deploys[1]!.config as { version: number }).version).toBe(later.version);
    expect(earlier.staticGeneration).toBeNull();
  });

  it("get_site_clears_static_stale_after_deployer_caught_up", async () => {
    const s = await publishedSite(); // DEPLOYER 無しの Publish なので stale
    const row = await s.row();
    const fake = fakeDeployer();
    fake.setStatus(statusOf({ epoch: row.created_at, seq: row.static_seq }));
    const got = await json(await call("GET", `/sites/${s.siteId}`, { token: s.token, envOverride: { DEPLOYER: fake } }));
    expect(got.staticStale).toBe(false);
    expect((await s.row()).static_stale).toBe(0);
  });

  it("GET の自己修復: デプロイ専用の Worker に依頼が届いていなければ依頼し直す(移行の直後)", async () => {
    const s = await publishedSite();
    const fake = fakeDeployer(); // status は accepted: null
    const got = await json(await call("GET", `/sites/${s.siteId}`, { token: s.token, envOverride: { DEPLOYER: fake } }));
    expect(got.staticStale).toBe(true); // この応答の時点ではまだ
    expect(fake.deploys).toHaveLength(1); // waitUntil で依頼した(call は waitOnExecutionContext で待つ)
    expect((await s.row()).static_stale).toBe(0);
  });

  it("GET の自己修復: 依頼は届いていて再試行中なら、依頼し直さない", async () => {
    const s = await publishedSite();
    const row = await s.row();
    const fake = fakeDeployer();
    fake.setStatus({ accepted: { epoch: row.created_at, seq: row.static_seq }, deployed: null, deployedAt: null, history: [], historyFrom: null, pending: true, lastError: "HTTP 503" });
    const got = await json(await call("GET", `/sites/${s.siteId}`, { token: s.token, envOverride: { DEPLOYER: fake } }));
    expect(got.staticStale).toBe(true);
    expect(fake.deploys).toHaveLength(0);
  });

  it("POST /sites/:sid/static/redeploy は ADMIN 以上で、結果を返す", async () => {
    const s = await publishedSite();
    const fake = fakeDeployer();
    const res = await call("POST", `/sites/${s.siteId}/static/redeploy`, { token: s.token, envOverride: { DEPLOYER: fake } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ staticDeploy: "deployed" });
    expect(fake.deploys[0]!.force).toBe(true); // 作り直しは前回と同じ中身でもデプロイさせる
  });

  it("POST /sites/:sid/static/redeploy は編集者・閲覧者には 403", async () => {
    const s = await publishedSite();
    const fake = fakeDeployer();
    for (const role of ["editor", "viewer"] as const) {
      const m = await inviteAndJoin(s.token, s.workspaceId, role);
      const res = await call("POST", `/sites/${s.siteId}/static/redeploy`, { token: m.token, envOverride: { DEPLOYER: fake } });
      expect(res.status).toBe(403);
    }
    expect(fake.deploys).toHaveLength(0);
  });

  it("bootstrapSettingsChanged は runtime 向けの設定だけを比べる", async () => {
    const s = await publishedSite();
    const a = await s.row();
    expect(bootstrapSettingsChanged(a, { ...a, name: "x" })).toBe(false);
    expect(bootstrapSettingsChanged(a, { ...a, consent_mode: a.consent_mode === "implicit" ? "required" : "implicit" })).toBe(true);
  });
});
