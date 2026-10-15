import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAuth } from "../src/auth";
import { isKeyExpired, keyExpiresAt, unusableSince } from "../src/api-key-expiry";
import { call, json, setupOwner } from "./helpers";

/**
 * backlog B43 / r2 CX-High-2: 期限は metadata に持ち、control が判定する(Better Auth の期限切れの自動削除は、失効の記録ごと鍵を消すため)。
 * 検討記録 = docs/dev/api_key_expiry_study_v1.md
 */
const DAY = 86_400_000;
type Listed = { id: string; expiresAt: number | null; revokedAt: number | null };
const issue = async (token: string, workspaceId: string, expiresInDays?: number) => {
  const res = await call("POST", "/me/api-keys", { token, body: { name: "k", workspaceId, roleCap: "viewer", ...(expiresInDays ? { expiresInDays } : {}) } });
  expect(res.status).toBe(201);
  return json<{ id: string; key: string; expiresAt: number | null }>(res);
};
/** 鍵の metadata の expiresAt を書き換える(期限が過ぎた状態を作る)。ほかのキーはそのまま */
const setExpiry = async (id: string, expiresAt: unknown) => {
  const row = await env.DB.prepare("select metadata from apikey where id = ?1").bind(id).first<{ metadata: string }>();
  const meta = JSON.parse(row!.metadata) as Record<string, unknown>;
  await env.DB.prepare("update apikey set metadata = ?1 where id = ?2").bind(JSON.stringify({ ...meta, expiresAt }), id).run();
};
const rowExists = async (id: string) => (await env.DB.prepare("select id from apikey where id = ?1").bind(id).first()) !== null;
const myKeys = async (token: string) => json<Listed[]>(await call("GET", "/me/api-keys", { token }));

