import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { resetStorage, applyControlMigrations } from "./apply-migrations";
import { siteWithRunning, publishRes } from "./helpers";

describe("publish body migration", () => {
  it("adds a nullable INTEGER timestamp and leaves existing publish bodies intact", async () => {
    await resetStorage({ before: "0027" });
    const { owner, sid } = await siteWithRunning();
    await publishRes(owner.token, sid);
    const before = await env.DB.prepare("select * from publishes").all();
    await applyControlMigrations();
    const columns = await env.DB.prepare("pragma table_info(publishes)").all();
    expect(columns.results.find((c) => c.name === "body_pruned_at")).toMatchObject({ type: "INTEGER", notnull: 0, dflt_value: null });
    const after = await env.DB.prepare("select * from publishes").all();
    expect(after.results).toEqual(before.results.map((r) => ({ ...r, body_pruned_at: null })));
  });
});
