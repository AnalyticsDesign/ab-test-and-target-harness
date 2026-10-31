import styles from "./RouteLoading.module.css";

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
 * 試しの実行を省いた分、ページの notFound() は応答を流し始めた後に起きるので、直接開いたときの HTTP の状態は 404 ではなく 200 になる
 * (画面には今までどおり 404 の表示が出る。layout の notFound() は 404 のまま。実測)
 */
export function RouteLoading() {
  return (
    <div className={styles.loading} role="status" aria-busy="true">
      <div className={styles.bar} aria-hidden="true" />
      <div className={styles.body}>
        <span className={styles.text}>読み込み中…</span>
      </div>
    </div>
  );
}
