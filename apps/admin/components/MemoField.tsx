"use client";
import { useLayoutEffect, useRef } from "react";

const MEMO_MAX = 1000;

/**
 * メモ(B77 Q26〜Q29。API は description)。外部には出さない社内用の欄で、状態にかかわらず編集できる(閉じるのは呼び出し側の disabled)。
 * textarea は本文のフォント(管理画面の textarea の既定は等幅)で、高さは書いた分だけ伸びる
 */
export function MemoField({ value, onChange, disabled, placeholder }: { value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // 値が変わるたびに(最初の表示・入力・破棄で戻したときも)内容の高さに合わせる。枠線の分 2px を足してスクロールバーを出さない
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    // 字数は欄の右下(名前の欄と同じ並び)
    <div className="row" style={{ alignItems: "flex-end", flexWrap: "nowrap", marginBottom: 14 }}>
      <label className="field" style={{ flex: 1, minWidth: 0, marginBottom: 0 }}>
        <span className="field-label">メモ(社内用。外部には出力されません)</span>
        <textarea
          ref={ref}
          value={value}
          maxLength={MEMO_MAX}
          disabled={disabled}
          placeholder={placeholder}
          style={{ fontFamily: "inherit", fontSize: "inherit", lineHeight: 1.6, minHeight: 72, resize: "vertical" }}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <span className="muted num" style={{ color: "var(--faint)", fontSize: 12 }}>
        {value.length} / {MEMO_MAX}
      </span>
    </div>
  );
}
