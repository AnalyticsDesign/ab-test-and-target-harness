"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HELP, type HelpKey } from "@/generated/help.ja";
import { useHelp } from "./HelpProvider";
import styles from "./HelpPanel.module.css";

/**
 * 項目の横の「?」(設計書 §11.1)。押すと吹き出しに要点(原稿の見出しの直後の段落)を出し、「詳しく読む」で右のパネルを開いて
 * その項目まで送る。ホバーでは開かない。
 * - ボタンは aria-expanded を持ち、吹き出しは role="dialog"。開くと「詳しく読む」にフォーカスを置く
 * - Esc で閉じてボタンにフォーカスを戻す。外を押すと閉じる(フォーカスは動かさない)
 * - label を渡すと「?」に文字を添える(見出しの役割をする説明:「評価計画とは」など)。無ければアイコンだけ
 * helpKey は原稿にある鍵だけ(型と test/help.test.ts の、鍵が原稿にあることのテストが見る)
 */
export function HelpTip({ helpKey, label }: { helpKey: HelpKey; label?: string }) {
  const { openPanel } = useHelp();
  const entry = HELP[helpKey];
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) btnRef.current?.focus();
  }, []);

  // 位置: ボタンの下(入らなければ上)。画面の端から 16px 内側に収める(モックと同じ)。描く前(layout effect)に DOM へ直接書き、
  // 位置が決まってから「詳しく読む」にフォーカスを置く(状態にすると、フォーカスの時点ではまだ見えない)
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const btn = btnRef.current;
      const pop = popRef.current;
      if (!btn || !pop) return;
      const r = btn.getBoundingClientRect();
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const left = Math.min(Math.max(16, r.left - 12), window.innerWidth - w - 16);
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    };
    place();
    moreRef.current?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Esc(パネルより先に受ける = capture)と、外を押したとき
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // 開いているパネルは閉じない(HelpPanel が defaultPrevented を見る)
      close(true);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || btnRef.current?.contains(t))) return;
      close(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, close]);

  if (!entry) return null;
  const toggle = () => (open ? close(false) : setOpen(true));
  const readMore = () => {
    close(false);
    openPanel(helpKey, btnRef.current);
  };

  return (
    <>
      {label ? (
        <button ref={btnRef} type="button" className={styles.tipLink} aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
          <span className={styles.tip} aria-hidden="true">?</span>
          <span className={styles.label}>{label}</span>
        </button>
      ) : (
        <button ref={btnRef} type="button" className={styles.tip} aria-label={`${entry.title}の説明`} aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
          ?
        </button>
      )}
      {open
        ? createPortal(
            <div
              ref={popRef}
              role="dialog"
              aria-labelledby={titleId}
              className={styles.pop}
              data-testid="help-pop"
            >
              <h4 id={titleId}>{entry.title}</h4>
              <p>{entry.summary}</p>
              <div className={styles.popFoot}>
                <button ref={moreRef} type="button" className={styles.link} onClick={readMore}>
                  詳しく読む →
                </button>
                <button type="button" className={styles.close} aria-label="閉じる" onClick={() => close(true)}>
                  ×
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
