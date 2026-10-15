"use client";
import { useEffect, useState } from "react";
import { expiryLabel } from "@/lib/api-keys";
import { formatLocalTime, type LocalTimeKind } from "@/lib/local-time";

/**
 * 時刻の表示(backlog B44)。サーバー(Workers = UTC)とブラウザ(見ている人のタイムゾーン)で文字が食い違うと
 * ハイドレーションの不一致になり、root が描き直されて <html data-theme> が外れる。そこで時刻は
 * マウントの後にブラウザの時計とタイムゾーンで描き、サーバーの描画とマウント前は文字を出さない。
 * 時刻を描くときはここを通す(test/hydration-guard.test.ts が app/・components/ の toLocaleString と Date.now() を止める)
 */

/** 今の時刻。マウント前(サーバーの描画とハイドレーション)は null。tickMs を渡すとその間隔で進める */
export function useNow(tickMs?: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!tickMs) return;
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  return now;
}

/** マウントが終わったか(時刻の書式だけを使い、今の時刻は要らないとき) */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** 時刻 1 つ。kind = datetime(既定、2026/10/6 12:04:05)/ date(2026/10/6)/ deadline(10/6 12:04) */
export function LocalTime({ at, kind = "datetime" }: { at: number; kind?: LocalTimeKind }) {
  const mounted = useMounted();
  if (!Number.isFinite(at)) return <>-</>; // toISOString は不正な時刻で投げる(画面全体を落とさない)
  return <time dateTime={new Date(at).toISOString()}>{mounted ? formatLocalTime(at, kind) : ""}</time>;
}

/** API キーの期限の列(期限なし / 10/12 22:05 / 期限切れ(10/12 22:05))。期限切れかは今の時刻で決まるのでマウント後に描く */
export function ExpiryLabel({ expiresAt }: { expiresAt: number | null }) {
  const now = useNow();
  if (expiresAt === null) return <>{expiryLabel(null, 0)}</>;
  if (!Number.isFinite(expiresAt)) return <>-</>;
  return <time dateTime={new Date(expiresAt).toISOString()}>{now === null ? "" : expiryLabel(expiresAt, now)}</time>;
}
