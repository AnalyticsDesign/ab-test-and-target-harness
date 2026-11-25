import { expect, it } from "vitest";
import type { PublishResult } from "../src/publish";
import { abortingBindings } from "./abort-harness";
import { countingD1 } from "./d1-trips";
import { call, createExperiment, createSite, fakeDeployer, json, publishRes, runDirect, setupOwner, testEnv } from "./helpers";

const PUBLISH_TRIPS_BEFORE = 32;
const TRANSITION_TRIPS_BEFORE = { start: 41, pause: 36, resume: 41, archive: 41 };
const KV_CALLS_BEFORE = { publish: 5, start: 5, pause: 5, resume: 5, archive: 5 };

async function fixture() {
  const { token, workspaceId } = await setupOwner();
  const { id: sid } = await createSite(token, workspaceId);
  const { id: draft } = await createExperiment(token, sid, { id: "exp_draft" });
  const { id: running } = await createExperiment(token, sid, { id: "exp_running" });
  const { id: other } = await createExperiment(token, sid, { id: "exp_other" });
  await runDirect(sid, running);
  await runDirect(sid, other);
  for (const id of ["goal_purchase", "goal_contact"]) {
    const res = await call("POST", `/sites/${sid}/goals`, { token, body: { id, name: id, type: "CUSTOM", config: {} } });
    expect(res.status).toBe(201);
  }
  const audience = await call("POST", `/sites/${sid}/audiences`, {
    token,
    body: { id: "aud_mobile", name: "Mobile", definition: { ctx: "device", op: "in", value: ["mobile"] } },
  });
  expect(audience.status).toBe(201);
  return { token, sid, draft, running };
}

function countBindings() {
  const { env: { CONFIG_KV }, calls: kvCalls } = abortingBindings(testEnv, null);
  const { DB, trips } = countingD1(testEnv.DB);
  // 配信ファイルを出し直した後の記録まで通常どおり流し、外部への RPC だけを置き換える。
  return { envOverride: { DB, CONFIG_KV, DEPLOYER: fakeDeployer() }, trips, kvCalls };
}

it("publish_d1_trips_after_batching", async () => {
  const { token, sid } = await fixture();
  const { envOverride, trips, kvCalls } = countBindings();
  const res = await publishRes(token, sid, envOverride);
  expect(res.status).toBe(200);
  expect(await json<PublishResult>(res)).toMatchObject({ ok: true, version: 1, superseded: false, staticDeploy: "deployed" });
  expect(trips.length, trips.join("\n")).toBe(PUBLISH_TRIPS_BEFORE - (7 + 3));
  expect(kvCalls.length, kvCalls.join("\n")).toBe(KV_CALLS_BEFORE.publish);
});

for (const [name, status] of [
  ["start", "running"],
  ["pause", "paused"],
  ["resume", "running"],
  ["archive", "archived"],
] as const) {
  it.each([false, true])(`transition_d1_trips_after_${name} (digest %s)`, async (withDigest) => {
    const { token, sid, draft, running } = await fixture();
    const eid = name === "start" ? draft : running;
    if (name === "resume") await runDirect(sid, eid, "paused");
    const body: { status: typeof status; expectDigest?: string } = { status };
    if (withDigest) {
      const preview = await call("GET", `/sites/${sid}/publish-preview?transition=${eid}:${status}`, { token });
      body.expectDigest = (await json(preview)).transitionDigest;
      expect(body.expectDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    const { envOverride, trips, kvCalls } = countBindings();
    const res = await call("POST", `/sites/${sid}/experiments/${eid}/status`, { token, body, envOverride });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      experiment: { status },
      publish: { ok: true, version: 1, superseded: false, staticDeploy: "deployed" },
    });
    expect(trips.length, trips.join("\n")).toBe(TRANSITION_TRIPS_BEFORE[name] - (7 + 3) - 1 - (status === "running" ? 5 : 0));
    expect(kvCalls.length, kvCalls.join("\n")).toBe(KV_CALLS_BEFORE[name]);
  });
}
