"use client";
import { useState } from "react";
import type { AnalyticsSettings, Variant } from "@/lib/types";
import { analyticsValueErrors, shownValueErrors } from "@/lib/analytics-values";
import { experimentAnalyticsBadge, experimentOutputKeyMax, overrideCountByKey } from "@/lib/analytics-badges";
import { exposurePreview } from "@/lib/datalayer-preview";
import { ExtraEditor } from "../ExtraEditor";
import { Picker } from "../ui/Picker";
import { AnalyticsBadges, AnalyticsCard, AnalyticsSection, EXPOSED_NOTE, KeyCount, OverrideTip } from "./AnalyticsCard";
import { DataLayerPreview } from "./DataLayerPreview";
import styles from "./AnalyticsCard.module.css";

const EXTRA_MAX = 20;

/**
 * 基本設定の下部の、エクスペリエンスの外部計測のカード(B77 Q30。旧「外部計測」タブ)。
 * エクスペリエンス名 → エクスペリエンス情報を追加 → 出力される内容(出力を見るパターンを選ぶ)。
 * 値のエラーは保存済みの値と同じ値には出さない(K12)。保存を試す前は、キーが空の行の「値を入力してください」を出さない(ruling R12)
 */
export function ExperimentAnalyticsCard({
  experimentId,
  expName,
  extra,
  saved,
  variants,
  names,
  disabled,
  saveTried,
  open,
  onOpenChange,
  onChange,
}: {
  experimentId: string;
  expName: string;
  extra: Record<string, string>;
  /** 保存済みのエクスペリエンス名の指定と追加の値(値の検査で、変えていない値を見ないため) */
  saved: { expName: string; extra: Record<string, string> };
  /** 編集中のパターン(プレビュー・「上書き n 件」・出力するキーの最大に使う) */
  variants: Variant[];
  names: AnalyticsSettings;
  disabled: boolean;
  saveTried: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (next: { expName: string; extra: Record<string, string> }) => void;
}) {
  // 出力を見るパターン(消えたら先頭に戻す)
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = variants.find((v) => v.id === previewId) ?? variants[0] ?? null;
  const badge = experimentAnalyticsBadge(expName, extra);
  const overriddenBy = overrideCountByKey(extra, variants);
  const nameOf = (id: string) => variants.find((v) => v.id === id)?.name ?? id;
  const keyMax = experimentOutputKeyMax(extra, variants);
  const issues = shownValueErrors(analyticsValueErrors({ overrides: { experimentName: expName }, extra }, { overrides: { experimentName: saved.expName }, extra: saved.extra }, []), saveTried);
  const nameError = issues.find((x) => x.path[0] === "overrides")?.message;
  const extraErrors = Object.fromEntries(issues.filter((x) => x.path[0] === "extra").map((x) => [x.path[1]!, x.message]));
  return (
    <AnalyticsCard
      title="外部計測(dataLayer 出力)"
      badge={<AnalyticsBadges count={badge.count} overridden={badge.overridden} countTitle="このエクスペリエンスで設定した項目の数" />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <AnalyticsSection
        title="エクスペリエンス名"
        tipLabel="エクスペリエンス名の補足"
        tip={
          <>
            <code>{names.exposure.keys.experimentName}</code> に出力します。空なら、エクスペリエンス ID(<code>{experimentId}</code>)を出力します。全パターン共通です。{EXPOSED_NOTE}
          </>
        }
        mark={expName ? <span className="badge badge-warn">上書き</span> : null}
      >
        <input
          aria-label="出力するエクスペリエンス名"
          aria-invalid={nameError ? true : undefined}
          value={expName}
          placeholder={`空ならエクスペリエンス ID(${experimentId})を出力`}
          maxLength={100}
          disabled={disabled}
          onChange={(e) => onChange({ expName: e.target.value, extra })}
        />
        {nameError ? (
          <span role="alert" className="field-error">
            {nameError}
          </span>
        ) : null}
      </AnalyticsSection>
      <AnalyticsSection
        title="エクスペリエンス情報を追加"
        tipLabel="エクスペリエンス情報を追加の補足"
        tip={
          <>
            キーと値を <code>{names.extraKey}</code> の下に、全パターン共通で出力します(パターンの分と合わせて最大 20 キー)。パターン側に同じキーがあれば、そのパターンではパターン側の値を出力します。{EXPOSED_NOTE}
          </>
        }
      >
        <ExtraEditor
          value={extra}
          disabled={disabled}
          errors={extraErrors}
          rowMark={(k) => (overriddenBy[k]?.length ? <OverrideTip variants={overriddenBy[k].map(nameOf)} /> : null)}
          footer={
            <KeyCount over={keyMax > EXTRA_MAX}>
              出力するキー 最大 {keyMax} / {EXTRA_MAX}(パターンの分を含む)
            </KeyCount>
          }
          onChange={(next) => onChange({ expName, extra: next })}
        />
      </AnalyticsSection>
      <AnalyticsSection output title="出力される内容" tipLabel="出力される内容の補足" tip="選んだパターンが表示されたときに dataLayer に送る内容です。パターンごとに、パターン名と「パターン情報を追加」の値が変わります">
        {preview ? (
          <>
            {/* Picker は自分でラベルを描かない(aria-label だけ)ので見出しを前に置く。listbox を持つので label で包まない */}
            <div className={styles.pvPick}>
              <span className="field-label">パターン</span>
              <Picker
                label="出力を見るパターン"
                className={styles.pvPicker}
                value={preview.id}
                options={variants.map((v) => ({ value: v.id, label: v.name, hint: v.id }))}
                onChange={setPreviewId}
              />
            </div>
            <DataLayerPreview
              dataLayerName={names.dataLayerName}
              extraKey={names.extraKey}
              lines={exposurePreview(names, {
                experimentId,
                experimentName: expName,
                variantId: preview.id,
                variantName: preview.analytics?.overrides?.variantName ?? "",
                experimentExtra: extra,
                variantExtra: preview.analytics?.extra ?? {},
              })}
            />
          </>
        ) : (
          <p className="muted">パターンがありません</p>
        )}
      </AnalyticsSection>
    </AnalyticsCard>
  );
}
