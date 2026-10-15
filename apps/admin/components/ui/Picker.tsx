"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import styles from "./Picker.module.css";

export type PickerOption = { value: string; label: string; disabled?: boolean; hint?: string };
export type PickerGroup = { group: string; options: PickerOption[] };
type Props = { label: string; value: string | null; options: Array<PickerOption | PickerGroup>; onChange: (value: string) => void; disabled?: boolean; placeholder?: string; className?: string; name?: string };

const flatten = (opts: Array<PickerOption | PickerGroup>): PickerOption[] => opts.flatMap((o) => ("group" in o ? o.options : [o]));

/**
 * 見た目をそろえたプルダウン(決定 49、設計書 §12。WAI-ARIA の select-only combobox)。ブラウザ標準の select の代わりに使う(B35 で全画面に広げる)。
 * フォーカスは常にこの欄にあり、一覧の中の今の行は aria-activedescendant で示す。キーボード: ↓↑ で移動(閉じていれば開く)、Home / End、
 * Enter / Space で決定(閉じていれば開く)、Esc で閉じる、Tab で閉じて次へ。外側をクリックすると閉じる。
 * 今の値が選択肢に無い(古いデータ)ときは「(使えません)」を付けてそのまま見せる
 */
export function Picker({ label, value, options, onChange, disabled, placeholder = "選択してください", className, name }: Props) {
  const id = useId();
  const flat = useMemo(() => flatten(options), [options]);
  const current = flat.findIndex((o) => o.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-o${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  /** from から dir の向きに、選べる次の行(無ければ from のまま) */
  const step = (from: number, dir: 1 | -1): number => {
    for (let i = from + dir; i >= 0 && i < flat.length; i += dir) if (!flat[i]!.disabled) return i;
    return from;
  };
  const first = () => step(-1, 1);
  const openAt = (i: number) => {
    setActive(i);
    setOpen(true);
  };
  const choose = (i: number) => {
    const o = flat[i];
    if (!o || o.disabled) return;
    setOpen(false);
    if (o.value !== value) onChange(o.value);
  };
  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (open) setActive((a) => step(a, 1));
        else openAt(current >= 0 ? current : first());
        break;
      case "ArrowUp":
        e.preventDefault();
        if (open) setActive((a) => step(a, -1));
        else openAt(current >= 0 ? current : step(flat.length, -1));
        break;
      case "Home":
        if (open) {
          e.preventDefault();
          setActive(first());
        }
        break;
      case "End":
        if (open) {
          e.preventDefault();
          setActive(step(flat.length, -1));
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (open) choose(active);
        else openAt(current >= 0 ? current : first());
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  let index = -1; // 描画の順に振る行の番号(グループをまたいで通し番号)
  const renderOption = (o: PickerOption): ReactNode => {
    index += 1;
    const i = index;
    return (
      <div
        key={`${o.value}-${i}`}
        id={`${id}-o${i}`}
        role="option"
        aria-selected={o.value === value}
        aria-disabled={o.disabled || undefined}
        className={`${styles.option} ${i === active ? styles.active : ""}`}
        onMouseEnter={() => setActive(i)}
        onMouseDown={(e) => e.preventDefault()} // フォーカスを combobox に残す
        onClick={() => choose(i)}
      >
        {o.label}
        {o.hint ? <small>{o.hint}</small> : null}
      </div>
    );
  };
  const shown = current >= 0 ? flat[current]!.label : value ? `${value}(使えません)` : null;
  return (
    <div ref={root} className={`${styles.picker} ${className ?? ""}`}>
      {/* フォームの FormData に値を載せる(K8)。disabled のときは送らない(ネイティブの select と同じ) */}
      {name ? <input type="hidden" name={name} value={value ?? ""} disabled={disabled} /> : null}
      <div
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && active >= 0 ? `${id}-o${active}` : undefined}
        aria-disabled={disabled || undefined}
        className={styles.button}
        onClick={() => {
          if (disabled) return;
          if (open) setOpen(false);
          else openAt(current >= 0 ? current : first());
        }}
        onKeyDown={onKey}
      >
        <span className={shown === null ? styles.placeholder : undefined}>{shown ?? placeholder}</span>
        <span aria-hidden="true" className={styles.caret}>
          ▾
        </span>
      </div>
      {open ? (
        <div id={`${id}-list`} role="listbox" aria-label={label} className={styles.list}>
          {options.map((o) =>
            "group" in o ? (
              <div key={o.group} role="group" aria-label={o.group}>
                <div className={styles.groupLabel} aria-hidden="true">
                  {o.group}
                </div>
                {o.options.map(renderOption)}
              </div>
            ) : (
              renderOption(o)
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
