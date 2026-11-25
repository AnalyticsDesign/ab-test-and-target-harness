import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { kvKeys, parseCompiledConfig } from "@wtt/core";
import { active, beforeD1BatchMatching, call, createExperiment, json, publishRes, runDirect, siteWithRunning, TEXT_CHANGE } from "./helpers";

async function publishWithRace(token: string, sid: string, race: () => Promise<unknown>) {
  const hook = beforeD1BatchMatching(env.DB, /update "sites" set "active_version"/i, race);
  const res = await publishRes(token, sid, { DB: hook.db });
  expect(hook.ran()).toBe(true);
  expect(res.status).toBe(200);
  return json(res);
}

async function activeConfig(sid: string) {
  const raw = await env.CONFIG_KV.get(kvKeys.config(sid, Number(await active(sid))));
  const config = raw && parseCompiledConfig(JSON.parse(raw));
  if (!config) throw new Error("配信中の設定が読めません");
  return config;
}

async function expectPublishedStatuses(sid: string) {
  const count = await env.DB.prepare("select count(*) as n from experiments where site_id = ? and published_status is not status").bind(sid).first("n");
  expect(count).toBe(0);
}

it("snapshot_matches_null_last_started_at", async () => {
  const { sid, owner } = await siteWithRunning();
  for (let i = 0; i < 5; i++) await createExperiment(owner.token, sid);
  expect(await json(await publishRes(owner.token, sid))).toMatchObject({ ok: true });
  await expectPublishedStatuses(sid);
});

it.each([
  ["add", "draft", true], ["add", "running", false],
  ["delete", "draft", true], ["delete", "archived", true], ["delete", "paused", false], ["delete", "running", false],
] as const)("snapshot_rules_for_created_and_deleted_rows %s %s", async (action, status, ok) => {
  const { sid, owner } = await siteWithRunning();
  const insert = async () => {
    await createExperiment(owner.token, sid, { id: "extra" });
    if (status !== "draft") await runDirect(sid, "extra", status);
  };
  if (action === "delete") await insert();
  const result = await publishWithRace(owner.token, sid, async () => {
    if (action === "add") await insert();
    else await env.DB.prepare("delete from experiments where site_id = ? and id = 'extra'").bind(sid).run();
  });
  expect(result).toMatchObject(ok ? { ok } : { ok, error: "state_changed" });
});

it("counterexample_edit_and_publish_after_read", async () => {
  const { sid, owner, eid } = await siteWithRunning();
  await createExperiment(owner.token, sid);
  const result = await publishWithRace(owner.token, sid, async () => {
    const changed = { ...TEXT_CHANGE(), payload: { text: "B edited" } };
    expect((await call("PUT", `/sites/${sid}/experiments/${eid}/variants/b/changes`, { token: owner.token, body: [changed] })).status).toBe(200);
    expect(await json(await publishRes(owner.token, sid))).toMatchObject({ ok: true, version: 2 });
  });
  expect(result).toMatchObject({ ok: true, superseded: true });
  const config = await activeConfig(sid);
  expect(config.experiments.map(e => e.id)).toEqual([eid]);
  expect(JSON.stringify(config.experiments)).toContain("B edited");
  await expectPublishedStatuses(sid);
});

it("counterexample_pause_resume_after_read", async () => {
  const { sid, owner, eid } = await siteWithRunning();
  await createExperiment(owner.token, sid);
  await createExperiment(owner.token, sid, { id: "second" });
  await call("PUT", `/sites/${sid}/experiments/second/variants/b/changes`, { token: owner.token, body: [TEXT_CHANGE()] });
  await env.DB.prepare("update experiments set status = 'running', last_started_at = case id when 'second' then 2 else 1 end where site_id = ? and id in (?, 'second')").bind(sid, eid).run();
  expect(await json(await publishRes(owner.token, sid))).toMatchObject({ ok: true });
  expect((await activeConfig(sid)).experiments.map(e => e.id)).toEqual(["second", eid]);
  const result = await publishWithRace(owner.token, sid, async () => {
    for (const status of ["paused", "running"]) {
      const res = await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token: owner.token, body: { status } });
      expect(await json(res)).toMatchObject({ publish: { ok: true } });
    }
  });
  expect(result).toMatchObject({ ok: false, version: 2, error: "state_changed" });
  expect(await env.DB.prepare("select status, error from publishes where site_id = ? and version = 2").bind(sid).first()).toMatchObject({
    status: "failed", error: expect.stringMatching(/^state_changed:/),
  });
  expect((await activeConfig(sid)).experiments.map(e => e.id)).toEqual([eid, "second"]);
  await expectPublishedStatuses(sid);
});

it("manual_publish_state_changed_response", async () => {
  const { sid, owner, eid } = await siteWithRunning();
  expect(await publishWithRace(owner.token, sid, () => runDirect(sid, eid, "paused"))).toEqual({
    ok: false, version: 1, error: "state_changed", message: "公開の準備の間に、エクスペリエンスの状態が変わりました", hint: "もう一度公開してください",
  });
});
