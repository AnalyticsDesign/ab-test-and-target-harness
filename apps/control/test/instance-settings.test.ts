import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db";
import { INSTANCE_SETTING_DEFAULTS, readInstanceSettings, writeInstanceSettings } from "../src/instance-settings";

// backlog D10 / brief K2・K3: 導入全体の設定。キーと値の表で、行が無い・読めない値は既定値
describe("instance settings (D10 K2/K3)", () => {
  const db = () => getDb(env);

  it("returns the defaults when no row exists", async () => {
    expect(await readInstanceSettings(db())).toEqual({ usageVisibility: "members", cloudflarePlan: "free", showPaidReference: true });
    expect(INSTANCE_SETTING_DEFAULTS.usageVisibility).toBe("members");
  });

  it("writes only the given keys and keeps the others", async () => {
    await writeInstanceSettings(db(), { cloudflarePlan: "paid" }, "u1", 1000);
    await writeInstanceSettings(db(), { showPaidReference: false }, "u2", 2000);
    expect(await readInstanceSettings(db())).toEqual({ usageVisibility: "members", cloudflarePlan: "paid", showPaidReference: false });
    const row = await env.DB.prepare("select value, updated_at, updated_by from instance_settings where key = 'cloudflarePlan'").first();
    expect(row).toEqual({ value: '"paid"', updated_at: 1000, updated_by: "u1" });
  });

  it("overwrites an existing key (upsert)", async () => {
    await writeInstanceSettings(db(), { usageVisibility: "instance_admins" }, null, 1);
    await writeInstanceSettings(db(), { usageVisibility: "members" }, null, 2);
    expect((await readInstanceSettings(db())).usageVisibility).toBe("members");
  });

  it("falls back to the default for broken or unknown values, per key", async () => {
    await env.DB.batch([
      env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('usageVisibility', 'not json', 1)"),
      env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('cloudflarePlan', '\"enterprise\"', 1)"),
      env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('showPaidReference', 'false', 1)"),
      env.DB.prepare("insert into instance_settings (key, value, updated_at) values ('somethingElse', '1', 1)"),
    ]);
    expect(await readInstanceSettings(db())).toEqual({ usageVisibility: "members", cloudflarePlan: "free", showPaidReference: false });
  });

  it("writing an empty patch does nothing", async () => {
    await writeInstanceSettings(db(), {}, null);
    const n = await env.DB.prepare("select count(*) as n from instance_settings").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
