"use client";
import { useEffect, useId, useRef } from "react";
import { HELP, HELP_KEYS } from "@/generated/help.ja";
import { RELEASE_VERSION } from "@/generated/release";
import { useHelp } from "./HelpProvider";
import styles from "./HelpPanel.module.css";

/**
 * 右のヘルプパネル「結果の読み方」(設計書 §11.1)。原稿(docs/experiment-results.md)の全項目を原稿の順に並べ、
 * 開いた項目まで送って強調する。Esc と「閉じる」で閉じ、フォーカスはパネルを開いた「?」に戻る(HelpProvider)。
 * 本文の HTML は scripts/help-lib.mjs が許した書式だけで作ったもの(生の HTML は文字として出る)なので、そのまま入れる
 */
export function HelpPanel() {
  const { panelKey, closePanel } = useHelp();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const items = useRef(new Map<string, HTMLElement>());

  // 開いたとき・別の項目から開き直したとき: その項目まで送り、閉じるボタンにフォーカスを置く
  useEffect(() => {
    if (panelKey === null) return;
    items.current.get(panelKey)?.scrollIntoView({ block: "start" });
    closeRef.current?.focus();
  }, [panelKey]);

  // Esc で閉じる。吹き出し(HelpTip)が先に Esc を受けて閉じたとき(defaultPrevented)はパネルを閉じない
  useEffect(() => {
    if (panelKey === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelKey, closePanel]);

  if (panelKey === null) return null;
  return (
    <aside className={styles.panel} aria-labelledby={titleId} data-testid="help-panel">
      <div className={styles.panelHead}>
        <h2 id={titleId}>結果の読み方</h2>
        <button ref={closeRef} type="button" className={styles.close} aria-label="閉じる" onClick={closePanel}>
          ×
        </button>
      </div>
      <div className={styles.panelBody}>
        {HELP_KEYS.map((key) => {
          const h = HELP[key];
          if (!h) return null;
          return (
            <section
              key={key}
              ref={(el) => {
                if (el) items.current.set(key, el);
                else items.current.delete(key);
              }}
              className={key === panelKey ? `${styles.item} ${styles.hit}` : styles.item}
              data-help-item={key}
              aria-current={key === panelKey ? "true" : undefined}
            >
              <h3>{h.title}</h3>
              <p className={styles.summary}>{h.summary}</p>
              {h.bodyHtml ? <div className={styles.html} dangerouslySetInnerHTML={{ __html: h.bodyHtml }} /> : null}
            </section>
          );
        })}
      </div>
      <div className={styles.panelFoot}>
        この説明は管理画面と同じ版({RELEASE_VERSION})に含まれています。表示中の言語: 日本語
      </div>
    </aside>
  );
}
