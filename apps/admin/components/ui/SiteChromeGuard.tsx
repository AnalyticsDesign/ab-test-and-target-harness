"use client";
import { useMemo, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { useFeedbackSelector } from "@/lib/use-feedback";
import { selectScopeSkeleton } from "@/lib/feedback-store";
import styles from "./TopBar.module.css";

/**
 * サイトの画面の上部バーと 2 つの帯(`app/w/[wid]/sites/[sid]/layout.tsx` が描く)を、今の URL のサイトと照らす(管理画面の速さ・最終レビュー CX-R1 の案 C)。
 *
 * vinext(1.0.0-beta.10)の読み込み中の枠(optimistic route shell)は、経路の定義だけを鍵に覚え、params を照らさない
 * (`app-optimistic-routing.js`)。そのため、サイト A で覚えた枠の layout(上部バーのサイト名・ワークスペース名・公開のリンク)が、
 * サイト B への遷移で B の応答が届くまで出ることがある(e2e/shell-reuse.spec.ts で再現)。
 * 枠を描いた時点で URL は移動先に変わり、`useParams()` は移動先の wid・sid を返す。描いたときの wid・sid(props)と違えば、
 * 中身を出さず、上部バーと同じ高さの空の帯を出す。B の応答が届くと layout が B の値で描き直され、照らし合いが合って中身に戻る。
 * - 同じサイトの中の遷移では今までどおり(値が合うので何も変えない)
 * - 帯(配信ポインタの未収束・配信ファイルの警告)は高さが一定でないので、合わない間は出さない
 * - useParams() が null(ルーターの外。単体テストなど)のときは照らせないので中身を出す
 * - control への問い合わせは増えない(クライアントで params を読むだけ)
 * - B173 第 1 段: 見せる状態の遷移(押してから 150 ms 後。lib/feedback-store.ts)の行き先が別のサイト・ワークスペースなら、URL がまだ移っていなくても帯にする
 *   (loading.tsx の無い画面への遷移では、届くまで前の画面と上部バーが残るため)。TopBar の中の ChromeScopeGuard と同じ条件で、
 *   こちらは上の 2 つの帯も一緒に隠す
 */
export function SiteChromeGuard({ wid, sid, children }: { wid: string; sid: string; children: ReactNode }) {
  const params = useParams<{ wid?: string | string[]; sid?: string | string[] }>();
  // hook は分かれ道の前で呼ぶ(呼ぶ数を描画ごとに変えない)
  const select = useMemo(() => selectScopeSkeleton({ wid, sid }), [wid, sid]);
  const navElsewhere = useFeedbackSelector(select);
  if (params === null) return <>{children}</>;
  const curWid = typeof params.wid === "string" ? params.wid : "";
  const curSid = typeof params.sid === "string" ? params.sid : "";
  if (curWid === wid && curSid === sid && !navElsewhere) return <>{children}</>;
  // 描いた値と今の URL の値は、E2E が「枠を描いた時点で useParams() が移動先を返す」ことを確かめるために出す(どちらも URL に見えている ID だけ)
  return <div className={styles.bar} aria-hidden="true" data-testid="topbar-skeleton" data-rendered-site={`${wid}/${sid}`} data-current-site={`${curWid}/${curSid}`} />;
}
