"use client";

/** Experiment / Variant 共通の analytics `extra` key-value 編集(spec §10.9)。最大 20 キー、値 1〜100 字 */
export function ExtraEditor({ value, onChange, disabled }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; disabled?: boolean }) {
  const entries = Object.entries(value);
  return (
    <div>
      {entries.map(([k, v], i) => (
        <div className="row" key={i}>
          <input
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
          <button type="button" className="btn" disabled={disabled} onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))}>
            削除
          </button>
        </div>
      ))}
      <button type="button" className="btn" disabled={disabled || entries.length >= 20} onClick={() => onChange({ ...value, "": "" })}>
        キーを追加(最大 20)
      </button>
    </div>
  );
}
