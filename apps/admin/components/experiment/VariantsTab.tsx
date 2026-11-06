"use client";
import { useEffect, useState } from "react";
import type { AnalyticsSettings, Variant } from "@/lib/types";
import type { ImageFieldMode } from "@/lib/images";
import type { TabProps } from "@/lib/experiment-draft";
import { nextVariantId } from "@/lib/variant-id";
import { evenWeights, weightsAfterAdd, weightsAfterRemove } from "@/lib/weights";
import { analyticsCardOpenInitially } from "@/lib/analytics-badges";
import { VariantEditor } from "../VariantEditor";
import styles from "./VariantsTab.module.css";

/** 重みを並びのとおりに当て直す */
const withWeights = (variants: Variant[], weights: number[]): Variant[] => variants.map((v, i) => ({ ...v, weight: weights[i] ?? v.weight }));

/**
 * single = パーソナライズ(パターンは 1 つ。追加・削除・重みを出さない)。
 * 左にパターンの一覧(各行に重み、下に配分と合計)、右に選択中のパターン(設定 / 変更 / 外部計測の 3 枚。設計書 4.4・B77 Q8・Q30)。右には選んだ 1 つだけを描く。
 * variantsLocked: control の `PUT …/variants` は draft の実験にしか使えない(409 experiment_active)ので、
 * 非 draft ではパターンの集合(名前・重み・オリジナル・追加・削除・外部計測)を編集不可にする。変更とメモは引き続き編集できる。
 * 外部計測のカードの開閉(cardOpen)は ExperimentEditor の外枠が持つ(保存の後の作り直し・タブの往復をまたいで残す)
 */
