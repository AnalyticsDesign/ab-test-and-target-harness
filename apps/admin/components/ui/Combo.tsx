"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import styles from "./Picker.module.css";

type Item = { value: string; label: string; detail?: string };
type Props = { label: string; value: string | null; items: Item[]; onChange: (value: string) => void; disabled?: boolean; placeholder?: string; name?: string };

/**
 * 検索付きのプルダウン(決定 49、設計書 §12。オーディエンスの選択。WAI-ARIA の combobox + listbox、aria-autocomplete=list)。
 * 名前と detail(条件の要約)で絞り込む。↓↑ で移動、Enter で決定、Esc で閉じて表示を今の値に戻す。フォーカスが外れたら閉じる
 */
export function Combo({ label, value, items, onChange, disabled, placeholder = "検索", name }: Props) {
  const id = useId();
  const current = items.find((i) => i.value === value) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.label.toLowerCase().includes(q) || (i.detail ?? "").toLowerCase().includes(q)) : items;
  }, [items, query]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-o${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const choose = (i: number) => {
    const item = shown[i];
    if (!item) return;
    close();
    if (item.value !== value) onChange(item.value);
  };
  const onKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((a) => Math.min(a + 1, shown.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
        break;
      case "Enter":
        if (open) {
          e.preventDefault();
          choose(active);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          close();
        }
        break;
    }
  };
  return (
    <div className={styles.picker}>
      {/* フォームの FormData に値を載せる(K8)。disabled のときは送らない(ネイティブの select と同じ) */}
      {name ? <input type="hidden" name={name} value={value ?? ""} disabled={disabled} /> : null}
      <input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && shown.length > 0 ? `${id}-o${active}` : undefined}
        autoComplete="off"
        className={styles.input}
        disabled={disabled}
        placeholder={placeholder}
        value={open ? query : (current?.label ?? (value ? `${value}(見つかりません)` : ""))}
        onFocus={(e) => {
          setOpen(true);
          setActive(0);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onBlur={close}
        onKeyDown={onKey}
      />
      {open ? (
        <div id={`${id}-list`} role="listbox" aria-label={label} className={styles.list}>
          {shown.length === 0 ? <div className={styles.empty}>一致するものがありません</div> : null}
          {shown.map((item, i) => (
            <div
              key={item.value}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={item.value === value}
              className={`${styles.option} ${i === active ? styles.active : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              {item.label}
              {item.detail ? <small>{item.detail}</small> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
