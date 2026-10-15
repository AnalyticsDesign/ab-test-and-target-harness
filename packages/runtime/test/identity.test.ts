import { describe, expect, it, beforeEach, vi } from "vitest";
import { deriveExternalUuid, hashByoidValue, isCanonicalModeAId, uuidToVisitorId, visitorIdIssuedAt } from "@wtt/core";
import type { RuntimeSettings } from "@wtt/core";
import { establishIdentity, readCookie, revokeIdentity } from "../src/identity";

const baseSettings: RuntimeSettings = {
  mode: "A", idSource: "ab",
  visitorCookieName: "_ab_vid", uuidCookieEnabled: false, uuidCookieName: "_ab_uuid",
  previousCookieNames: [], decisionTimeoutMs: 1000, consentMode: "implicit",
};
const KNOWN_ID = uuidToVisitorId("11111111-2222-4333-8444-555555555555")!; // canonical + v4

function clearCookies(): void {
  for (const part of document.cookie.split(/;\s*/)) {
    const name = part.split("=")[0];
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}
beforeEach(clearCookies);

// happy-dom escape hatch(タスクブリーフ許可): document.cookie は Max-Age=0 で値を "" にするだけで
// エントリ自体を消さない(実ブラウザは削除する)。deletion を toBeUndefined() で検証するテストだけ、
// name -> value を保持する自作スタブに切り替える。identity.ts の挙動は変えない。
function makeCookieStub(): { cookie: string } {
  const store = new Map<string, string>();
  return {
    get cookie(): string {
      return Array.from(store.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(raw: string) {
      const [pair, ...attrs] = raw.split(/;\s*/);
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      const maxAgeAttr = attrs.find((a) => /^Max-Age=/i.test(a));
      const maxAge = maxAgeAttr ? Number(maxAgeAttr.slice("Max-Age=".length)) : undefined;
      if (maxAge !== undefined && maxAge <= 0) store.delete(name);
      else store.set(name, value);
    },
  };
}

describe("mode A", () => {
  it("issues a canonical id when absent and reuses it on the next boot (spec §4.1 / §5.4)", async () => {
    const first = await establishIdentity(baseSettings, "salt", document);
    expect(first.visitorId).not.toBeNull();
    expect(isCanonicalModeAId(first.visitorId!)).toBe(true);
    expect(readCookie(document, "_ab_vid")).toBe(first.visitorId);
    const second = await establishIdentity(baseSettings, "salt", document);
    expect(second.visitorId).toBe(first.visitorId); // 既存 Cookie は必ず再利用(§5.4)
  });

  it("replaces a non-canonical cookie value with a fresh id (spec §5.4)", async () => {
    document.cookie = "_ab_vid=not-a-valid-id; Path=/";
    const r = await establishIdentity(baseSettings, "salt", document);
    expect(r.visitorId).not.toBe("not-a-valid-id");
    expect(isCanonicalModeAId(r.visitorId!)).toBe(true);
  });

  it("mode_a_issues_and_renews_under_configured_names", async () => {
    // §18.1「configured cookie names」名の runtime 半分(edge 側の同名 it は Plan 2 済。対応は plan 冒頭の表が正。
    // §18.1 名の文字列をコメントに書かない — 名前検証の rg を二重ヒットさせないため。以下同様)
    const s = { ...baseSettings, visitorCookieName: "my_vid", uuidCookieEnabled: true, uuidCookieName: "my_uuid" };
    const doc = makeCookieStub(); // happy-dom escape hatch(未削除の "" 値と undefined を区別するため)
    const r = await establishIdentity(s, "salt", doc);
    expect(readCookie(doc, "my_vid")).toBe(r.visitorId);
    expect(readCookie(doc, "my_uuid")).toBe(await deriveExternalUuid("salt", r.visitorId!));
    expect(readCookie(doc, "_ab_vid")).toBeUndefined();
  });

  it("writes the uuid derived from the canonical and repairs tampering (spec §5.4 / 決定 49 §7.2)", async () => {
    const s = { ...baseSettings, uuidCookieEnabled: true };
    document.cookie = `_ab_vid=${KNOWN_ID}; Path=/`;
    document.cookie = "_ab_uuid=tampered; Path=/";
    const r = await establishIdentity(s, "salt", document);
    expect(r.visitorId).toBe(KNOWN_ID);                                                  // UUID Cookie は意思決定に使わない(出力専用)
    expect(readCookie(document, "_ab_uuid")).toBe(await deriveExternalUuid("salt", KNOWN_ID)); // 不一致は正本から導出して上書き(自動修復)
  });

  it("新しく発行する正本は UUIDv7。初回の訪問 = 発行時刻、既存の v4 は発行時刻が不明(null)", async () => {
    const fresh = await establishIdentity(baseSettings, "salt", makeCookieStub());
    expect(fresh.firstVisitAt).toBe(visitorIdIssuedAt(fresh.visitorId!));
    expect(typeof fresh.firstVisitAt).toBe("number");
    const doc = makeCookieStub();
    doc.cookie = `_ab_vid=${KNOWN_ID}; Path=/`; // v4(v1.0 より前に発行)
    expect((await establishIdentity(baseSettings, "salt", doc)).firstVisitAt).toBeNull();
  });

  it("SHA-256 が使えなければ UUID Cookie は書かない(正本は書く)", async () => {
    const doc = makeCookieStub();
    const brokenSubtle = { digest: () => Promise.reject(new Error("no subtle")) } as unknown as SubtleCrypto;
    const r = await establishIdentity({ ...baseSettings, uuidCookieEnabled: true }, "salt", doc, () => true, brokenSubtle);
    expect(readCookie(doc, "_ab_vid")).toBe(r.visitorId);
    expect(readCookie(doc, "_ab_uuid")).toBeUndefined();
  });

  it("mode_a_rename_migration_drops_old_cookie_without_revival", async () => {
    // §18.1「rename migration」名の runtime 半分(edge 側の同名 it は Plan 2 済)
    const s = { ...baseSettings, visitorCookieName: "_ab_vid2", previousCookieNames: ["_ab_vid"] };
    const doc = makeCookieStub(); // happy-dom escape hatch(未削除の "" 値と undefined を区別するため)
    doc.cookie = `_ab_vid=${KNOWN_ID}; Path=/`; // 旧名に有効 ID が残っている
    const r = await establishIdentity(s, "salt", doc);
    expect(readCookie(doc, "_ab_vid")).toBeUndefined();  // 旧名は削除
    expect(r.visitorId).not.toBe(KNOWN_ID);                   // 値は読まず、新 ID を発行(復活させない)
    expect(readCookie(doc, "_ab_vid2")).toBe(r.visitorId);
  });

  it("mode_a_disabled_uuid_alias_dropped_via_previous_names", async () => {
    // §18.1「uuid alias 無効化」名の runtime 半分(edge 側の同名 it は Plan 2 済)
    const s = { ...baseSettings, uuidCookieEnabled: false, previousCookieNames: ["_ab_uuid"] };
    const doc = makeCookieStub(); // happy-dom escape hatch(未削除の "" 値と undefined を区別するため)
    doc.cookie = "_ab_uuid=11111111-2222-4333-8444-555555555555; Path=/";
    await establishIdentity(s, "salt", doc);
    expect(readCookie(doc, "_ab_uuid")).toBeUndefined();
  });
});

describe("mode C (idSource cookie:<name>)", () => {
  it("mode_c_keeps_reference_ab_vid", async () => {
    // 決定 49 §7.4: BYOID でも参考用の匿名 Cookie(UUIDv7)を発行・維持し、その発行時刻を初回の訪問に使う。識別は BYOID
    const s = { ...baseSettings, idSource: "cookie:_site_session" };
    const doc = makeCookieStub(); // happy-dom escape hatch(未削除の "" 値と undefined を区別するため)
    doc.cookie = "_site_session=sess-123; Path=/";
    const r = await establishIdentity(s, "salt-x", doc);
    expect(r.usedByoid).toBe(true);
    expect(r.visitorId).toBe(await hashByoidValue("salt-x", "sess-123")); // 生値は送らない
    const ref = readCookie(doc, "_ab_vid")!;
    expect(isCanonicalModeAId(ref)).toBe(true);
    expect(r.firstVisitAt).toBe(visitorIdIssuedAt(ref));
    const again = await establishIdentity(s, "salt-x", doc);
    expect(readCookie(doc, "_ab_vid")).toBe(ref); // 次の起動でも同じ参考用 ID を使い続ける
    expect(again.firstVisitAt).toBe(r.firstVisitAt);
  });

  it("mode_c_switch_from_anonymous_keeps_first_visit", async () => {
    // 匿名で来ていた人がログインして BYOID に切り替わっても、同じブラウザの _ab_vid を見るので初回の訪問は変わらない
    const s = { ...baseSettings, idSource: "cookie:_site_session" };
    const doc = makeCookieStub();
    const anon = await establishIdentity(s, "salt-x", doc);
    expect(anon.usedByoid).toBe(false);
    doc.cookie = "_site_session=sess-123; Path=/";
    const loggedIn = await establishIdentity(s, "salt-x", doc);
    expect(loggedIn.usedByoid).toBe(true);
    expect(loggedIn.firstVisitAt).toBe(anon.firstVisitAt);
  });

  it("BYOID の訪問者にも UUID Cookie を出す(43 文字の ID から導出。決定 49 §7.2)", async () => {
    const s = { ...baseSettings, idSource: "cookie:_site_session", uuidCookieEnabled: true };
    const doc = makeCookieStub();
    doc.cookie = "_site_session=sess-123; Path=/";
    const r = await establishIdentity(s, "salt-x", doc);
    expect(readCookie(doc, "_ab_uuid")).toBe(await deriveExternalUuid("salt-x", r.visitorId!));
  });

  it("falls back to an anonymous mode A id when the byoid cookie is absent (spec §4.3)", async () => {
    const s = { ...baseSettings, idSource: "cookie:_site_session" };
    const r = await establishIdentity(s, "salt-x", document);
    expect(r.usedByoid).toBe(false);
    expect(isCanonicalModeAId(r.visitorId!)).toBe(true);
    expect(readCookie(document, "_ab_vid")).toBe(r.visitorId);
  });

  it("byoid_hash_failure_falls_back_to_anonymous_id", async () => {
    // r1 CL-High-1: crypto.subtle は secure context 限定。非セキュアな導入サイトでは undefined で TypeError になり、
    // spec §4.3 のフォールバック(値が取得できない場合は Mode A の匿名 ID)に到達しないまま起動全体が落ちる
    const s = { ...baseSettings, idSource: "cookie:_site_session" };
    document.cookie = "_site_session=sess-123; Path=/";
    const brokenSubtle = { digest: () => Promise.reject(new Error("no subtle")) } as unknown as SubtleCrypto;
    const r = await establishIdentity(s, "salt-x", document, () => true, brokenSubtle);
    expect(r.usedByoid).toBe(false);
    expect(isCanonicalModeAId(r.visitorId!)).toBe(true);
    expect(readCookie(document, "_ab_vid")).toBe(r.visitorId);
  });
});

describe("d-lite (mode B)", () => {
  it("never touches document.cookie and returns no visitor id (spec §9.6)", async () => {
    // r1 CX-Medium-7: 「書かれていない」ではなく「読み書きに来ない」を直接数える(HttpOnly は JS 書込を静かに拒否するため、
    // 値の比較だけでは runtime が試みたかどうかを識別できない)
    const doc = { reads: 0, writes: 0, get cookie() { this.reads++; return "_old=zzz"; }, set cookie(_v: string) { this.writes++; } };
    const s: RuntimeSettings = { ...baseSettings, mode: "B", previousCookieNames: ["_old"] };
    const r = await establishIdentity(s, "salt", doc as unknown as { cookie: string });
    expect(r.visitorId).toBeNull();
    expect(doc.writes).toBe(0); // 旧名の削除も edge の仕事。runtime は一切書かない
    expect(doc.reads).toBe(0);
  });
});

describe("revoke", () => {
  it("mode_c_revoke_keeps_the_site_cookie_and_regrant_restores_the_same_id", async () => {
    // spec §4.3(2026-09-01 決定、r2 CX-High-4): BYOID はサイトの資産なので削除しない。
    // その結果、再 grant では同じ派生 ID に戻る — §16 の「新しい ID を発行する」は Mode A の契約で、
    // Mode C は明示的な例外。意図した挙動であることをテストで固定する(退行ではなく契約)
    const s = { ...baseSettings, idSource: "cookie:_site_session" };
    document.cookie = "_site_session=sess-123; Path=/";
    const first = await establishIdentity(s, "salt-x", document);
    revokeIdentity(s, document);
    expect(readCookie(document, "_site_session")).toBe("sess-123"); // サイトの Cookie には触れない
    const second = await establishIdentity(s, "salt-x", document);
    expect(second.visitorId).toBe(first.visitorId);
    expect(second.usedByoid).toBe(true);
  });

  it("deletes canonical and uuid cookies with issuing attributes (spec §16)", async () => {
    const s = { ...baseSettings, uuidCookieEnabled: true };
    const doc = makeCookieStub(); // happy-dom escape hatch(未削除の "" 値と undefined を区別するため)
    await establishIdentity(s, "salt", doc);
    revokeIdentity(s, doc);
    expect(readCookie(doc, "_ab_vid")).toBeUndefined();
    expect(readCookie(doc, "_ab_uuid")).toBeUndefined();
  });

  /** digest の完了を手で進められる subtle(確立の途中で撤回・再許可を挟むため)。release の後に来た digest はそのまま通す */
  function holdingSubtle(): { subtle: SubtleCrypto; waiting: () => number; release: () => void } {
    const real = globalThis.crypto.subtle;
    const pending: Array<() => void> = [];
    let open = false;
    const subtle = {
      digest: (alg: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> =>
        open ? real.digest(alg, data) : new Promise((resolve, reject) => pending.push(() => void real.digest(alg, data).then(resolve, reject))),
    } as unknown as SubtleCrypto;
    return {
      subtle,
      waiting: () => pending.length,
      release: () => {
        open = true;
        for (const run of pending.splice(0)) run();
      },
    };
  }

  it("revoke_during_identity_does_not_recreate_uuid_cookie", async () => {
    // 確立の開始 → revokeIdentity → digest の完了、の順。撤回で消した Cookie を古い世代が作り直さない(Mode A と Mode C)
    const modes: RuntimeSettings[] = [
      { ...baseSettings, uuidCookieEnabled: true },
      { ...baseSettings, idSource: "cookie:_site_session", uuidCookieEnabled: true },
    ];
    for (const s of modes) {
      const doc = makeCookieStub();
      doc.cookie = "_site_session=sess-123; Path=/"; // Mode C の BYOID(Mode A は読まない)
      const held = holdingSubtle();
      let current = true;
      const pending = establishIdentity(s, "salt", doc, () => current, held.subtle); // 確立の開始(digest で止まる)
      await vi.waitFor(() => expect(held.waiting()).toBe(1));
      current = false; // 撤回(runtime では revoked = true)
      revokeIdentity(s, doc);
      held.release(); // digest の完了
      await pending;
      expect(readCookie(doc, "_ab_uuid"), s.idSource).toBeUndefined();
      expect(readCookie(doc, "_ab_vid"), s.idSource).toBeUndefined();
    }
  });

  it("stale_generation_identity_does_not_overwrite_new_generation", async () => {
    // 撤回 → 再許可の後に古い世代の digest が完了しても、新しい世代の Cookie が残る
    const s = { ...baseSettings, uuidCookieEnabled: true };
    const doc = makeCookieStub();
    const held = holdingSubtle();
    let gen = 1;
    const old = establishIdentity(s, "salt", doc, () => gen === 1, held.subtle); // 古い世代(digest で止まる)
    await vi.waitFor(() => expect(held.waiting()).toBe(1));
    gen = 0; // 撤回
    revokeIdentity(s, doc);
    gen = 2; // 再許可(新しい世代)
    const fresh = await establishIdentity(s, "salt", doc, () => gen === 2);
    held.release(); // 古い世代の digest の完了
    await old;
    expect(readCookie(doc, "_ab_vid")).toBe(fresh.visitorId);
    expect(readCookie(doc, "_ab_uuid")).toBe(await deriveExternalUuid("salt", fresh.visitorId!));
  });
});
