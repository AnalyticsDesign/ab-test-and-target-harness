import { useCallback, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearWriteSucceeded } from "./feedback-store";
import { beginRefresh, type RefreshHandle } from "./refresh-wait";

/** 読み直しの結果。done = 反映された(または、先の読み直しの終わりと一緒に終えた・部品が消えた)、timeout = 反映を待ち切れず打ち切った */
export type RefreshResult = "done" | "timeout";

/**
 * `router.refresh()` の代わり(管理画面の速さ CE-R9。仕組みと理由は `lib/refresh-wait.ts`)。読み直しを始め、画面に反映されたら解決する Promise を返す。
 * その間に押した遷移(AppLink)・節の切り替え(settings-section)は、反映の後に回る。
 *
 * 反映の終わりは useTransition で知る: vinext の refresh は、呼んだ同じ処理の中で router の状態を Promise にして(反映まで suspend する)、
 * 反映のときにその Promise を解く。その更新は呼び出し元の transition に入るので、`isPending` は refresh が画面に反映された commit で false になる。
 * 呼び出し元が消えたとき(unmount)は待ちを終える(回した操作は走る)。
 * 消えた後に呼ばれたら、`router.refresh()` を呼ばずに "done" で解決する(遷移で移った先の画面を取り直さないため)
 */
export function useRefreshAndWait(): () => Promise<RefreshResult> {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  /** 今の読み直し。seenPending = isPending が true になったのを見た(false に戻ったら反映が済んだ) */
  const current = useRef<{ handle: RefreshHandle; resolve: (r: RefreshResult) => void; seenPending: boolean } | null>(null);
  /** 最後に描いた時点の isPending(読み直しを始める関数が、古い値を閉じ込めないように ref で持つ) */
  const isPendingRef = useRef(false);
  const mounted = useRef(true);

  /** 読み直しを待つのをやめる(部品が消えた・同じ部品が次を始めた)。自分の待ちだけを外し、Promise は "done" で解決する */
  const abandon = useCallback((c: typeof current.current) => {
    if (!c) return;
    if (current.current === c) current.current = null;
    c.handle.cancel();
    c.resolve("done");
  }, []);

  useEffect(() => {
    isPendingRef.current = isPending;
    const c = current.current;
    if (!c) return;
    if (isPending) c.seenPending = true;
    else if (c.seenPending) c.handle();
  }, [isPending]);

  useEffect(() => {
    // StrictMode は effect を cleanup してからもう一度走らせるので、走らせるたびに true に戻す
    mounted.current = true;
    return () => {
      mounted.current = false;
      // 自分の待ちだけを外す(handle() だと、ほかの部品の前の読み直しまで終えて、その反映の前に回した遷移が走ってしまう)
      abandon(current.current);
    };
  }, [abandon]);

  return useCallback((): Promise<RefreshResult> => {
    if (!mounted.current) return Promise.resolve("done");
    return new Promise<RefreshResult>((resolve) => {
      const prev = current.current;
      // 前の transition が終わらないまま(10 秒の打ち切りの後など)次の読み直しを始めるとき、isPending は true のまま続く。
      // その場合は「その後に false に戻った」ことを終わりとみなすので、始める時点の値で初期化する
      const handle = beginRefresh({
        onEnd: (reason) => {
          // この部品の最新の読み直しが終わったときだけ、書き込み成功の印を消す(前の読み直しを外した後に消すと、今の保存の印まで消える)。
          // onEnd は後から呼ばれるので、下で作る c を参照してよい
          if (current.current === c) {
            current.current = null;
            clearWriteSucceeded();
          }
          resolve(reason === "timeout" ? "timeout" : "done");
        },
      });
      const c = { handle, resolve, seenPending: isPendingRef.current };
      current.current = c;
      // 新しい読み直しを始めてから前のを外す(順が逆だと、待ちが 0 になって回した遷移が間に走ってしまう)
      abandon(prev);
      startTransition(() => router.refresh());
    });
  }, [router, abandon]);
}
