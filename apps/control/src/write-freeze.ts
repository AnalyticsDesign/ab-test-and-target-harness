// apps/control/src/write-freeze.ts
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "./app";
import type { Db } from "./db";
import { ApiError } from "./errors";

/**
 * backlog D13 / 決定 56: 書き込みの凍結(メンテナンス中)。スイッチは D1 の instance_settings のキー writeFreeze。
 * **行の有無が正**: 行が無い = 凍結していない / 行がある = 凍結中。値が読めない・D1 が読めないときも凍結中(誰かが入れようとした行を無視しない)。
 * D10 の readInstanceSettings(読めない値は既定値)とは逆向きなので、ここで別に読む。
 * 値の形は版をまたぐ約束(新しい版の deploy.md のコマンドが、古い版の control が読む値を書く)。足す変更だけを許し、知らないフィールドは無視する。
 * until は表示だけ(過ぎても自動では外さない。外すのは作業者のコマンドだけ)
 */
export const WRITE_FREEZE_KEY = "writeFreeze";

/** reason = null は「行はあるが読めない」か「D1 が読めない」。since = 入れた時刻(epoch ミリ秒。D1 が読めないときは null) */
export type WriteFreeze = { reason: string | null; until: string | null; since: number | null };

const ValueSchema = z.object({
  reason: z.string().trim().min(1),
  until: z.iso.datetime({ offset: true }).nullable().optional(), // null = 見込み無し(json_object('until', NULL) の形)
});

export function parseWriteFreeze(value: string): { reason: string; until: string | null } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  const r = ValueSchema.safeParse(raw);
  return r.success ? { reason: r.data.reason, until: r.data.until ?? null } : null;
}

export async function readWriteFreeze(db: Db): Promise<WriteFreeze | null> {
  let row: { value: string; updated_at: number } | undefined;
  try {
    row = await db.selectFrom("instance_settings").select(["value", "updated_at"]).where("key", "=", WRITE_FREEZE_KEY).executeTakeFirst();
  } catch (e) {
    // 決定 56 (2): 読めないなら断る側に倒す。書き込みも D1 に書けないので、断っても失うものが無い
    console.error("write freeze: D1 read failed (treated as frozen)", e);
    return { reason: null, until: null, since: null };
  }
  if (!row) return null;
  const parsed = parseWriteFreeze(row.value);
  if (parsed) return { ...parsed, since: row.updated_at };
  // 読めない値も凍結中として扱う。作業者が書いた値(秘密ではない)をそのまま残し、直す手がかりにする
  console.warn("write freeze: unreadable value", row.value);
  return { reason: null, until: null, since: row.updated_at };
}

/** D9 の Cron(凍結中はその回を見送る)と、GET に伴う業務データの書き込み(凍結中は書かない)が使う */
export async function isWriteFrozen(db: Db): Promise<boolean> {
  return (await readWriteFreeze(db)) !== null;
}

const untilMs = (f: WriteFreeze): number | null => {
  if (f.until === null) return null;
  const t = Date.parse(f.until);
  return Number.isFinite(t) ? t : null;
};

/** 封筒の hint(公開物。設計記録への参照を書かない)。until は運用者が書いた文字列のまま出す */
export function freezeHint(f: WriteFreeze, now: number): string {
  if (f.reason === null) return "凍結の設定が読めません。作業者に確認してください";
  const t = untilMs(f);
  if (t === null) return `理由: ${f.reason}。メンテナンスが終わってから、もう一度実行してください`;
  if (t <= now) return `理由: ${f.reason}。再開の見込み(${f.until})を過ぎています。作業者に確認してください`;
  return `理由: ${f.reason}。再開の見込み: ${f.until}。メンテナンスが終わってから、もう一度実行してください`;
}

export function retryAfterSeconds(f: WriteFreeze, now: number): number {
  const t = untilMs(f);
  return t !== null && t > now ? Math.ceil((t - now) / 1000) : 300;
}

export function writeFrozenError(f: WriteFreeze, now: number): ApiError {
  return new ApiError(503, "write_frozen", { hint: freezeHint(f, now), reason: f.reason, until: f.until, retryAfter: retryAfterSeconds(f, now) });
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 決定 56 (4): 凍結中も通す要求。読み取り(GET / HEAD / OPTIONS)と、ログインまわり(/auth/* = Better Auth と Google ログインの 3 経路、
 * /break-glass/* = 非常口)だけ。**それ以外の書き込みはすべて断る**(一覧で通す側を持つので、後から足したルートも自動で対象に入る)。
 * ログインに伴うセッション・ユーザーの行の作成と、API キーの検証に伴う行の書き戻しは、この経路の内側か GET なので止まらない
 * (控えから戻して消えても、ログインし直せば済む)。テストの一時停止・公開・招待の受諾は断る
 */
// 何も書かない POST(配信条件の what-if)。凍結中もエージェントが配信条件を確かめられるようにする(レビュー r1 CL-Medium-3 → ユーザー決定 2026-10-08)
const READ_ONLY_POST = /^\/sites\/[^/]+\/evaluate$/;

export function isFreezeExempt(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (!WRITE_METHODS.has(m)) return true;
  if (m === "POST" && READ_ONLY_POST.test(pathname)) return true;
  return pathname.startsWith("/auth/") || pathname === "/break-glass" || pathname.startsWith("/break-glass/");
}

/** 書き込みの要求のときだけスイッチを読む(読み取りと訪問者への配信には負担をかけない) */
export const writeFreezeGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (isFreezeExempt(c.req.method, new URL(c.req.url).pathname)) return next();
  const f = await readWriteFreeze(c.get("db"));
  if (f) throw writeFrozenError(f, Date.now()); // Retry-After は errorHandler が extra.retryAfter から付ける
  await next();
});
