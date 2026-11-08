import { own } from "./own";
import type { CompiledConfigV2 } from "./schema-v2";
import type { ConversionPayload, ExposurePayload } from "./analytics-defaults";

/**
 * B77(K6): 版 2 の config が `name`(エクスペリエンス・パターン・目標)を持つときの変換。版 3 は名前を受けないので、
 * 版 2 の読み取り(upgradeV2、config-upgrade.ts)の最初の段としてだけ呼ぶ(B69)。版 2 の読み取りと一緒に、版 4 で消す。
 *
 * 古い config は名前を config 本体に持ち、dataLayer の名前は「payload があればその値、無ければ name」で出ていた。
 * 新しい runtime の予備の導出は ID なので、版 3 にする前にここで
 *   (1) exposurePayloads に無い組を、名前(無ければ ID)で埋め
 *   (2) conversionPayloads に無い目標を、名前(無ければ ID)で埋め
 *   (3) 3 か所の `name` を消す
 * ことで、訪問者のブラウザに名前のキーを届けずに dataLayer の出力を保つ。
 * 純関数。入力を書き換えず、名前が無い config はそのまま返す(冪等)。
 */
export function withoutLegacyNames(config: CompiledConfigV2): CompiledConfigV2 {
  const hasName =
    config.goals.some((g) => g.name !== undefined) ||
    config.experiments.some((e) => e.name !== undefined || e.variants.some((v) => v.name !== undefined));
  if (!hasName) return config;

  // (1) 既にある payload は変えない。無い組だけ補う(ID はキーと一致させる。extra は空)
  // 「既にあるか」は自分のキーだけで見る(ID が `constructor` などのとき継承したものを既にあると見ない。B135)
  const exposurePayloads: Record<string, Record<string, ExposurePayload>> = {};
  for (const e of config.experiments) {
    const byVariant: Record<string, ExposurePayload> = { ...own(config.exposurePayloads ?? {}, e.id) };
    for (const v of e.variants) {
      byVariant[v.id] = own(byVariant, v.id) ?? { experimentId: e.id, experimentName: e.name ?? e.id, variantId: v.id, variantName: v.name ?? v.id, extra: {} };
    }
    exposurePayloads[e.id] = byVariant;
  }
  // experiments に無い experimentId の payload は、そのまま残す(検証は schema の責務)
  for (const [eid, byVariant] of Object.entries(config.exposurePayloads ?? {})) exposurePayloads[eid] = own(exposurePayloads, eid) ?? byVariant;

  // (2)
  const conversionPayloads: Record<string, ConversionPayload> = { ...(config.conversionPayloads ?? {}) };
  for (const g of config.goals) conversionPayloads[g.id] = own(conversionPayloads, g.id) ?? { goalId: g.id, goalName: g.name ?? g.id };

  // (3) `name` を落とした新しいオブジェクトにする
  const experiments = config.experiments.map(({ name: _en, variants, ...e }) => ({
    ...e,
    variants: variants.map(({ name: _vn, ...v }) => v),
  }));
  const goals = config.goals.map(({ name: _gn, ...g }) => g) as CompiledConfigV2["goals"];

  return { ...config, experiments, goals, exposurePayloads, conversionPayloads };
}
