"use client";
import { createContext, useContext } from "react";
import { useFeedbackSelector } from "@/lib/use-feedback";
import type { FeedbackSnapshot } from "@/lib/feedback-store";
import styles from "./RouteLoading.module.css";

/** 遷移の打ち切りの文言(NavGate と共通) */
export const NAV_TIMEOUT_MESSAGE = "画面を開けませんでした。再読み込みしてください";

/**
 * NavGate(本文の包み)の中か。NavGate は打ち切りのとき本文の先頭に文言を出すので、その中の RouteLoading(サイトの中の loading.tsx)は
 * 文言を重ねて出さない。NavGate の外(上部バーごと替わる画面の loading.tsx)は、自分で文言を出す
 */
export const InsideNavGate = createContext(false);

/**
 * store の遷移から決める表示の状態(基本の値なので、関わりの無い更新では描き直さない)。
 * none = 遷移が無い(直接開いた文書の流し込み・戻る/進むなど store を通らない遷移): すぐ見せる。
 * pending = 遷移が始まって 150 ms 以内: 場所は取って見せない。loading = 見せる。timedOut = 10 秒で打ち切った
 */
export type LoadingState = "none" | "pending" | "loading" | "timedOut";
export function selectLoadingState(s: FeedbackSnapshot): LoadingState {
  if (!s.nav) return "none";
  if (s.nav.timedOut) return "timedOut";
  return s.nav.visible ? "loading" : "pending";
}

/**
 * 画面の読み込み中の表示。各画面のフォルダの loading.tsx がこれを描く(管理画面の速さ A)。
 * loading.tsx のある経路で vinext(1.0.0-beta.10)は次のように振る舞う:
 * - 遷移の RSC の要求で、本描画の前のページの試しの実行を省く(server/app-page-probe.js。CPU が 1 回分減る)
 * - Link の自動先読みが、画面全体のサーバー描画ではなく、loading.tsx までの枠(layout だけ)になる(ページの control への問い合わせが消える)
 * - クリックの直後に前の画面がこの表示に替わる(届くまで前の画面のまま止まって見えない)。ただし、その経路の先読み(上の枠)を
 *   一度でも取り終えているときだけ(取った枠からこの表示を覚える)。先読みはマウスが乗ったとき等だけにしている(AppLink.tsx)
 *
 * 置く場所(request-count の E2E で比べた): いちばん効くのは app/w/loading.tsx(先読みの枠が外枠の layout だけになる)だが、置かない。
 * 境界がサイト設定の画面を含むと、サイドバーの設定のメニューが本文(フォーム)より先に出て押せるようになり、その間に押した節が
 * フォームの mount で一般の節に戻される(URL は ?section=… のまま。write-freeze の E2E で実測)。sites/[sid]/loading.tsx・[wid]/loading.tsx も同じ。
 * そのため、サイト設定を含まない画面のフォルダにだけ置く。ホーム・ワークスペースのトップ・サイトのトップは、フォルダの loading.tsx が
 * サイト設定まで含んでしまうので置かない(フォームが mount 前に選ばれた節を守るように直した後で、app/w/loading.tsx に寄せる)。
 *
 * 表示はデータを何も出さない静的な枠にする(前の画面・別のサイトの値や、権限の無い画面の中身が一瞬でも見えないように)。
 * 出る場所は 2 通り: サイトの中の画面では上部バーの下の本文(<main>)の中、それ以外(ワークスペースのメンバー・API キー、個人の設定の画面)は上部バーごと替わるので、
 * サイドバーの右の列にじかに出る。じかに出るときは、上部バーと同じ高さの空の帯を置いて本文の位置が跳ねないようにする
 * (帯と余白は RouteLoading.module.css で場所ごとに出し分ける)。
 * 保存の後の router.refresh() では出ない(vinext は refresh を transition で描き、境界の key は URL のパスから決まって変わらない)。
 * 表示は store の遷移(lib/feedback-store.ts)に従う(B173 第 1 段): 押してから 150 ms までは場所だけ取って見せず、10 秒で打ち切ったら「読み込み中…」の代わりに打ち切りの文言を出す。
 * store を通らない表示(直接開いた文書の流し込み・戻る/進む)は今までどおりすぐ見せる。
 * 試しの実行を省いた分、ページの notFound() は応答を流し始めた後に起きるので、直接開いたときの HTTP の状態は 404 ではなく 200 になる
 * (画面には今までどおり 404 の表示が出る。layout の notFound() は 404 のまま。実測)
 */
export function RouteLoading() {
  const state = useFeedbackSelector(selectLoadingState);
  const insideGate = useContext(InsideNavGate);
  if (state === "pending") {
    // 速い遷移(150 ms 以内)ではちらつかせない。場所は取る(見せる状態になったときに本文の位置が跳ねないよう)。
    // 見えない間は role・aria-busy も付けない(読み上げにも「読み込み中」を知らせない)
    return (
      <div className={styles.loading} style={{ visibility: "hidden" }} aria-hidden="true" data-nav-loading="pending">
        <div className={styles.bar} />
        <div className={styles.body} />
      </div>
    );
  }
  if (state === "timedOut") {
    // vinext が前の画面をこの枠に置き換えた後でも、打ち切りを知らせる。NavGate の中では NavGate が本文の先頭に出すので重ねない
    return (
      <div className={styles.loading}>
        <div className={styles.bar} aria-hidden="true" />
        <div className={styles.body}>
          {insideGate ? null : (
            <p role="alert" className="error-box">
              {NAV_TIMEOUT_MESSAGE}
            </p>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={styles.loading} role="status" aria-busy="true">
      <div className={styles.bar} aria-hidden="true" />
      <div className={styles.body}>
        <span className={state === "loading" ? `${styles.text} ${styles.textNow}` : styles.text}>読み込み中…</span>
      </div>
    </div>
  );
}
