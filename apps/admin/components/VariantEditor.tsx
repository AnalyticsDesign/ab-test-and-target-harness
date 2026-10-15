"use client";
import type { Change, Variant } from "@/lib/types";
import { ChangeEditor, defaultPayload } from "./ChangeEditor";
import { ExtraEditor } from "./ExtraEditor";
import { AssetUpload } from "./AssetUpload";
import { Field } from "./Field";

export function VariantEditor({
  siteId,
  experimentId,
  variant,
  onChange,
  onRemove,
  disabled,
  variantsLocked,
  pageUrl,
  removable,
  imageUpload,
}: {
  siteId: string;
  experimentId: string;
  variant: Variant;
  onChange: (v: Variant) => void;
  onRemove: () => void;
  disabled: boolean;
  /**
   * control の `PUT …/variants` は draft の Experiment にしか使えない(409 experiment_active)。
   * 名前・重み・この Variant の Analytics 上書きはそのエンドポイントの body なので、非 draft では編集不可にする。
   * Change(`PUT …/changes`)はエンドポイントが別で status を見ないため、ここには含めない
   */
  variantsLocked: boolean;
  pageUrl: string | null;
  removable: boolean;
  /** 決定 43 (6): false ならアップロードボタンと IMAGE の種類を出さず、代替の一文を出す */
  imageUpload: boolean;
}) {
  const analytics = variant.analytics ?? {};
  const lockVariantSet = disabled || variantsLocked;
  return (
    // data-testid: E2E(apps/admin/e2e)が Variant の枠を一意に掴むための目印。枠(card)は VariantsTab の .detail が持つ
    <div data-testid={`variant-${variant.id}`}>
      <div className="row">
        <strong>
          パターン ID <code>{variant.id}</code>
        </strong>
        <span className="muted">(ID は作成後に変更できません。表示名は右の「名前」)</span>
        <label className="field">
          <span className="field-label">名前(100 字以内)</span>
          <input value={variant.name} maxLength={100} disabled={lockVariantSet} onChange={(e) => onChange({ ...variant, name: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">重み(合計 100)</span>
          <input type="number" min={0} max={100} value={variant.weight} disabled={lockVariantSet} onChange={(e) => onChange({ ...variant, weight: Number(e.target.value) })} />
        </label>
        {removable ? (
          <button type="button" className="btn" style={{ marginLeft: "auto" }} disabled={lockVariantSet} onClick={onRemove}>
            パターンを削除
          </button>
        ) : null}
      </div>
      <h3>外部計測(このパターンの値)</h3>
      {variantsLocked ? <p className="muted">配信中または終了済みのエクスペリエンスでは、パターンの外部計測の上書きは変更できません(変えるときは新しいエクスペリエンスを作成してください)</p> : null}
      <Field label="variantName の上書き(空 = 名前をそのまま)">
        <input
          value={analytics.overrides?.variantName ?? ""}
          maxLength={100}
          disabled={lockVariantSet}
          onChange={(e) => onChange({ ...variant, analytics: { ...analytics, overrides: e.target.value ? { variantName: e.target.value } : undefined } })}
        />
      </Field>
      <span className="field-label">extra(エクスペリエンスの同名キーを上書き)</span>
      <ExtraEditor value={analytics.extra ?? {}} disabled={lockVariantSet} onChange={(extra) => onChange({ ...variant, analytics: { ...analytics, extra } })} />
      <h3>変更</h3>
      {variant.changes.map((c, i) => (
        <ChangeEditor
          key={c.id}
          change={c}
          disabled={disabled}
          pageUrl={pageUrl}
          imageUpload={imageUpload}
          onChange={(next) => onChange({ ...variant, changes: variant.changes.map((x, j) => (j === i ? next : x)) })}
          onRemove={() => onChange({ ...variant, changes: variant.changes.filter((_, j) => j !== i) })}
        />
      ))}
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => onChange({ ...variant, changes: [...variant.changes, { id: `c_${Math.random().toString(36).slice(2, 8)}`, type: "TEXT", selector: "", payload: defaultPayload("TEXT") } as Change] })}
        >
          変更を追加
        </button>
        {imageUpload ? (
          <AssetUpload
            siteId={siteId}
            experimentId={experimentId}
            disabled={disabled}
            onUploaded={(url) => onChange({ ...variant, changes: [...variant.changes, { id: `c_${Math.random().toString(36).slice(2, 8)}`, type: "IMAGE", selector: "", payload: { src: url } }] })}
          />
        ) : (
          <span className="muted" data-testid="image-upload-disabled">
            この導入では画像アップロードと IMAGE の変更は使えません。画像の差し替えは ATTRIBUTE(src)で行ってください
          </span>
        )}
      </div>
    </div>
  );
}
