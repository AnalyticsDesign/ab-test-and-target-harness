/**
 * ブラウザの戻る・進むの前の確認の土台(B173 第 1 段 Task 8。Q17・Q21)。root layout の <head> にインラインのスクリプトとして置く(POPSTATE_GUARD_SCRIPT)。
 *
 * popstate は止められない(URL は既に移っている)ので、移った先が守る画面でなければ、vinext の popstate の処理より先に受けて
 * stopImmediatePropagation で vinext に知らせず、history.go(delta) で元の項目に戻してから、確認を出す(PageLeaveGuard)。
 * 戻す幅 delta を出すため、履歴の項目ごとに連続の位置の番号(__wttPos)を state に書き足す。vinext の番号(__vinext_historyIndex)は
 * 戻った後に別の画面を開くと「最大 + 1」になり、実際の位置とずれるので使えない(2026-11-02 のスパイク)。
 *
 * installPopstateGuard は文字列にして <head> に埋めるので、外の変数・import を参照しない(関数の中だけで閉じる)。
 * 包んだ関数の書き方も、ビルドで補助の関数に置き換えられうる構文(object の spread など)を避けている。
 * React からは popstateGuard() で window に置いた API を読む
 */

export type PopstateBlock = { delta: number; href: string };
export type PopstateGuardApi = {
  /** 守りを付ける。その時点の位置・pathname を「付けた位置」として覚える。vinext より後に読み込まれた文書では何もしない */
  arm(onBlock: (b: PopstateBlock) => void): void;
  disarm(): void;
  /** 守りを外して、止めた移動をやり直す(history.go(-delta)) */
  proceed(delta: number): void;
  /** vinext のモジュールより後に読み込まれたか(この文書では戻る・進むを止められない) */
  lateInstall: boolean;
};

