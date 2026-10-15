"use client";
import { useEffect, useState } from "react";
import { setDragAlternatives, useDragAlternatives } from "@/lib/a11y";
import { THEME_KEY, applyTheme, normalizeTheme, type Theme } from "@/lib/theme";
import { Icon, type IconName } from "../ui/Icon";
import styles from "./DisplaySettings.module.css";

const THEMES: Array<{ value: Theme; icon: IconName; label: string }> = [
  { value: "light", icon: "sun", label: "ライト" },
  { value: "dark", icon: "moon", label: "ダーク" },
  { value: "system", icon: "monitor", label: "システムに合わせる" },
];

/**
 * 設定 > 画面表示(決定 54 (7))= テーマ + アクセシビリティ。どちらもこのブラウザの localStorage にだけ保存する(今までと同じ)。
 * 初期描画では「システムに合わせる」が選択中に見え、マウント後に保存値へ切り替わる(配色は <head> の inline script が先に当てている)
 */
export function DisplaySettings() {
  const [theme, setTheme] = useState<Theme>("system");
  const dragAlt = useDragAlternatives();
  useEffect(() => {
    try {
      setTheme(normalizeTheme(localStorage.getItem(THEME_KEY)));
    } catch {
      /* 既定の system のまま */
    }
  }, []);
  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next, document); // 対応ブラウザでは配色がクロスフェードする
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* 保存できなくても表示は切り替わっている */
    }
  }
  return (
    <div>
      <p className="muted">この画面の設定は、このブラウザだけに保存されます。別のブラウザや PC では、そこでもう一度設定してください。</p>
      <section className="card">
        <h2>テーマ</h2>
        <p className="muted">管理画面の配色</p>
        <fieldset className={styles.themes}>
          <legend className="visually-hidden">テーマ</legend>
          {THEMES.map((o) => (
            <label key={o.value} className={styles.theme}>
              <input type="radio" name="theme" value={o.value} checked={theme === o.value} onChange={() => choose(o.value)} />
              <Icon name={o.icon} />
              {o.label}
            </label>
          ))}
        </fieldset>
      </section>
      <section className="card">
        <h2>アクセシビリティ</h2>
        <label className={styles.check}>
          <input type="checkbox" checked={dragAlt} onChange={(e) => setDragAlternatives(e.target.checked)} />
          <span>
            ドラッグの代わりにボタンで操作する
            <small>オーディエンスの作成と配信条件の画面で、ドラッグの代わりに「↑ ↓」「移動先」「ここに追加」のボタンを出します。</small>
          </span>
        </label>
      </section>
    </div>
  );
}
