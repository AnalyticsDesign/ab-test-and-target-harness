/** 設計書 3 節: テーマはブラウザの localStorage にだけ持つ(人ごと・端末ごとの好み。サーバーには送らない) */
export type Theme = "light" | "dark" | "system";
export const THEME_KEY = "wtt-theme";

export function normalizeTheme(v: unknown): Theme {
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

/** `applyTheme` が触る document の最小の形(テストで差し替えるため。実ブラウザでは `document` をそのまま渡す) */
export type ThemeDocument = {
  documentElement: { setAttribute: (name: string, value: string) => void; removeAttribute: (name: string) => void };
  startViewTransition?: (update: () => void) => unknown;
};

/**
 * テーマを画面に当てる。light / dark は `data-theme`、system は属性を外して CSS の prefers-color-scheme に任せる。
 * ブラウザが View Transitions API を持っていれば、その中で属性を変えて配色をクロスフェードさせる(時間は globals.css の
 * `::view-transition-*` 側)。無ければ即時に切り替わる。どちらでも結果の DOM は同じ
 */
export function applyTheme(next: Theme, doc: ThemeDocument): void {
  const update = () => {
    if (next === "system") doc.documentElement.removeAttribute("data-theme");
    else doc.documentElement.setAttribute("data-theme", next);
  };
  if (typeof doc.startViewTransition === "function") doc.startViewTransition(update);
  else update();
}

/**
 * 保存したテーマ(light / dark)を `data-theme` に付け直す。クロスフェードはしない(ハイドレーションの直後に呼ぶため)。
 * ハイドレーションの不一致で root が描き直されると、inline script が付けた `data-theme` が外れて OS の設定に戻る
 * (backlog B44)。原因の側(時刻の描画)は LocalTime で直したが、ほかの不一致が入っても選んだテーマを保つための守り。
 * system・未設定・読めないときは何もしない(属性が無い = CSS の prefers-color-scheme に従う)。
 * storage は関数で受け取る: サイトデータを拒否したブラウザでは `localStorage` を読んだ時点で SecurityError になるため、
 * 参照そのものを try の中で行う(root layout から呼ぶので、投げると管理画面全体がエラー画面になる)
 */
export function resyncStoredTheme(getStorage: () => { getItem: (key: string) => string | null }, doc: ThemeDocument): void {
  let stored: string | null;
  try {
    stored = getStorage().getItem(THEME_KEY);
  } catch {
    return;
  }
  if (stored === "light" || stored === "dark") doc.documentElement.setAttribute("data-theme", stored);
}

/**
 * 初回描画のちらつき防止。<head> の inline script として実行する。
 * light / dark のときだけ data-theme を付け、それ以外(system・未設定・読めない)は付けない = CSS の prefers-color-scheme に従う
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
