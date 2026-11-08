/**
 * 版 2 の compiled config を版 3 にする(B69、spec §5)。edge・deployer・control が parseCompiledConfig から呼ぶ。runtime には入れない。
 * 版 2 の読み取り(schema-v2.ts)と一緒に、版 4 で消す
 */
import { dslNeedsProfile } from "./evaluate";
import { withoutLegacyNames } from "./legacy-names";
import { CompiledConfigSchema, type CompiledConfig, type DslNode } from "./schema";
import type { CompiledConfigV2 } from "./schema-v2";
import { findRemovedPageCondition } from "./targeting";

/** 鍵が残すエクスペリエンスの ID の項目だけを持つ新しい record(delete を使わない。ID が prototype の名前でも安全) */
const keep = <T>(r: Record<string, T>, ids: Set<string>): Record<string, T> => Object.fromEntries(Object.entries(r).filter(([id]) => ids.has(id)));

/**
 * 版 2 → 版 3:
 *   (1) 名前を exposurePayloads・conversionPayloads に移してから落とす(withoutLegacyNames)
 *   (2) 対象 URL(1 つのページの一致)を含める 1 行 `{ include: [{ page }] }` に包む(意味は変わらない)
 *   (3) 配信条件にページの条件(url / host / path / query)を持つエクスペリエンスを外し、それを鍵に持つ prehide・exposureSelectors・
 *       exposurePayloads・results.runs の項目も外す(版 3 で表せない。意味を保てないものは配らない。次の Publish で戻る)
 *   (4) needsProfile を残ったエクスペリエンスの配信条件(dslNeedsProfile)と persistAssignment から計算し直す(compile と同じ規則)
 *   (5) 版 3 の CompiledConfigSchema で検査し、通らなければ null(変換の誤りで壊れた設定を配らない)
 * パターン(patterns)・目標・パターン ID は変えない。純関数(入力を書き換えない)
 */
export function upgradeV2(c: CompiledConfigV2): CompiledConfig | null {
  const named = withoutLegacyNames(c);
  const experiments = named.experiments
    .filter((e) => findRemovedPageCondition(e.targeting) === null)
    .map(({ urlMatch, ...e }) => ({ ...e, urlMatch: { include: [{ page: urlMatch }] } }));
  const ids = new Set(experiments.map((e) => e.id));
  // 残ったものの配信条件はページの条件を持たない = 版 3 の DslNode(形は最後の safeParse が確かめる)
  const needsProfile = experiments.some((e) => e.persistAssignment || (e.targeting !== undefined && dslNeedsProfile(e.targeting as DslNode)));
  const out = {
    ...named,
    schemaVersion: 3,
    needsProfile,
    prehide: keep(named.prehide, ids),
    exposureSelectors: keep(named.exposureSelectors, ids),
    experiments,
    ...(named.exposurePayloads ? { exposurePayloads: keep(named.exposurePayloads, ids) } : {}),
    ...(named.results ? { results: { ...named.results, runs: keep(named.results.runs, ids) } } : {}),
  };
  const r = CompiledConfigSchema.safeParse(out);
  return r.success ? r.data : null;
}
