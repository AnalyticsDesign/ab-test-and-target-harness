"use client";
import type { PreviewLine } from "@/lib/datalayer-preview";
import styles from "./DataLayerPreview.module.css";

/** 描く 1 行: 字下げ(文字数)と、キー・値・注釈の行(line)か、括弧だけの行(text) */
type Row = { indent: number; text?: string; line?: PreviewLine; comma?: boolean };

/**
 * dataLayer の出力プレビュー(B77 K13)。`window.<名前>.push({ … });` の形で 1 行ずつ描く。値は lib/datalayer-preview が JSON.stringify の形にしてある。
 * `nested` の行(追加の値)はまとめて `extraKey: { … }` の中に入れる(並びは lib 側で、追加の値は最後)。
 * 長い値は折り返し、続きはキーの位置より 2 文字下げる
 */
export function DataLayerPreview({ lines, extraKey, dataLayerName }: { lines: PreviewLine[]; extraKey: string; dataLayerName: string }) {
  const top = lines.filter((l) => !l.nested);
  const nested = lines.filter((l) => l.nested);
  const rows: Row[] = [{ indent: 0, text: `window.${dataLayerName}.push({` }];
  top.forEach((line, i) => rows.push({ indent: 2, line, comma: i < top.length - 1 || nested.length > 0 }));
  if (nested.length > 0) {
    rows.push({ indent: 2, text: `${extraKey}: {` });
    for (const line of nested) rows.push({ indent: 4, line, comma: true });
    rows.push({ indent: 2, text: "}" });
  }
  rows.push({ indent: 0, text: "});" });
  return (
    <div className={styles.preview} data-testid="datalayer-preview">
      {rows.map((r, i) => (
        <div key={i} className={styles.ln} style={{ paddingLeft: `${r.indent + 2}ch` }}>
          {r.line ? (
            <>
              <span className={styles.k}>{r.line.key}</span>: <span className={styles.s}>{r.line.value}</span>
              {r.comma ? "," : ""}
              {r.line.note ? <span className={r.line.overridden ? `${styles.c} ${styles.over}` : styles.c}>{`  // ${r.line.note}`}</span> : null}
            </>
          ) : (
            r.text
          )}
        </div>
      ))}
    </div>
  );
}
