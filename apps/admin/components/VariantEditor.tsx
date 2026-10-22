"use client";
import type { AnalyticsSettings, Change, Variant } from "@/lib/types";
import { analyticsValueErrors, shownValueErrors } from "@/lib/analytics-values";
import { outputKeyCount, variantAnalyticsBadge } from "@/lib/analytics-badges";
import { exposurePreview } from "@/lib/datalayer-preview";
import { ChangeEditor, defaultPayload } from "./ChangeEditor";
import { ExtraEditor } from "./ExtraEditor";
import { AssetUpload } from "./AssetUpload";
import { MemoField } from "./MemoField";
import { AnalyticsBadges, AnalyticsCard, AnalyticsSection, EXPOSED_NOTE, KeyCount } from "./experiment/AnalyticsCard";
import { DataLayerPreview } from "./experiment/DataLayerPreview";
import styles from "./experiment/VariantsTab.module.css";

const NAME_MAX = 100;
const EXTRA_MAX = 20;

/**
 * 選んだパターンの詳細(B77 Q30): 設定(オリジナル / 変更あり・名前・メモ)→ 変更 → 外部計測 の 3 枚のカード。
 * 重みは一覧(VariantsTab)の行で入れる
 */
export function VariantEditor({
  siteId,
  experimentId,
  variant,
  saved,
  onChange,
  onRemove,
  disabled,
  variantsLocked,
  memoDisabled,
  pageUrl,
  removable,
  imageUpload,
  single,
  names,
  experimentName,
  experimentExtra,
  analyticsOpen,
  onAnalyticsOpen,
  emptyHtmlIndex,
  saveTried = false,
}: {
  siteId: string;
  experimentId: string;
  variant: Variant;
  /** 保存済みのこのパターン(新しいパターンは undefined)。値の検査で、変えていない値を見ないために使う(K12) */
  saved: Variant | undefined;
  onChange: (v: Variant) => void;
  onRemove: () => void;
  disabled: boolean;
  /**
   * control の `PUT …/variants` は draft の Experiment にしか使えない(409 experiment_active)。
   * 名前・オリジナル・この Variant の外部計測はそのエンドポイントの body なので、非 draft では編集不可にする。
   * Change(`PUT …/changes`)とメモ(`PATCH …/variants/:vid`)はエンドポイントが別で status を見ないため、ここには含めない
   */
  variantsLocked: boolean;
  /** メモの欄を閉じるか(メモは状態にかかわらず編集できる。閲覧者は不可) */
  memoDisabled: boolean;
  pageUrl: string | null;
  removable: boolean;
  /** 決定 43 (6): false ならアップロードボタンと IMAGE の種類を出さず、代替の一文を出す */
  imageUpload: boolean;
  /** パーソナライズ(kind = single)。オリジナルを使えないので「オリジナル / 変更あり」を出さない */
  single: boolean;
  /** サイトの外部計測の設定(プレビューのキー名) */
  names: AnalyticsSettings;
  /** エクスペリエンスの外部計測(編集中の値。プレビューと「上書き」の判定に使う) */
  experimentName: string;
  experimentExtra: Record<string, string>;
  analyticsOpen: boolean;
  onAnalyticsOpen: (open: boolean) => void;
  /** B8: 保存の前に見つけた空の HTML の変更の位置(無ければ undefined) */
  emptyHtmlIndex?: number;
  /** 保存を試したか(それまではキーが空の行に「値を入力してください」を出さない) */
  saveTried?: boolean;
}) {
  const analytics = variant.analytics ?? {};
  const nameOverride = analytics.overrides?.variantName ?? "";
  const extra = analytics.extra ?? {};
  const lockVariantSet = disabled || variantsLocked;
  const badge = variantAnalyticsBadge(nameOverride, extra, experimentExtra);
  const keyCount = outputKeyCount(experimentExtra, extra);
  const expKeys = Object.keys(experimentExtra).filter((k) => k !== "");
  // 各欄のエラー(保存済みの値と同じ値は見ない。変えていない古い値で欄を赤くしない。追加したばかりの空の行は保存を試すまで待つ)
  const issues = shownValueErrors(analyticsValueErrors(variant.analytics, saved?.analytics ?? null, []), saveTried);
  const nameError = issues.find((x) => x.path[0] === "overrides")?.message;
  const extraErrors = Object.fromEntries(issues.filter((x) => x.path[0] === "extra").map((x) => [x.path[1]!, x.message]));
  // 名前の指定も追加の値も無くなったら null に戻す(保存済みの null と同じにし、入力して消しただけで「未保存」にしない)
  const setAnalytics = (next: NonNullable<Variant["analytics"]>) =>
    onChange({ ...variant, analytics: next.overrides || next.extra ? { ...(next.overrides ? { overrides: next.overrides } : {}), ...(next.extra ? { extra: next.extra } : {}) } : null });
  const addChange = (change: Change) => onChange({ ...variant, changes: [...variant.changes, change] });
  const newChangeId = () => `c_${Math.random().toString(36).slice(2, 8)}`;
  return (
    // data-testid: E2E(apps/admin/e2e)が Variant の枠を一意に掴むための目印
    <div data-testid={`variant-${variant.id}`} className={styles.stack}>
      <section className="card" aria-label="パターンの設定">
        {variantsLocked ? <p className="muted" style={{ margin: "0 0 14px" }}>開始後は、パターンの追加・削除・名前・重み・オリジナルの切り替え・外部計測を変更できません。メモはいつでも編集できます。</p> : null}
        <div className={styles.head}>
          <strong className="break-anywhere">
            パターン ID <code>{variant.id}</code>
          </strong>
          {removable ? (
            <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={lockVariantSet} onClick={onRemove}>
              パターンを削除
            </button>
          ) : null}
        </div>
        {single ? null : (
          <div className={styles.kinds} role="radiogroup" aria-label="オリジナルか変更ありか">
            <KindCard checked={variant.original} disabled={lockVariantSet} title="オリジナル" description="ページを変えずに表示します" onSelect={() => onChange({ ...variant, original: true })} />
            <KindCard checked={!variant.original} disabled={lockVariantSet} title="変更あり" description="このパターンでページに変更を加えます" onSelect={() => onChange({ ...variant, original: false })} />
          </div>
        )}
        <div className={styles.countRow}>
          <label className="field">
            <span className="field-label">名前(100 字以内)</span>
            <input value={variant.name} maxLength={NAME_MAX} disabled={lockVariantSet} onChange={(e) => onChange({ ...variant, name: e.target.value })} />
          </label>
          <span className={styles.count}>
            {variant.name.length} / {NAME_MAX}
          </span>
        </div>
        <MemoField
          value={variant.description}
          disabled={memoDisabled}
          placeholder="例: 〇〇部の案。料金ページの改修(10/20)と重なるので、その週は参考値として見る"
          onChange={(description) => onChange({ ...variant, description })}
        />
      </section>
      <section className="card" aria-label="変更">
        <h2>変更</h2>
        {variant.original ? (
          <>
            {/* オリジナルに切り替えても、変更は下書きに残して隠すだけ(「変更あり」に戻せば見える)。保存で control が消す */}
            {variant.changes.length > 0 ? <p className={styles.pending}>保存すると、変更 {variant.changes.length} 件を削除します。「変更あり」に戻せば変更も戻ります。</p> : null}
            <p className={styles.empty}>オリジナルのパターンは変更を持てません</p>
          </>
        ) : (
          <>
            {variant.changes.length === 0 ? <p className="muted">変更はまだありません</p> : null}
            {variant.changes.map((c, i) => (
              <ChangeEditor
                key={c.id}
                change={c}
                disabled={disabled}
                pageUrl={pageUrl}
                imageUpload={imageUpload}
                error={i === emptyHtmlIndex ? "HTML を入力してください" : undefined}
                onChange={(next) => onChange({ ...variant, changes: variant.changes.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => onChange({ ...variant, changes: variant.changes.filter((_, j) => j !== i) })}
              />
            ))}
            <div className="row">
              <button type="button" className="btn" disabled={disabled} onClick={() => addChange({ id: newChangeId(), type: "TEXT", selector: "", payload: defaultPayload("TEXT") } as Change)}>
                変更を追加
              </button>
              {imageUpload ? (
                <AssetUpload siteId={siteId} experimentId={experimentId} disabled={disabled} onUploaded={(url) => addChange({ id: newChangeId(), type: "IMAGE", selector: "", payload: { src: url } })} />
              ) : (
                <span className="muted" data-testid="image-upload-disabled">
                  この導入では画像アップロードと IMAGE の変更は使えません。画像の差し替えは ATTRIBUTE(src)で行ってください
                </span>
              )}
            </div>
          </>
        )}
      </section>
      <AnalyticsCard
        title="外部計測(dataLayer 出力)"
        badge={<AnalyticsBadges count={badge.count} overridden={badge.overridden} countTitle="このパターンで設定した項目の数" />}
        open={analyticsOpen}
        onOpenChange={onAnalyticsOpen}
      >
        <AnalyticsSection
          title="パターン名"
          tipLabel="パターン名の補足"
          tip={
            <>
              <code>{names.exposure.keys.variantName}</code> に出力します。空なら、パターン ID(<code>{variant.id}</code>)を出力します。{EXPOSED_NOTE}
            </>
          }
          mark={nameOverride ? <span className="badge badge-warn">上書き</span> : null}
        >
          <input
            aria-label="出力するパターン名"
            aria-invalid={nameError ? true : undefined}
            value={nameOverride}
            placeholder={`空ならパターン ID(${variant.id})を出力`}
            maxLength={100}
            disabled={lockVariantSet}
            onChange={(e) => setAnalytics({ overrides: e.target.value ? { variantName: e.target.value } : undefined, extra: analytics.extra })}
          />
          {nameError ? (
            <span role="alert" className="field-error">
              {nameError}
            </span>
          ) : null}
        </AnalyticsSection>
        <AnalyticsSection
          title="パターン情報を追加"
          tipLabel="パターン情報を追加の補足"
          tip={
            <>
              キーと値を <code>{names.extraKey}</code> の下に出力します(最大 20 キー)。エクスペリエンスと同じキーは、このパターンの値で上書きします
              {expKeys.length > 0 ? (
                <>
                  (エクスペリエンスのキー:{" "}
                  {expKeys.map((k, i) => (
                    <span key={k}>
                      {i > 0 ? "・" : null}
                      <code>{k}</code>
                    </span>
                  ))}
                  )
                </>
              ) : null}
              。{EXPOSED_NOTE}
            </>
          }
        >
          <ExtraEditor
            value={extra}
            disabled={lockVariantSet}
            errors={extraErrors}
            rowMark={(k) => (k !== "" && expKeys.includes(k) ? <span className="badge badge-warn">上書き</span> : null)}
            footer={
              <KeyCount over={keyCount > EXTRA_MAX}>
                出力するキー {keyCount} / {EXTRA_MAX}
              </KeyCount>
            }
            onChange={(next) => setAnalytics({ overrides: analytics.overrides, extra: Object.keys(next).length ? next : undefined })}
          />
        </AnalyticsSection>
        <AnalyticsSection output title="出力される内容" tipLabel="出力される内容の補足" tip="このパターンが表示されたときに dataLayer に送る内容です。サイト設定・エクスペリエンス・このパターンの値を合わせた結果です">
          <DataLayerPreview
            extraKey={names.extraKey}
            lines={exposurePreview(names, { experimentId, experimentName, variantId: variant.id, variantName: nameOverride, experimentExtra, variantExtra: extra })}
          />
        </AnalyticsSection>
      </AnalyticsCard>
    </div>
  );
}

/** 「オリジナル / 変更あり」の選択カード(B77 Q3)。見出しは付けず、説明文で選ぶと何が起きるかを示す */
function KindCard({ checked, disabled, title, description, onSelect }: { checked: boolean; disabled: boolean; title: string; description: string; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className={styles.kind} disabled={disabled} onClick={onSelect}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.kindTitle}>{title}</span>
      <span className={styles.kindDesc}>{description}</span>
    </button>
  );
}
