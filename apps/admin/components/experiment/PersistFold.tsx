"use client";
import { PERSIST_HINT } from "@/lib/test-locks";
import { Field } from "../Field";
import styles from "./Delivery.module.css";

/**
 * 割当の固定を畳んだ行(B69 spec §7.1)。見出しの行に今の値(オン / オフ)と使いどころだけを出し、開くとチェックボックスと PERSIST_HINT。
 * 開閉は保存しない(毎回畳んで開く)。lockMessage(テストの開始後など)があるときは、理由が見えるように開いた状態で出す
 */
export function PersistFold({ checked, disabled, lockMessage, onChange }: { checked: boolean; disabled: boolean; lockMessage: string | null; onChange: (v: boolean) => void }) {
  return (
    <details className={styles.fold} open={lockMessage !== null || undefined}>
      <summary>
        割当の固定: <b>{checked ? "オン" : "オフ"}</b> <span className="muted">— 配信率を後から下げるときの設定</span>
      </summary>
      <div className={styles.foldBody}>
        <Field
          label="割当の固定"
          hint={
            <>
              {PERSIST_HINT}
              {lockMessage ? <span style={{ display: "block", marginTop: 4 }}>{lockMessage}</span> : null}
            </>
          }
        >
          <span className="row">
            <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> 有効
          </span>
        </Field>
      </div>
    </details>
  );
}
