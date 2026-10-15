import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { RUNTIME_SOURCE } from "@wtt/runtime/source";
import { call, createExperiment, createSite, expectEnvelope, inviteAndJoin, json, setupOwner } from "./helpers";
import { getDb } from "../src/db";

/** KV の全キーと値のスナップショット(draft-bootstrap が 1 バイトも書かないことの証明に使う) */
async function kvSnapshot(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const list = await env.CONFIG_KV.list();
  for (const k of list.keys) out[k.name] = await env.CONFIG_KV.get(k.name);
  return out;
}
const publishCount = async (sid: string): Promise<number> =>
  Number((await getDb(env).selectFrom("publishes").select(({ fn }) => fn.countAll().as("n")).where("site_id", "=", sid).executeTakeFirstOrThrow()).n);

/** draft のまま(Publish していない)Change を 1 件持つ Experiment と、別に公開済みの Experiment を持つ Site */
async function siteWithDraft() {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  const { id: live } = await createExperiment(owner.token, sid, { id: "exp_live", urlMatch: { op: "contains", value: "/" } });
  await call("PUT", `/sites/${sid}/experiments/${live}/variants/b/changes`, {
    token: owner.token,
    body: [{ id: "c_live", type: "TEXT", selector: ".live", payload: { text: "公開済み" } }],
  });
  expect((await call("POST", `/sites/${sid}/experiments/${live}/status`, { token: owner.token, body: { status: "running" } })).status).toBe(200);
  const { id: draft } = await createExperiment(owner.token, sid, { id: "exp_draft", urlMatch: { op: "contains", value: "/lp/" } });
  await call("PUT", `/sites/${sid}/experiments/${draft}/variants/b/changes`, {
    token: owner.token,
    body: [{ id: "c_draft", type: "TEXT", selector: ".draft-title", payload: { text: "下書きの文言" } }],
  });
  return { owner, sid, draft };
}

describe("GET /sites/:sid/experiments/:eid/draft-bootstrap (spec §13.10)", () => {
  it("draft_bootstrap_never_touches_kv_or_edge_cache", async () => {
    const { owner, sid, draft } = await siteWithDraft();
    const before = await kvSnapshot();
    const publishesBefore = await publishCount(sid);

    const res = await call("GET", `/sites/${sid}/experiments/${draft}/draft-bootstrap`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-store"); // edge / ブラウザのキャッシュに載せない
    const body = await res.text();
    expect(body).toContain("self.__WTT_BOOT__=");
    expect(body.endsWith(RUNTIME_SOURCE)).toBe(true); // edge と同じ runtime を配る(決定 39 (3))
    expect(body).toContain("/*! wtt-preview */"); // indexOf が -1(埋め込まれていない)でも下の比較が通ってしまうのを防ぐ
    expect(body.indexOf("/*! wtt-preview */")).toBeLessThan(body.indexOf("self.__WTT_BOOT__=")); // 下書きはプレビューを埋め込む(edge を経由しない。決定 50)

    // KV も publishes も 1 バイトも変わらない
    expect(await kvSnapshot()).toEqual(before);
    expect(await publishCount(sid)).toBe(publishesBefore);
  });

  it("draft_bootstrap_reflects_unpublished_changes", async () => {
    const { owner, sid, draft } = await siteWithDraft();
    const body = await (await call("GET", `/sites/${sid}/experiments/${draft}/draft-bootstrap`, { token: owner.token })).text();
    // 切り出しは edge の bootstrap.test.ts と同じ形にする(runtime 本文に ";\n" が現れても壊れない)
    const boot = JSON.parse(body.split("self.__WTT_BOOT__=")[1]!.split(";\n")[0]!);
    // 当該 Experiment だけが入り、status が draft でも running として compile されている
    expect(boot.config.experiments.map((e: { id: string }) => e.id)).toEqual(["exp_draft"]);
    expect(JSON.stringify(boot.config)).toContain("下書きの文言");
    expect(JSON.stringify(boot.config)).not.toContain("公開済み");
    expect(boot.config.prehide.exp_draft).toEqual([".draft-title"]);
    expect(boot.settings.visitorCookieName).toBe("_ab_vid"); // §5.4 の runtime 向けサブセット

    // 配信中の config には下書きは入っていない(Publish していないので当然)
    const site = await json<{ activeVersion: number }>(await call("GET", `/sites/${sid}`, { token: owner.token }));
    const active = await json<{ config: { experiments: Array<{ id: string }> } }>(
      await call("GET", `/sites/${sid}/publishes/${site.activeVersion}`, { token: owner.token }),
    );
    expect(active.config.experiments.map((e) => e.id)).toEqual(["exp_live"]);
  });

  it("VIEWER で読め、未知の Experiment は 404 封筒、weight の合計 100 は保存時に弾かれる", async () => {
    const { owner, sid, draft } = await siteWithDraft();
    const viewer = await inviteAndJoin(owner.token, owner.workspaceId, "viewer");
    expect((await call("GET", `/sites/${sid}/experiments/${draft}/draft-bootstrap`, { token: viewer.token })).status).toBe(200);
    const missing = await call("GET", `/sites/${sid}/experiments/exp_nope/draft-bootstrap`, { token: owner.token });
    expect(missing.status).toBe(404);
    expect(await expectEnvelope(missing)).toMatchObject({ error: "not_found" });

    // weight の合計を崩す(50/40)と `PUT …/variants` が 422 で弾く(routes/experiments.ts の保存時検証)。
    // 壊れた下書きが D1 に残らないので、draft-bootstrap の invalid_draft は次の it で作って確かめる
    const put = await call("PUT", `/sites/${sid}/experiments/${draft}/variants`, {
      token: owner.token,
      body: [
        { id: "a", name: "A", weight: 50 },
        { id: "b", name: "B", weight: 40 },
      ],
    });
    expect(put.status).toBe(422);
    expect(await expectEnvelope(put)).toMatchObject({ error: "variant_weights_invalid" });
  });

  it("invalid_draft: compile できない下書きは配らずに 422 封筒を返す", async () => {
    const { owner, sid, draft } = await siteWithDraft();
    // API 経由では作れない状態(weight 合計 90)を D1 に直接作る
    await sql`update variants set weight = 40 where site_id = ${sid} and experiment_id = ${draft} and id = 'b'`.execute(getDb(env));
    const broken = await call("GET", `/sites/${sid}/experiments/${draft}/draft-bootstrap`, { token: owner.token });
    expect(broken.status).toBe(422);
    const envelope = await expectEnvelope(broken);
    expect(envelope).toMatchObject({ error: "invalid_draft" });
    expect(String(envelope.hint)).toContain("weight"); // 次に直すべきことが hint に出る(§13.5)
  });
});
