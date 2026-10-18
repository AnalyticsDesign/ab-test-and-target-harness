"use client";
import type { ReactNode } from "react";
import styles from "./ExtraEditor.module.css";

/**
 * エクスペリエンス / パターン共通の外部計測の追加の値(analytics の `extra`)の編集(spec §10.9)。1 つの欄は最大 20 キー、値は 1〜100 字。
 * rowMark = 行の印(「上書き」など。キーで決める)、errors = キーごとの値のエラー(analyticsValueErrors の message)、
 * footer = 「追加」の横に置くもの(「出力するキー n / 20」)
 */
export function ExtraEditor({
  value,
  onChange,
  disabled,
  rowMark,
  errors,
  footer,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  disabled?: boolean;
  rowMark?: (key: string) => ReactNode;
  errors?: Record<string, string>;
  footer?: ReactNode;
}) {
  const entries = Object.entries(value);
  return (
    <div className={styles.wrap}>
      {entries.length > 0 ? (
        <div className={styles.rows}>
          {entries.map(([k, v], i) => (
            <div className={styles.kv} key={i}>
              <input
                aria-label="キー"
                placeholder="キー(英字始まり・英数字と _)"
                value={k}
                disabled={disabled}
                pattern="[A-Za-z][A-Za-z0-9_]{0,39}"
                onChange={(e) => {
                  const next = entries.slice();
                  next[i] = [e.target.value, v];
                  onChange(Object.fromEntries(next));
                }}
              />
              <input
                aria-label={k ? `${k} の値` : "値"}
                aria-invalid={errors?.[k] ? true : undefined}
                placeholder="値(1〜100 字)"
                value={v}
                disabled={disabled}
                maxLength={100}
                onChange={(e) => {
                  const next = entries.slice();
                  next[i] = [k, e.target.value];
                  onChange(Object.fromEntries(next));
                }}
              />
              <span className={styles.act}>
                {rowMark?.(k)}
                <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))}>
                  削除
                </button>
              </span>
              {errors?.[k] ? (
                <span role="alert" className={`field-error ${styles.error}`}>
                  {errors[k]}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className={styles.addRow}>
        <button type="button" className="btn btn-sm btn-ghost" disabled={disabled || entries.length >= 20} onClick={() => onChange({ ...value, "": "" })}>
          追加
        </button>
        {footer}
      </div>
    </div>
  );
}
