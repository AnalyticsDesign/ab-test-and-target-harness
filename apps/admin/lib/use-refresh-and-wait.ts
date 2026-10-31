import { useCallback, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { beginRefresh } from "./refresh-wait";

/**
 * `router.refresh()` の代わり(管理画面の速さ CE-R9。仕組みと理由は `lib/refresh-wait.ts`)。読み直しを始め、画面に反映されたら解決する Promise を返す。
 * その間に押した遷移(AppLink)・節の切り替え(settings-section)は、反映の後に回る。
 *
 * 反映の終わりは useTransition で知る: vinext の refresh は、呼んだ同じ処理の中で router の状態を Promise にして(反映まで suspend する)、
 * 反映のときにその Promise を解く。その更新は呼び出し元の transition に入るので、`isPending` は refresh が画面に反映された commit で false になる。
 * 呼び出し元が消えたとき(unmount)は待ちを終える(回した操作は走る)
 */
export function useRefreshAndWait(): () => Promise<void> {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  /** 今の読み直し。seenPending = isPending が true になったのを見た(false に戻ったら反映が済んだ) */
  const current = useRef<{ end: () => void; resolve: () => void; seenPending: boolean } | null>(null);

  const finish = useCallback(() => {
    const c = current.current;
    if (!c) return;
    current.current = null;
    c.end();
    c.resolve();
  }, []);

  useEffect(() => {
    const c = current.current;
    if (!c) return;
    if (isPending) c.seenPending = true;
    else if (c.seenPending) finish();
  }, [isPending, finish]);

  useEffect(() => finish, [finish]);

  return useCallback(
    () =>
      new Promise<void>((resolve) => {
        // 前の読み直しがまだなら、それは終わったことにする(新しい読み直しが同じ画面を取り直す)
        finish();
        current.current = { end: beginRefresh(), resolve, seenPending: false };
        startTransition(() => router.refresh());
      }),
    [router, finish],
  );
}
