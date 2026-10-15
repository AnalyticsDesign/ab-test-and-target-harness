"use client";
import type { ReactNode } from "react";
import { COND_META, dslHasHistory, defaultCond, typeOptions, usesHistory } from "@/lib/conditions";
import type { Cond, CondType } from "@/lib/targeting-tree";
import { Picker } from "../ui/Picker";
import { ConditionFields, type RowCtx } from "./ConditionFields";
import styles from "./Targeting.module.css";

export type { RowCtx };

/**
 * 条件の行(オーディエンスの作成画面とエクスペリエンスの配信条件で共通。設計書 §12): つまみ → 種類 → 値 → 演算子 → 履歴の印・追加のボタン・削除。
 * extra = アクセシビリティ設定がオンのときの ↑↓・移動先など(呼び手が渡す)
 */
export function ConditionRow({ cond, onChange, onRemove, ctx, handle, extra }: { cond: Cond; onChange: (c: Cond) => void; onRemove: () => void; ctx: RowCtx; handle?: ReactNode; extra?: ReactNode }) {
  const history = usesHistory(cond, (id) => dslHasHistory(ctx.audiences.find((a) => a.id === id)?.definition));
  return (
    <div className={styles.row} data-testid="condition-row">
      {handle}
      <Picker
        label="条件の種類"
        value={cond.type}
        disabled={ctx.disabled}
        options={typeOptions(ctx.allowAudience)}
        onChange={(t) => onChange(defaultCond(t as CondType, { goal: ctx.goals[0]?.id, audience: ctx.audiences[0]?.id }, cond.id))}
      />
      <ConditionFields cond={cond} onChange={onChange} ctx={ctx} />
      <span className={styles.tail}>
        {history ? (
          <span className={styles.histTag} title="訪問者の履歴を使う条件です。使うと表示のたびにサーバーへ問い合わせます">
            履歴
          </span>
        ) : null}
        {extra}
        {ctx.disabled ? null : (
          <button type="button" className={styles.iconButton} aria-label={`「${COND_META[cond.type].label}」の条件を削除`} onClick={onRemove}>
            ×
          </button>
        )}
      </span>
    </div>
  );
}