export function installPopstateGuard(win: Window): void {
  // 文字列にして埋める関数なので、型の import を使わず any で扱う
  const w = win as any;
  if (w.__wttPopstateGuard) return; // 二度目の読み込みでは包み直さない(番号が 2 つ進むのを防ぐ)
  const KEY = "__wttPos";
  const h = w.history;

  /** state に書いた位置の番号。0 以上の安全な整数でなければ null(番号の読めない項目は止めない) */
  function posOf(state: unknown): number | null {
    const p = state !== null && typeof state === "object" ? (state as Record<string, unknown>)[KEY] : undefined;
    return typeof p === "number" && Number.isSafeInteger(p) && p >= 0 ? p : null;
  }
  /** state の写しに番号を書き足す。object でない state はそのまま通す(vinext の state は object) */
  function withPos(state: unknown, pos: number): unknown {
    if (state === null || typeof state !== "object") return state;
    const copy = Object.assign({}, state) as Record<string, unknown>;
    copy[KEY] = pos;
    return copy;
  }

  // vinext 1.0.0-beta.10 の内部の値。名前が変わると差し替えが効かず、位置の番号が付かない項目は守りが素通りする(壊さない)。
  // vinext はモジュールの読み込みの時点で元の pushState・replaceState をここに 1 回だけ握り、遷移の書き込みではそれを呼ぶたびに引いて直接呼ぶ。
  // CSS の読み込みが遅いと、vinext のモジュールがこのスクリプトより先に走る(インラインの script は先の stylesheet を待つため)
  const vinextState = w[Symbol.for("vinext.clientNavigationState")];
  const lateInstall = !!vinextState && typeof vinextState.originalPushState === "function" && typeof vinextState.originalReplaceState === "function";
  const rawPush = lateInstall ? vinextState.originalPushState : h.pushState;
  const rawReplace = lateInstall ? vinextState.originalReplaceState : h.replaceState;

  /** 今の位置 */
  let cur = 0;
  /**
   * 位置の番号の連続を信頼できなくなった印(最終レビュー FR-Medium-2)。守りのスクリプトを通らずに積まれた項目
   * (vinext の内部名が変わり、握られた素の関数で書かれた項目など)があると、cur が実際の位置からずれ、history.go(delta) が別の項目へ戻す。
   * 一度立てたら、この文書の間は守りを付けない(素通り)。lateInstall と同じく「壊さない向き」に倒す
   */
  let untrusted = false;
  const initial = posOf(h.state);
  if (initial === null) {
    // 読み込みの最初の項目に 0 を書き足す(無いと、最初の画面へ戻る移動が番号の無い項目として素通りする)。
    // state が null(新しい文書)なら { __wttPos: 0 } だけを書く。ほかの型の state は触らない
    const s = h.state;
    if (s === null || s === undefined) rawReplace.call(h, withPos({}, 0), "");
    else if (typeof s === "object") rawReplace.call(h, withPos(s, 0), "");
  } else {
    cur = initial; // 再読み込み・別の文書から戻ってきたときは、項目に残る番号を引き継ぐ
  }

  function wrap(raw: (data: unknown, unused: string, url?: string | URL | null) => void, isPush: boolean) {
    return function wrappedHistoryWrite(data: unknown, unused: string, url?: string | URL | null) {
      // 今の項目に自分の番号が無い・cur と違う = ここを通らずに積まれた項目の上にいる(かもしれない)。state が object でない(null・文字列)
      // 項目も同じに扱う: 番号を書けないので、ここを通ったのか通らずに積まれたのかを見分けられない。信頼できないときは素通りに倒す
      // (vinext の state は object なので、ふだんの経路ではここに来ない。最終レビューの直しの差分のレビュー)
      if (posOf(h.state) !== cur) {
        // 付いている守りも外す(付けた位置は古い数え方なので、この後の差は当てにならない)。armed・onBlock は下で宣言するが、
        // この関数が呼ばれるのは install の後なので、宣言は済んでいる
        untrusted = true;
        armed = false;
        onBlock = null;
      }
      // push は「今の位置 + 1」、replace は「今の位置」。object でない state でも push は位置を進める(後の項目の番号を実際の位置にそろえる)
      const pos = isPush ? cur + 1 : cur;
      raw.call(h, withPos(data, pos), unused, url);
      cur = pos;
    };
  }
  if (lateInstall) {
    // history.* は vinext の関数で、中で originalPushState を引いて呼ぶ。両方包むと番号が 2 つ進むので、握られた元の関数だけを差し替える
    vinextState.originalPushState = wrap(rawPush, true);
    vinextState.originalReplaceState = wrap(rawReplace, false);
  } else {
    // vinext は後でこの包んだ関数を「元の関数」として握るので、vinext の書き込みもすべてここを通る
    h.pushState = wrap(rawPush, true);
    h.replaceState = wrap(rawReplace, false);
  }

  let armed = false;
  let armedPos = 0;
  let armedPath = "";
  let onBlock: ((b: PopstateBlock) => void) | null = null;
  /** 自分の history.go(delta) の戻しを待っている間 true。次の popstate で必ず外す(戻しが来なくても守りが固まらないように) */
  let reverting = false;

  // capture で付ける: window が的のイベントでは capture の listener が先に呼ばれるので、位置の追従は常に vinext の処理より先になる。
  // ただし vinext より後に読み込まれたとき、capture でも vinext の listener より先に走らないことがある(Q13 のスパイク)ので、その文書では守りを付けない(arm)
  w.addEventListener(
    "popstate",
    function onPopstate(e: PopStateEvent) {
      const pos = posOf(e.state);
      // 番号の無い項目へ移った: その項目がどこにあるか分からないので、以後は位置の差で戻さない
      if (pos === null) {
        untrusted = true;
        armed = false;
        onBlock = null;
      }
      if (reverting) {
        reverting = false;
        if (pos !== null && pos === armedPos) {
          // 自分の戻しの popstate。vinext に知らせない(知らせると戻した画面を描き直しに行く)
          e.stopImmediatePropagation();
          cur = pos;
          return;
        }
      }
      if (armed && !untrusted && pos !== null) {
        const delta = armedPos - pos;
        if (delta !== 0 && w.location.pathname !== armedPath) {
          e.stopImmediatePropagation();
          const href: string = w.location.href;
          cur = pos;
          reverting = true;
          h.go(delta);
          if (onBlock) onBlock({ delta: delta, href: href });
          return;
        }
      }
      // 素通り: 番号が読めない・差が 0・同じ pathname(検索だけ違う項目)。付けた位置は移った先に替える
      if (pos !== null) {
        cur = pos;
        if (armed) armedPos = pos;
      }
      if (armed) armedPath = w.location.pathname;
    },
    true,
  );

  const api: PopstateGuardApi = {
    arm: function (cb) {
      if (lateInstall || untrusted) return;
      // 付ける位置は今の項目に書いた番号から取る(古い cur を信じない)。番号が無い・cur と違えば、連続を信頼できないので付けない
      const here = posOf(h.state);
      if (here === null || here !== cur) {
        untrusted = true;
        return;
      }
      armed = true;
      armedPos = here;
      armedPath = w.location.pathname;
      onBlock = cb;
    },
    disarm: function () {
      armed = false;
      onBlock = null;
    },
    proceed: function (delta) {
      armed = false;
      onBlock = null;
      h.go(-delta);
    },
    lateInstall: lateInstall,
  };
  w.__wttPopstateGuard = api;
}

/** root layout の <head> に置くインラインのスクリプト(THEME_INIT_SCRIPT の次。vinext の JS より先に走らせたいので、できるだけ前に置く) */
export const POPSTATE_GUARD_SCRIPT = `(${installPopstateGuard.toString()})(window)`;

/** window に置いた守りの API。サーバー・スクリプトの無い環境では null */
export function popstateGuard(): PopstateGuardApi | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { __wttPopstateGuard?: PopstateGuardApi }).__wttPopstateGuard ?? null) as PopstateGuardApi | null;
}
