import { sql } from "kysely";
import type { Db } from "./db";

/** 決定 46 (6): admin へ渡す使い捨てコードの寿命。ブラウザの URL に載る唯一の値なので短くする */
export const HANDOFF_TTL_MS = 60_000;
const PREFIX = "handoff:";

const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const hashCode = async (code: string) => toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));

/**
 * セッショントークンを 1 分だけ預かり、引き換えのコードを返す。DB に置くのはコードのハッシュだけ(D1 を読めてもコードは分からない)。
 * 行は Better Auth の `verification` 表に同居させるが、掃除は当てにしない(state を Cookie に持たせる構成では、
 * Better Auth がこの表を触るのはパスワード再設定のときだけ = 普段は開いていない)。
 * 引き換えられなかった行が溜まらないよう、発行のたびに **この module が作った行**(`handoff:` で始まる identifier)の
 * 期限切れを消す。他の用途の行には触れない
 */
export async function issueHandoff(db: Db, sessionToken: string): Promise<string> {
  const code = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  await sql`
    delete from verification where identifier like ${PREFIX + "%"} and "expiresAt" < ${now.toISOString()}
  `.execute(db);
  await sql`
    insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
    values (${crypto.randomUUID()}, ${PREFIX + (await hashCode(code))}, ${sessionToken},
            ${new Date(now.getTime() + HANDOFF_TTL_MS).toISOString()}, ${now.toISOString()}, ${now.toISOString()})
  `.execute(db);
  return code;
}

/**
 * コードをセッショントークンに引き換える。**DELETE … RETURNING の 1 文**なので、同じコードを同時に何本投げても
 * 行を得られるのは 1 件だけ(D1 / SQLite では 1 文が原子的)。期限切れの行もここで消費され、トークンは返さない
 */
export async function redeemHandoff(db: Db, code: string): Promise<string | null> {
  const r = await sql<{ value: string; expiresAt: string | number }>`
    delete from verification where identifier = ${PREFIX + (await hashCode(code))}
    returning value, "expiresAt" as "expiresAt"
  `.execute(db);
  const row = r.rows[0];
  if (!row) return null;
  return new Date(row.expiresAt).getTime() > Date.now() ? row.value : null;
}
