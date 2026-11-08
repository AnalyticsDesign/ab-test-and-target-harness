"use client";
import type { ReactNode } from "react";
import { COND_META, dslHasHistory, defaultCond, legacyCondText, typeOptions, usesHistory } from "@/lib/conditions";
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
  if (cond.type === "legacy") return <LegacyConditionRow cond={cond} onRemove={onRemove} ctx={ctx} handle={handle} extra={extra} />;
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

/**
 * 保存値に残った、外したページの条件(URL・ホスト・パス・クエリパラメータ)の行(B69 spec §7.5)。種類・値は編集させず、警告の色で
 * 「使えなくなった」ことと移し先を示し、「この条件を消す」で消してもらう(残っている間は保存の前の確認が止める)。
 * 見出しと案内の文はエクスペリエンス(allowAudience = true)とオーディエンスで変える(spec §4 の message と同じ分け方)。種類の Picker は出さない(選択肢に無い値の識別子が画面に出るため)
 */
function LegacyConditionRow({ cond, onRemove, ctx, handle, extra }: { cond: Extract<Cond, { type: "legacy" }>; onRemove: () => void; ctx: RowCtx; handle?: ReactNode; extra?: ReactNode }) {
  return (
    <div className={`${styles.row} ${styles.unusableRow}`} data-testid="condition-row">
      {handle}
      <span className={styles.unusableBody}>
        <b>{ctx.allowAudience ? "この条件は配信条件では使えなくなりました" : "この条件はオーディエンスでは使えなくなりました"}</b>
        <code>{legacyCondText(cond.dsl)}</code>
        <span>
          {ctx.allowAudience
            ? "ページの URL・ホスト・パス・パラメータの条件は、上の「どのページで(対象 URL)」で指定します。対象 URL に移してから、この条件を消してください。このままでは保存できません"
            : "ページの URL・ホスト・パス・パラメータの条件は、エクスペリエンスの対象 URL で指定してください。このオーディエンスを使うエクスペリエンスごとに書きます。この条件を消してください。このままでは保存できません"}
        </span>
      </span>
      <span className={styles.tail}>
        {extra}
        {ctx.disabled ? null : (
          <button type="button" className={`btn ${styles.smallButton}`} onClick={onRemove}>
            この条件を消す
          </button>
        )}
      </span>
    </div>
  );
}
