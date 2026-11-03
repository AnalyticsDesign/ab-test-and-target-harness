"use client";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { nextRemembered, type RememberedOrigin } from "@/lib/nav";
import { URL_PARAM_EVENT } from "@/lib/url-state";
import type { WorkspaceSummary } from "@/lib/types";

/**
 * 設定を開いた場所の記憶(B60)と、サイドバーが読む summary(全ワークスペースのサイト一覧)。外枠(app/w/layout.tsx)に 1 つだけ置く。
 *
 * 記憶は押した側(リンクの onClick)では書かず、画面が移るたびに直前の pathname + search と今のものから決める(lib/nav.ts の nextRemembered)。
 * 離脱の確認(components/ui/useLeaveGuard.ts)は capture でクリックを止めるので、onClick が走らない経路でも記憶がずれないようにするため
 */
type SettingsOriginValue = { remembered: RememberedOrigin | null; workspaces: WorkspaceSummary[] };

// provider の外で呼ばれても壊れないよう、既定値は「記憶なし・一覧なし」
const SettingsOriginContext = createContext<SettingsOriginValue>({ remembered: null, workspaces: [] });
// summary を差し替える口。読む側(useSettingsOrigin)には出さず、SummarySync だけが使う
const SetWorkspacesContext = createContext<(next: WorkspaceSummary[]) => void>(() => {});

/** 同じ中身なら前の配列を保つ(server component から来る props は描画のたびに新しい配列になり、そのままだと無駄に描き直す) */
function keepIfSame(prev: WorkspaceSummary[], next: WorkspaceSummary[]): WorkspaceSummary[] {
  return prev === next || JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

export function SettingsOriginProvider({ summary, children }: { summary: WorkspaceSummary[]; children: ReactNode }) {
  const pathname = usePathname();
  // 画面の移動(pathname・search の変化)は usePathname / useSearchParams で知る。/w 配下は requireUser が cookie を読む動的な画面なので、vinext では Suspense は要らない。
  // ただし replaceParam(lib/url-state.ts)で画面の中から書き換えた search(タブ・絞り込み)は、vinext がこの 2 つに知らせない。
  // そちらは下の align で、直前の画面(prevPath)を window.location から読み直す
  const search = useSearchParams().toString();
  const current = search ? `${pathname}?${search}` : pathname;

  // 最初の描画は「直前の画面なし」(直リンク・再読み込み)= 今の画面から決まる縮んだ形。サーバーの描画と同じ値になる
  const [remembered, setRemembered] = useState<RememberedOrigin | null>(() => nextRemembered(null, null, current));
  const prevPath = useRef(current);
  // useLayoutEffect: 記憶の更新を、新しい画面と同じ描画(画面に出る前)に間に合わせる。useEffect だと 1 回だけ古い記憶で描かれ、メニューが跳ねる
  useLayoutEffect(() => {
    const from = prevPath.current;
    if (from === current) return; // StrictMode の 2 回目の実行・同じ値での再描画では何もしない
    prevPath.current = current;
    setRemembered((prev) => nextRemembered(prev, from, current));
  }, [current]);
  // prevPath(= 次の移動の fromPath = 設定を開いたときの「戻る」の行き先)を、今の画面の実際の URL(window.location)にそろえる。記憶そのものは変えない。
  // 上の hook の値は replaceParam で書き換えた search を知らないため(画面の中のタブ・絞り込み・通知の印の消去)。そろえる時機は 3 つ:
  // - URL_PARAM_EVENT(replaceParam が URL を書いた直後)
  // - クリック(window の capture = 画面のどの処理よりも先。押した時点の location は移る前の画面そのもの)。replaceParam の後に
  //   search の無い同じ pathname へ移ったときは、vinext の search の値が古いまま変わらず上の effect が走らないので、次のクリックでここが直す
  // - 登録の直後に 1 回(登録より前に走った replaceParam の分)
  // 移動の描画の中(上の effect)では location を読まない: vinext は新しい画面を描いて layout effect を走らせた後に URL を書く(pushState)ので、
  // その時点の location は移る前の URL のまま。pathname が prevPath と違う location(= 移動の途中・/w の外から入った直後)も読まない。
  // useLayoutEffect で登録するのは、子の passive effect(例: DuplicatedNotice の mount 時の replaceParam)より先に受けるため
  useLayoutEffect(() => {
    const align = () => {
      const { pathname: p, search: s } = window.location;
      if (p === prevPath.current.split("?", 1)[0]) prevPath.current = `${p}${s}`;
    };
    align();
    window.addEventListener(URL_PARAM_EVENT, align);
    window.addEventListener("click", align, true);
    return () => {
      window.removeEventListener(URL_PARAM_EVENT, align);
      window.removeEventListener("click", align, true);
    };
  }, []);

  const [workspaces, setWorkspacesState] = useState(summary);
  const setWorkspaces = useCallback((next: WorkspaceSummary[]) => setWorkspacesState((prev) => keepIfSame(prev, next)), []);
  // この layout がサーバーで描き直されたとき(router.refresh 等)は、新しく読んだ summary を使う
  useLayoutEffect(() => setWorkspaces(summary), [summary, setWorkspaces]);

  const value = useMemo(() => ({ remembered, workspaces }), [remembered, workspaces]);
  return (
    <SetWorkspacesContext.Provider value={setWorkspaces}>
      <SettingsOriginContext.Provider value={value}>{children}</SettingsOriginContext.Provider>
    </SetWorkspacesContext.Provider>
  );
}

/** 設定を開いた場所の記憶と summary を読む(読むだけ。記憶は provider が画面の移動から決める) */
export function useSettingsOrigin(): SettingsOriginValue {
  return useContext(SettingsOriginContext);
}

/**
 * provider の summary を、渡されたものに置き換える(何も描かない)。`app/w/[wid]/layout.tsx` が置く。
 * 外枠の layout(app/w/layout.tsx)はクライアント遷移で描き直されないので、そこで最初に読んだ summary は古くなりうる
 * (components/settings/DangerZone.tsx の実測の記録)。`[wid]` が変わる遷移ではこの layout が描き直されるので、ここで新しいものにする
 */
export function SummarySync({ summary }: { summary: WorkspaceSummary[] }) {
  const setWorkspaces = useContext(SetWorkspacesContext);
  useLayoutEffect(() => setWorkspaces(summary), [summary, setWorkspaces]);
  return null;
}
