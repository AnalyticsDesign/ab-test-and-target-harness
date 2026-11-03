"use client";
import { useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useFeedbackSelector } from "@/lib/use-feedback";
import type { FeedbackSnapshot } from "@/lib/feedback-store";
import { ErrorBox } from "@/components/ErrorBox";
import { InsideNavGate, NAV_TIMEOUT_MESSAGE, RouteLoading } from "./RouteLoading";

type GateState = "show" | "hide" | "timedOut";

/** 検索・hash を除いた pathname */
const pathOf = (url: string) => url.split(/[?#]/, 1)[0] ?? "";

/**
 * 本文を隠すか。見せる状態の遷移(押してから 150 ms を過ぎた)があり、いま描いている本文が押した画面(fromUrl の pathname)のままのときだけ隠す。
 * 行き先の木(本描画、または loading.tsx の枠)が描かれたら隠さない: 枠は RouteLoading が自分で読み込み中を出し、本描画は mount の時点で見えている必要がある
 * (隠したまま mount すると、mount で入力欄にフォーカスを移す画面(`?new=1` のワークスペースの作成など)のフォーカスが効かない。invite-flow の E2E で実測)。
 * 検索の文字列だけが違う遷移(pathname が同じ)は隠さない(押したリンクの印だけが出る)
 */
function selectGate(pathname: string): (s: FeedbackSnapshot) => GateState {
  return (s) => {
    if (!s.nav) return "show";
    if (s.nav.timedOut) return "timedOut";
    if (!s.nav.visible) return "show";
    return pathOf(s.nav.fromUrl) === pathname && pathOf(s.nav.href) !== pathname ? "hide" : "show";
  };
}

/**
 * 本文の包み(B173 第 1 段)。Content の PageEnter の中に置く。
 * - 遅い遷移で前の画面が残っている間(押してから 150 ms を過ぎた後)は、本文を hidden の <div> に入れて隠し、本文のスケルトン(RouteLoading)を出す。
 *   置き換えずに隠すのは、本文の部品の状態を壊さないため(本文の <div> は常に同じ位置に置き、hidden だけを切り替える。位置が変わると React が作り直す)
 * - 10 秒で打ち切った遷移は、本文を戻し、先頭に打ち切りの文言を出す
 * 遷移が失敗・打ち切りになったときに元の入力を戻すことは約束しない: 本文の部品は URL が変わると作り直し(PageEnter の key={pathname})、
 * loading.tsx のある経路では vinext が前の画面を読み込み中の枠に置き換えるため。離れる前の確認で「移動する」を選んだ時点で、入力は捨てたものとする
 */
export function NavGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const select = useMemo(() => selectGate(pathname), [pathname]);
  const state = useFeedbackSelector(select);
  const hide = state === "hide";
  return (
    <>
      {state === "timedOut" ? <ErrorBox message={NAV_TIMEOUT_MESSAGE} /> : null}
      {hide ? <RouteLoading /> : null}
      <div hidden={hide}>
        <InsideNavGate.Provider value>{children}</InsideNavGate.Provider>
      </div>
    </>
  );
}
