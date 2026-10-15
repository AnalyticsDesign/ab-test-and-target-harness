import type { AnalyticsSettings, CompiledConfig } from "@wtt/core";

/**
 * spec §10.5 / §10.9: Experiment ごとに 1 回だけ Exposure を push する。割当が無い Experiment は発火しない。
 * push は 2 回に分ける — 1 回目 `{ [extraKey]: null }` は名前空間の消去だけで event を含まない(GTM トリガーは発火しない)。
 * GTM の data layer は push をマージし省略キーが前の値を保持するため、前の Experiment の extra が残留しないよう
 * イベント push の **直前** に名前空間ごと null で置換する(data-layer-helper の merge は plain object 以外を置換として扱う)。
 * 消去はイベント push の後には行わない(§10.9)
 */
export function createExposureTracker(
  config: CompiledConfig,
  names: AnalyticsSettings,
  assignments: Record<string, string>,
  push: (evt: Record<string, unknown>) => void,
): { expose(experimentId: string): void; reset(): void } {
  const exposed = new Set<string>();
  return {
    /** spec §16: revoke は世代を終わらせる。再 grant は新しい訪問者としての開始なので Exposure を再発火させる(2026-09-01 決定) */
    reset() {
      exposed.clear();
    },
    expose(experimentId: string) {
      if (exposed.has(experimentId)) return;
      const variantId = assignments[experimentId];
      if (variantId === undefined) return;
      exposed.add(experimentId);
      // compile が焼いた解決済み payload(§10.9)。形は parseBootPayload(isExposurePayloads)が起動前に検証済みで、ここでは欠落だけを扱う。
      // 無ければ experiments[] から導出する — runtime が持つ唯一の導出で、exposurePayloads を持たない旧 config のための互換
      //(合成ロジックはここには無い: overrides / extra は見ない)
      const resolved = config.exposurePayloads?.[experimentId]?.[variantId];
      const exp = resolved ? undefined : config.experiments.find((e) => e.id === experimentId);
      const variant = exp?.variants.find((v) => v.id === variantId);
      // ID は割当由来のローカル値を使い、payload 内の ID コピーは読まない — GA4 に出る ID とバケッティングに使った ID が
      // 食い違う経路を構造的に無くす(§10.9 合成規則が ID 上書きを禁じた根拠)。payload から読むのは name と extra だけ
      const experimentName = resolved?.experimentName ?? exp?.name ?? experimentId;
      const variantName = resolved?.variantName ?? variant?.name ?? variantId;
      const extra = resolved?.extra ?? {};
      const k = names.exposure.keys;
      push({ [names.extraKey]: null });
      push({
        event: names.exposure.event,
        [k.experimentId]: experimentId,
        [k.experimentName]: experimentName,
        [k.variantId]: variantId,
        [k.variantName]: variantName,
        [names.extraKey]: Object.keys(extra).length > 0 ? extra : null,
      });
    },
  };
}
