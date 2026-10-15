"use client";
import { useState } from "react";
import type { Variant } from "@/lib/types";
import type { TabProps } from "@/lib/experiment-draft";
import { variantIdIssue } from "@/lib/variant-id";
import { Field } from "../Field";
import { VariantEditor } from "../VariantEditor";
import styles from "./VariantsTab.module.css";

/**
 * 左に Variant の一覧(配分と合計)、右に選択中の Variant(設計書 4.4)。右には選んだ 1 つだけを描く。
 * variantsLocked: control の `PUT …/variants` は draft の実験にしか使えない(409 experiment_active)ので、
 * 非 draft では Variant の集合(名前・重み・追加・削除・Analytics 上書き)を編集不可にする。Change は引き続き編集できる
 */
export function VariantsTab({
  draft, set, ro, siteId, experimentId, variantsLocked, pageUrl, imageUpload, selected, onSelect, animate,
}: TabProps & { siteId: string; experimentId: string; variantsLocked: boolean; pageUrl: string | null; imageUpload: boolean; selected: string | null; onSelect: (id: string | null) => void; animate: boolean }) {
  const variants = draft.variants;
  const [newId, setNewId] = useState("");
  const issue = variantIdIssue(newId, variants.map((v) => v.id));
  const valid = newId !== "" && issue === null;
  const weightSum = variants.reduce((a, v) => a + v.weight, 0);
  const current = variants.find((v) => v.id === selected) ?? variants[0] ?? null;
  const replace = (next: Variant) => set("variants", variants.map((x) => (x.id === next.id ? next : x)));
  return (
    <div className={styles.layout}>
      <div className={styles.list}>
        {variants.map((v) => (
          <button key={v.id} type="button" className={styles.pick} aria-pressed={current?.id === v.id} data-testid={`variant-pick-${v.id}`} onClick={() => onSelect(v.id)}>
            <span className={styles.pickName}>{v.name}</span>
            <span className="muted mono">{v.id}</span>
            <span className="muted">{v.weight}%</span>
          </button>
        ))}
        <div className={styles.bar} aria-hidden="true">
          {variants.map((v) => (
            <span key={v.id} style={{ width: `${Math.max(0, Math.min(100, v.weight))}%` }} />
          ))}
        </div>
        <p className={`${styles.sum} ${weightSum === 100 ? "" : styles.sumBad}`}>重みの合計 {weightSum} / 100</p>
        <div className={styles.add}>
          <Field label="新しいパターンの ID(英小文字・数字・_ -。作成後は変更できません)" error={issue}>
            <input data-testid="new-variant-id" value={newId} placeholder={`v${variants.length + 1}`} disabled={ro || variantsLocked} onChange={(e) => setNewId(e.target.value)} />
          </Field>
          <button
            type="button"
            className="btn"
            disabled={ro || variantsLocked || !valid}
            onClick={() => {
              set("variants", [...variants, { id: newId, name: newId.toUpperCase(), weight: 0, analytics: null, changes: [] }]);
              onSelect(newId); // 足した Variant をそのまま開く
              setNewId("");
            }}
          >
            パターンを追加
          </button>
        </div>
      </div>
      <div>
        {variantsLocked ? (
          <p className="muted">配信中または終了済みのエクスペリエンスは、パターンの追加・削除・名前・重みを変更できません(割当ハッシュの入力のため)。変更の内容は引き続き編集できます。組み直すには新しいエクスペリエンスを作成してください</p>
        ) : null}
        {current ? (
          <div key={current.id} className={animate ? `${styles.detail} enter` : styles.detail}>
            <VariantEditor
              key={current.id}
              siteId={siteId}
              experimentId={experimentId}
              variant={current}
              disabled={ro}
              variantsLocked={variantsLocked}
              pageUrl={pageUrl}
              imageUpload={imageUpload}
              removable={variants.length > 2}
              onChange={replace}
              onRemove={() => {
                const rest = variants.filter((x) => x.id !== current.id);
                set("variants", rest);
                onSelect(rest[0]?.id ?? null);
              }}
            />
          </div>
        ) : (
          <p className="muted">パターンがありません</p>
        )}
      </div>
    </div>
  );
}
