import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_ANALYTICS } from "../src/index";

// integrations/gtm/wtt-gtm-container.json(サイト導入ガイドの GTM インポート用ショートカット)が
// 既定の名札(DEFAULT_ANALYTICS)とずれていないことを確かめる。既定名を変えたらこの JSON も直す
const ROOT = new URL("../../..", import.meta.url).pathname;
const JSON_PATH = `${ROOT}/integrations/gtm/wtt-gtm-container.json`;
const MANIFEST_PATH = `${ROOT}/release/manifest.json`; // 開発リポジトリにだけある(公開側では該当テストを飛ばす)

type Param = { type: string; key?: string; value?: string; list?: Param[]; map?: Param[] };
type Tag = { tagId: string; name: string; type: string; parameter: Param[]; firingTriggerId: string[] };
type Trigger = { triggerId: string; name: string; type: string; customEventFilter: Array<{ type: string; parameter: Param[] }> };
type Variable = { variableId: string; name: string; type: string; parameter: Param[] };

const raw = readFileSync(JSON_PATH, "utf8");
const { containerVersion } = JSON.parse(raw) as { containerVersion: { tag: Tag[]; trigger: Trigger[]; variable: Variable[] } };
const { tag: tags, trigger: triggers, variable: variables } = containerVersion;

const param = (ps: Param[], key: string) => ps.find((p) => p.key === key);
const eventParams = (t: Tag) =>
  (param(t.parameter, "eventSettingsTable")?.list ?? []).map((row) => ({
    name: param(row.map ?? [], "parameter")?.value,
    value: param(row.map ?? [], "parameterValue")?.value,
  }));

function tagFor(event: string): Tag {
  const t = tags.find((x) => param(x.parameter, "eventName")?.value === event);
  if (!t) throw new Error(`GA4 イベントタグ ${event} が無い`);
  return t;
}

describe("GTM インポート用 JSON(integrations/gtm)", () => {
  it("gtm_container_matches_default_analytics_names", () => {
    const cases = [
      { event: DEFAULT_ANALYTICS.exposure.event, keys: Object.values(DEFAULT_ANALYTICS.exposure.keys) },
      { event: DEFAULT_ANALYTICS.conversion.event, keys: Object.values(DEFAULT_ANALYTICS.conversion.keys) },
    ];
    expect(tags).toHaveLength(cases.length);
    for (const { event, keys } of cases) {
      const t = tagFor(event);
      // トリガーは同じイベント名のカスタムイベント
      const trig = triggers.find((x) => x.triggerId === t.firingTriggerId[0]);
      expect(trig?.type).toBe("CUSTOM_EVENT");
      expect(param(trig!.customEventFilter[0]!.parameter, "arg1")?.value).toBe(event);
      // 既定のキーをすべて同名のイベントパラメータとして送り、値は同名の DLV(Version 2)
      const ps = eventParams(t);
      expect(ps.map((p) => p.name).sort()).toEqual([...keys].sort());
      for (const p of ps) {
        const v = variables.find((x) => `{{${x.name}}}` === p.value);
        expect(v?.type, `${p.name} の DLV`).toBe("v");
        expect(param(v!.parameter, "name")?.value).toBe(p.name);
        expect(param(v!.parameter, "dataLayerVersion")?.value).toBe("2");
      }
    }
  });

  it("gtm_container_references_resolve_and_adds_no_google_tag", () => {
    const triggerIds = new Set(triggers.map((t) => t.triggerId));
    for (const t of tags) {
      expect(t.type, `${t.name} は GA4 イベントタグだけ(Google タグを入れると既存計測と二重になる)`).toBe("gaawe");
      for (const id of t.firingTriggerId) expect(triggerIds.has(id), `${t.name} → trigger ${id}`).toBe(true);
    }
    // {{変数名}} の参照はすべて JSON 内の変数か GTM 組み込みの _event
    const names = new Set([...variables.map((v) => v.name), "_event"]);
    for (const [, ref] of raw.matchAll(/\{\{([^}]+)\}\}/g)) expect(names.has(ref!), `{{${ref}}}`).toBe(true);
    // ID は種別をまたいで一意(インポート時の取り違えを避ける)
    const ids = [...tags.map((t) => t.tagId), ...triggers.map((t) => t.triggerId), ...variables.map((v) => v.variableId)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gtm_container_uses_placeholders_only", () => {
    const mid = variables.find((v) => v.name === "C - GA4 Measurement ID");
    expect(param(mid!.parameter, "value")?.value).toBe("G-XXXXXXXXXX");
    expect(raw).toMatch(/"publicId": "GTM-XXXXXXX"/);
    expect(raw).not.toMatch(/"(accountId|containerId)": "(?!0")/);
  });

  it.skipIf(!existsSync(MANIFEST_PATH))("gtm_container_has_no_site_values_or_private_refs", () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { siteValues: string[]; privateRefPatterns: string[] };
    for (const v of m.siteValues) expect(raw.includes(v), v).toBe(false);
    for (const p of m.privateRefPatterns) expect(new RegExp(p).test(raw), p).toBe(false);
  });
});
