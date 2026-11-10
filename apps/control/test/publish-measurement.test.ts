import { it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { compile } from "@wtt/core";
import { getDb, toStatement } from "../src/db";
import { buildCompileInput, compileInputDigest, loadActiveConfig } from "../src/publish";
import { diffCompiledConfigs } from "../src/config-diff";
import { call, json, publishRes, siteRow, siteWithRunning } from "./helpers";

/** 時間は環境で変わるため表明しない。レポーターが meta の測定値を出力する。 */
it("records_digest_diff_and_preview_times_for_50_experiments_500_changes", async ({ task }) => {
  const { owner, sid, eid } = await siteWithRunning();
  const db = getDb(env);
  const exp = await db.selectFrom("experiments").selectAll().where("site_id", "=", sid).where("id", "=", eid).executeTakeFirstOrThrow();
  const variants = await db.selectFrom("variants").selectAll().where("site_id", "=", sid).execute();
  const change = await db.selectFrom("changes").selectAll().where("site_id", "=", sid).executeTakeFirstOrThrow();
  await db.deleteFrom("changes").where("site_id", "=", sid).execute();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < 50; i++) {
    const id = i === 0 ? eid : `exp_${i}`;
    if (i !== 0) {
      statements.push(toStatement(env, db.insertInto("experiments").values({ ...exp, id })));
      for (const v of variants) statements.push(toStatement(env, db.insertInto("variants").values({ ...v, experiment_id: id })));
    }
    for (let j = 0; j < 10; j++) statements.push(toStatement(env, db.insertInto("changes").values({ ...change, id: `c_${j}`, experiment_id: id, position: j })));
  }
  await env.DB.batch(statements);
  expect(await json(await publishRes(owner.token, sid))).toMatchObject({ ok: true });
  const site = await siteRow(sid);
  const input = await buildCompileInput(db, site, 2);
  const active = (await loadActiveConfig(db, site))!;
  const next = compile(input);
  let start = performance.now();
  await compileInputDigest(input);
  const digestMs = performance.now() - start;
  start = performance.now();
  diffCompiledConfigs(next, active);
  const diffMs = performance.now() - start;
  start = performance.now();
  const response = await call("GET", `/sites/${sid}/publish-preview?transition=${eid}:paused`, { token: owner.token });
  const previewMs = performance.now() - start;
  expect(response.status).toBe(200);
  expect(await json(response)).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/), transitionDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  Object.assign(task.meta, { measurement: { experiments: 50, changes: 500, digestMs, diffMs, previewMs } });
}, 30_000);