describe("api key expiry (backlog B43)", () => {
  it("pure rules: metadata first, null = no expiry, missing = native column, anything else = unusable", () => {
    expect(keyExpiresAt(JSON.stringify({ scope: "full", expiresAt: 1000 }), null)).toBe(1000);
    expect(keyExpiresAt(JSON.stringify({ scope: "full", expiresAt: null }), 5000)).toBeNull();
    expect(keyExpiresAt(JSON.stringify({ scope: "full" }), 5000)).toBe(5000); // B43 より前の鍵(control の後方互換はここで確かめる)
    expect(keyExpiresAt(null, 5000)).toBe(5000);
    expect(keyExpiresAt("null", 5000)).toBe(5000);
    expect(keyExpiresAt(JSON.stringify({ scope: "full" }), Number.NaN)).toBe("invalid"); // Better Auth の列が日時として読めない // Better Auth は metadata 無しの鍵を JSON の null で保存する
    expect(keyExpiresAt(JSON.stringify(JSON.stringify({ scope: "full", expiresAt: 1000 })), null)).toBe(1000); // 二重に JSON 化
    expect(keyExpiresAt(JSON.stringify({ scope: "full", expiresAt: "soon" }), null)).toBe("invalid");
    expect(keyExpiresAt("{broken", null)).toBe("invalid");
    expect(keyExpiresAt("[1]", null)).toBe("invalid"); // 配列・数値などのオブジェクトでない metadata は読めない扱い
    expect(isKeyExpired(1000, 1000)).toBe(true); // 境界は「使えない」
    expect(isKeyExpired(1001, 1000)).toBe(false);
    expect(isKeyExpired(null, 1000)).toBe(false);
    expect(isKeyExpired("invalid", 1000)).toBe(true);
    expect(unusableSince(null, 500, 1000)).toBe(500);
    expect(unusableSince(300, 500, 1000)).toBe(300);
    expect(unusableSince(700, 500, 1000)).toBe(500); // 早い方
    expect(unusableSince(null, 2000, 1000)).toBeNull(); // 期限はまだ先
    expect(unusableSince(700, 2000, 1000)).toBe(700);
    expect(unusableSince(null, null, 1000)).toBeNull();
    expect(unusableSince(null, "invalid", 1000)).toBeNull();
    expect(unusableSince(700, "invalid", 1000)).toBe(700);
  });

  it("writes the expiry into metadata and never into Better Auth's column (watch for library upgrades)", async () => {
    const owner = await setupOwner();
    const before = Date.now();
    const k = await issue(owner.token, owner.workspaceId, 7);
    expect(k.expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(k.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    const row = await env.DB.prepare(`select "expiresAt" as native, metadata from apikey where id = ?1`).bind(k.id).first<{ native: string | null; metadata: string }>();
    expect(row!.native).toBeNull(); // Better Auth に期限を見せない = 自動削除の対象にならない
    expect(keyExpiresAt(row!.metadata, null)).toBe(k.expiresAt);
    expect((await myKeys(owner.token)).find((x) => x.id === k.id)!.expiresAt).toBe(k.expiresAt);
    const none = await issue(owner.token, owner.workspaceId);
    expect(none.expiresAt).toBeNull();
    expect((await myKeys(owner.token)).find((x) => x.id === none.id)!.expiresAt).toBeNull();
  });

  it("refuses an expired key at the entrance with a hint", async () => {
    const owner = await setupOwner();
    const k = await issue(owner.token, owner.workspaceId, 1);
    expect((await call("GET", "/me", { token: k.key })).status).toBe(200);
    await setExpiry(k.id, Date.now() - 1);
    const res = await call("GET", "/me", { token: k.key });
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ hint: "この API キーは有効期限を過ぎています。管理画面で発行し直してください" });
    await setExpiry(k.id, "soon"); // 読めない期限 = 使えない(fail-closed)
    expect((await call("GET", "/me", { token: k.key })).status).toBe(401);
  });

  it("an unreadable expiry is shown as null in both lists (the key itself is refused at the entrance)", async () => {
    const owner = await setupOwner();
    const k = await issue(owner.token, owner.workspaceId, 1);
    await setExpiry(k.id, "soon");
    expect((await myKeys(owner.token)).find((x) => x.id === k.id)!.expiresAt).toBeNull();
    const members = await json<Listed[]>(await call("GET", `/workspaces/${owner.workspaceId}/api-keys`, { token: owner.token }));
    expect(members.find((x) => x.id === k.id)!.expiresAt).toBeNull();
  });

  it("keeps an expired, revoked key in the list for 30 days even after Better Auth's cleanup runs", async () => {
    const owner = await setupOwner();
    const k = await issue(owner.token, owner.workspaceId, 1);
    expect((await call("DELETE", `/me/api-keys/${k.id}`, { token: owner.token })).status).toBe(204);
    await setExpiry(k.id, Date.now() - DAY);
    // Better Auth の一括削除を間引きなしで直接走らせ、使われたときの経路(期限切れの鍵の提示)も通す
    await getAuth(env).api.deleteAllExpiredApiKeys({});
    expect((await call("GET", "/me", { token: k.key })).status).toBe(401);
    expect(await rowExists(k.id)).toBe(true);
    const listed = (await myKeys(owner.token)).find((x) => x.id === k.id)!;
    expect(listed.revokedAt).not.toBeNull();
    expect(listed.expiresAt).toBeLessThan(Date.now());
  });

  it("keeps an expired key that was not revoked for 30 days after the expiry, then purges it", async () => {
    const owner = await setupOwner();
    const k = await issue(owner.token, owner.workspaceId, 1);
    await setExpiry(k.id, Date.now() - DAY);
    expect((await myKeys(owner.token)).some((x) => x.id === k.id)).toBe(true); // 期限切れとして見える
    await setExpiry(k.id, Date.now() - 31 * DAY);
    expect((await myKeys(owner.token)).some((x) => x.id === k.id)).toBe(false);
    expect(await rowExists(k.id)).toBe(false); // 自分の一覧を開いたときに消える(失効済みと同じ)
  });

  it("the members' key list uses the same retention", async () => {
    const owner = await setupOwner();
    const k = await issue(owner.token, owner.workspaceId, 1);
    const list = async () => json<Listed[]>(await call("GET", `/workspaces/${owner.workspaceId}/api-keys`, { token: owner.token }));
    await setExpiry(k.id, Date.now() - DAY);
    expect((await list()).some((x) => x.id === k.id)).toBe(true);
    await setExpiry(k.id, Date.now() - 31 * DAY);
    expect((await list()).some((x) => x.id === k.id)).toBe(false);
  });

  // 端から端の挙動の確認だけ: Better Auth 自身が列の期限を過ぎた鍵を requireSession より前に断る(行も消す)ので、
  // このテストでは control 側の列への後戻り(keyExpiresAt の 2 つ目の引数)は確かめられない。それは pure rules のテストが確かめる
  it("a key issued before B43 whose Better Auth column has passed is still refused (end-to-end)", async () => {
    const owner = await setupOwner();
    const k = await issue(owner.token, owner.workspaceId);
    const row = await env.DB.prepare("select metadata from apikey where id = ?1").bind(k.id).first<{ metadata: string }>();
    const { expiresAt: _drop, ...legacy } = JSON.parse(row!.metadata) as Record<string, unknown>;
    await env.DB.prepare(`update apikey set metadata = ?1, "expiresAt" = ?2 where id = ?3`).bind(JSON.stringify(legacy), new Date(Date.now() - 1000).toISOString(), k.id).run();
    expect((await call("GET", "/me", { token: k.key })).status).toBe(401);
  });
});