export function VariantsTab({
  draft, set, ro, experimentId, variantsLocked, memoRo, pageUrl, imageMode, single, selected, onSelect, animate, names, savedVariants, cardOpen, onCardOpen, emptyHtml, saveTried = false,
}: TabProps & {
  experimentId: string;
  variantsLocked: boolean;
  /** メモの欄を閉じるか(省いたら ro と同じ) */
  memoRo?: boolean;
  pageUrl: string | null;
  imageMode: ImageFieldMode;
  single: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  animate: boolean;
  names: AnalyticsSettings;
  /** 保存済みのパターン(値の検査で、変えていない値を見ないため) */
  savedVariants: Variant[];
  /** 外部計測のカードの開閉(キー = `v:{パターン ID}`。まだ無いキーは最初の表示の規則で決める) */
  cardOpen: Record<string, boolean>;
  onCardOpen: (key: string, open: boolean) => void;
  /** B8: 保存の前に見つけた空の HTML の変更(無ければ null) */
  emptyHtml?: { variantId: string; changeIndex: number } | null;
  /** 保存を試したか(それまではキーが空の行に「値を入力してください」を出さない) */
  saveTried?: boolean;
}) {
  const variants = draft.variants;
  // 追加・削除で自動で配り直したときだけ「均等に配り直しました」を出す(手で重みを直したら消す)
  const [redistributed, setRedistributed] = useState(false);
  const weightSum = variants.reduce((a, v) => a + v.weight, 0);
  const current = variants.find((v) => v.id === selected) ?? variants[0] ?? null;
  const lockSet = ro || variantsLocked;
  const replace = (next: Variant) => set("variants", variants.map((x) => (x.id === next.id ? next : x)));

  // 外部計測のカード: まだ開閉を覚えていないパターンは、設定があれば開き、なければ畳む(Q30b)。
  // 最初に表示したときの値をすぐ覚える(編集中に設定を全部消しても、勝手に閉じない)
  const currentAnalytics = current?.analytics ?? null;
  const initialOpen = analyticsCardOpenInitially(currentAnalytics?.overrides?.variantName ?? "", currentAnalytics?.extra ?? {});
  // キーに前置きを付ける(パターン ID が "experiment" でも、エクスペリエンスのカードとぶつからない)
  const cardKey = current ? `v:${current.id}` : null;
  const analyticsOpen = cardKey ? (cardOpen[cardKey] ?? initialOpen) : false;
  useEffect(() => {
    if (cardKey && !(cardKey in cardOpen)) onCardOpen(cardKey, initialOpen);
  }, [cardKey, cardOpen, initialOpen, onCardOpen]);

  function addVariant() {
    const id = nextVariantId(variants.map((v) => v.id));
    const next = weightsAfterAdd(variants.map((v) => v.weight));
    set("variants", [
      ...withWeights(variants, next.weights),
      { id, name: id.toUpperCase(), weight: next.weights[variants.length] ?? 0, original: false, description: "", analytics: null, changes: [] },
    ]);
    setRedistributed(next.redistributed);
    onSelect(id); // 足したパターンをそのまま開く
  }

  function removeVariant(index: number) {
    const next = weightsAfterRemove(variants.map((v) => v.weight), index);
    const rest = withWeights(variants.filter((_, i) => i !== index), next.weights);
    set("variants", rest);
    setRedistributed(next.redistributed);
    onSelect(rest[0]?.id ?? null);
  }

  return (
    <div className={styles.layout}>
      <div className={styles.list}>
        {variants.map((v) => (
          <div key={v.id} className={styles.rowItem} data-on={current?.id === v.id || undefined}>
            <button type="button" className={styles.pick} aria-pressed={current?.id === v.id} data-testid={`variant-pick-${v.id}`} onClick={() => onSelect(v.id)}>
              {/* 名前と ID は長ければ … で切り、全文は title で見せる */}
              <span className={styles.pickMain} title={`${v.name}(${v.id})`}>
                <span className={styles.pickName}>
                  <span className={styles.nm}>{v.name}</span>
                  {v.original ? <span className="badge">オリジナル</span> : null}
                </span>
                <span className={`${styles.pickId} muted mono`}>{v.id}</span>
                {!single && v.weight === 0 ? <span className={styles.zero}>0% = 誰にも表示されません</span> : null}
              </span>
            </button>
            {/* 重みの欄は選択のボタンの外に置く(クリックで選択を切り替えない) */}
            {single ? null : (
              <span className={styles.w}>
                <input
                  type="number"
                  min={0}
                  max={100}
                  aria-label={`${v.name} の重み`}
                  data-testid={`variant-weight-${v.id}`}
                  value={v.weight}
                  disabled={lockSet}
                  onChange={(e) => {
                    const weight = e.target.value === "" ? 0 : Number(e.target.value);
                    set("variants", variants.map((x) => (x.id === v.id ? { ...x, weight } : x)));
                    setRedistributed(false);
                  }}
                />
                %
              </span>
            )}
          </div>
        ))}
        {single ? (
          <p className="muted">パーソナライズのパターンは 1 つです(振り分けません)</p>
        ) : (
          <>
            <div className={styles.bar} aria-hidden="true">
              {variants.map((v) => (
                <span key={v.id} className={v.original ? styles.orig : undefined} style={{ width: `${Math.max(0, Math.min(100, v.weight))}%` }} />
              ))}
            </div>
            <div className={styles.sumRow}>
              <span className={`${styles.sum} ${weightSum === 100 ? "" : styles.sumBad}`}>重みの合計 {weightSum} / 100</span>
              {redistributed ? <span className={styles.sum}>均等に配り直しました</span> : null}
              <button
                type="button"
                className="btn btn-sm"
                disabled={lockSet}
                onClick={() => {
                  set("variants", withWeights(variants, evenWeights(variants.length)));
                  setRedistributed(false);
                }}
              >
                均等に配分
              </button>
            </div>
            <div className={styles.add}>
              <button type="button" className="btn" disabled={lockSet} onClick={addVariant}>
                パターンを追加
              </button>
            </div>
          </>
        )}
      </div>
      <div className={styles.detailCol}>
        {current ? (
          <div key={current.id} className={animate ? "enter" : undefined}>
            <VariantEditor
              key={current.id}
              experimentId={experimentId}
              variant={current}
              saved={savedVariants.find((v) => v.id === current.id)}
              disabled={ro}
              variantsLocked={variantsLocked}
              memoDisabled={memoRo ?? ro}
              pageUrl={pageUrl}
              imageMode={imageMode}
              single={single}
              removable={!single && variants.length > 2}
              names={names}
              experimentName={draft.expName}
              experimentExtra={draft.extra}
              analyticsOpen={analyticsOpen}
              onAnalyticsOpen={(open) => onCardOpen(`v:${current.id}`, open)}
              saveTried={saveTried}
              emptyHtmlIndex={emptyHtml?.variantId === current.id ? emptyHtml.changeIndex : undefined}
              onChange={replace}
              onRemove={() => removeVariant(variants.indexOf(current))}
            />
          </div>
        ) : (
          <p className="muted">パターンがありません</p>
        )}
      </div>
    </div>
  );
}
