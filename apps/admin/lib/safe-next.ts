/** ログイン後の戻り先として受けるのは招待ページだけ(open redirect を作らない)。control の routes/oauth.ts の NEXT_RE と同じ式 */
const NEXT_RE = /^\/invite\/[A-Za-z0-9_-]{1,64}$/;
export const safeNext = (v: unknown): string | null => (typeof v === "string" && NEXT_RE.test(v) ? v : null);
