import { env } from "cloudflare:workers";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import { getAuth } from "../src/auth";
import { testEnv } from "./helpers";

/**
 * B179 Task 10(D13 の代わり): src/auth.ts は Better Auth 1.7 の実行時の表の形の検査(advanced.database.validateSchema)を切っている。
 * 同じ判定を deploy の前にテストで行う。マイグレーションを当てた D1(各テストの前に apply-migrations.ts が作り直す)に対して、
 * Better Auth 自身の比較(`better-auth/db/migration` の getMigrations。`auth migrate` / `auth generate` が使う計画と同じもの)を走らせる。
 * - toBeCreated / toBeAdded: Better Auth が書く表・列で D1 に無いもの(実行時の検査の missing-table / missing-column と同じ)
 * - schemaProblems: Better Auth が書かない NOT NULL・既定値なしの列(同じく unexpected-required-column。あると Better Auth の insert が全部失敗する)
 * - toBeAddedIndexes: 表の単位の索引(schema の indexes)で D1 に無いもの。列の index: true(apikey_configId_idx など)は、getMigrations が
 *   表・列を作るときにだけ作り、既にある列については比べない。そのため apikey_configId_idx(わざと作らない。理由は
 *   docs/superpowers/plans/2026-11-02-b179-better-auth-1-7-implementation.md の Task 10)はここには出ない
 * 設定は auth.cli.ts ではなく本番の getAuth(env).options を使う(プラグイン・読み替え(referenceId → "userId")・追加の列が本番と同じになる)
 */

async function schemaPlan() {
  const plan = await getMigrations(getAuth(testEnv).options, { throwOnUnsafe: false });
  return {
    toBeCreated: plan.toBeCreated.map((t) => t.table),
    toBeAdded: plan.toBeAdded.map((t) => ({ table: t.table, fields: Object.keys(t.fields) })),
    toBeAddedIndexes: plan.toBeAddedIndexes.map((i) => i.name).sort(),
    schemaProblems: plan.schemaProblems,
    unsafeChanges: plan.unsafeChanges,
  };
}

describe("Better Auth schema vs control migrations (B179 D13)", () => {
  it("better_auth_schema_matches_migrations", async () => {
    expect(await schemaPlan()).toEqual({
      toBeCreated: [],
      toBeAdded: [],
      toBeAddedIndexes: [],
      schemaProblems: [],
      unsafeChanges: [],
    });
  }, 20_000);

  it("better_auth_schema_check_fails_on_required_column_better_auth_does_not_write", async () => {
    // 負例: Better Auth が書かない NOT NULL・既定値なしの列。SQLite の ALTER TABLE ADD COLUMN は NOT NULL に既定値を要るので、
    // 表を作り直す(verification はどこからも外部キーで指されない)。D1 は次のテストの前に作り直されるので、他のテストに響かない
    await env.DB.batch([
      env.DB.prepare(`drop table "verification"`),
      env.DB.prepare(
        `create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null, "extra" text not null)`,
      ),
      env.DB.prepare(`create index "verification_identifier_idx" on "verification" ("identifier")`),
    ]);
    const plan = await schemaPlan();
    expect(plan.schemaProblems).toHaveLength(1);
    expect(plan.schemaProblems[0]).toContain("verification");
    expect(plan.schemaProblems[0]).toContain("extra");
  }, 20_000);

  it("better_auth_schema_check_fails_on_missing_column", async () => {
    // 負例: Better Auth が書く列(session.loginMethod。migrations/0018)が無い
    await env.DB.prepare(`alter table "session" drop column "loginMethod"`).run();
    expect((await schemaPlan()).toBeAdded).toEqual([{ table: "session", fields: ["loginMethod"] }]);
  }, 20_000);
});
