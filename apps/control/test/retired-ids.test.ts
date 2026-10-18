import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "../src/db";
import { call, createExperiment, createSite, expectEnvelope, json, setupOwner, TEXT_CHANGE } from "./helpers";

// D9 ②(設計書 §6.3、plan ② の K16・Task 11): 一度開始したエクスペリエンスの ID は、削除した後も同じ Site で使い直せない
const RETIRED_HINT = "この ID は以前に開始したエクスペリエンスで使われていました。別の ID を指定してください";

async function site() {
  const owner = await setupOwner();
  const { id: sid } = await createSite(owner.token, owner.workspaceId);
  return { token: owner.token, workspaceId: owner.workspaceId, sid };
}

/** 作成 → 開始 → 終了 → 削除(開始で自動公開する) */
async function startArchiveDelete(token: string, sid: string, id: string) {
  await createExperiment(token, sid, { id });
  await call("PUT", `/sites/${sid}/experiments/${id}/variants/b/changes`, { token, body: [TEXT_CHANGE()] });
  for (const status of ["running", "archived"]) expect((await call("POST", `/sites/${sid}/experiments/${id}/status`, { token, body: { status } })).status).toBe(200);
  expect((await call("DELETE", `/sites/${sid}/experiments/${id}`, { token })).status).toBe(204);
}

const retiredRows = (sid: string) => getDb(env).selectFrom("retired_experiment_ids").select("experiment_id").where("site_id", "=", sid).execute();

describe("一度開始した ID の使い直しの禁止(D9 ②)", () => {
  it("deleted_started_experiment_id_cannot_be_reused", async () => {
    const { token, workspaceId, sid } = await site();
    await startArchiveDelete(token, sid, "exp_old");
    expect(await retiredRows(sid)).toEqual([{ experiment_id: "exp_old" }]);
    expect(await getDb(env).selectFrom("experiments").select("id").where("site_id", "=", sid).where("id", "=", "exp_old").executeTakeFirst()).toBeUndefined();
    const res = await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_old", name: "Hero", urlMatch: { op: "contains", value: "/" } } });
    expect(res.status).toBe(409);
    const body = await expectEnvelope(res);
    expect(body).toMatchObject({ error: "id_taken", id: "exp_old", hint: RETIRED_HINT });
    // 別の Site では使える(退役は Site ごと)
    const { id: other } = await createSite(token, workspaceId);
    expect((await call("POST", `/sites/${other}/experiments`, { token, body: { id: "exp_old", name: "Hero", urlMatch: { op: "contains", value: "/" } } })).status).toBe(201);
  });

  it("deleted_draft_experiment_id_can_be_reused", async () => {
    const { token, sid } = await site();
    await createExperiment(token, sid, { id: "exp_draft" });
    expect((await call("DELETE", `/sites/${sid}/experiments/exp_draft`, { token })).status).toBe(204);
    expect(await retiredRows(sid)).toEqual([]);
    const res = await call("POST", `/sites/${sid}/experiments`, { token, body: { id: "exp_draft", name: "Hero", urlMatch: { op: "contains", value: "/" } } });
    expect(res.status).toBe(201);
  });

  it("duplicate_with_retired_id_is_rejected", async () => {
    const { token, sid } = await site();
    await startArchiveDelete(token, sid, "exp_old");
    await createExperiment(token, sid, { id: "exp_src" });
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same", id: "exp_old" } });
    expect(res.status).toBe(409);
    expect(await expectEnvelope(res)).toMatchObject({ error: "id_taken", id: "exp_old", hint: RETIRED_HINT });
    expect(await getDb(env).selectFrom("experiments").select("id").where("site_id", "=", sid).where("id", "=", "exp_old").executeTakeFirst()).toBeUndefined();
  });

  it("auto duplicate id skips retired ids", async () => {
    const { token, sid } = await site();
    await createExperiment(token, sid, { id: "exp_src" });
    await startArchiveDelete(token, sid, "exp_src-copy");
    const res = await call("POST", `/sites/${sid}/experiments/exp_src/duplicate`, { token, body: { mode: "same" } });
    expect(res.status).toBe(201);
    expect((await json(res)).id).toBe("exp_src-copy-2");
  });
});
