import { describe, expect, it } from "vitest";
import { SECTIONS, fieldKeysFor, firstInvalidSection, sectionOfField } from "@/components/settings/sections";

describe("settings sections", () => {
  it("lists the submenu in the designed order, with headings that match the current names", () => {
    expect(SECTIONS.map((s) => s.label)).toEqual(["一般", "導入タグ", "訪問者 ID", "外部計測の名前", "外部 ID", "危険な操作"]);
    expect(SECTIONS.find((s) => s.id === "naming")!.heading).toBe("外部計測の名前(dataLayer の名札)");
    expect(SECTIONS.find((s) => s.id === "external")!.heading).toBe("分析(外部 ID)");
    expect(SECTIONS.filter((s) => !s.inForm).map((s) => s.id)).toEqual(["tag", "danger"]);
  });
  it("finds the section that holds a form field (input name or control error path)", () => {
    expect(sectionOfField("name")).toBe("general");
    expect(sectionOfField("allowedOrigins")).toBe("general");
    expect(sectionOfField("decisionTimeoutMs")).toBe("general");
    expect(sectionOfField("mode")).toBe("identity");
    expect(sectionOfField("hosts")).toBe("identity");
    expect(sectionOfField("idSource")).toBe("identity");
    expect(sectionOfField("byoidCookie")).toBe("identity");
    expect(sectionOfField("visitorCookieName")).toBe("identity");
    expect(sectionOfField("uuidCookieName")).toBe("identity");
    expect(sectionOfField("analytics.exposure.event")).toBe("naming");
    expect(sectionOfField("exposure.event")).toBe("naming"); // invalid_analytics は analytics. が付かない
    expect(sectionOfField("extraKey")).toBe("naming");
    expect(sectionOfField("dataLayerName")).toBe("naming"); // 決定 62: invalid_analytics の path は analytics. が付かない
    expect(sectionOfField("ga4PropertyId")).toBe("external");
    expect(sectionOfField("bigqueryDataset")).toBe("external");
    expect(sectionOfField("unknown")).toBe("general");
  });
  it("opens the section of the FIRST invalid field (the one the browser focuses), not the last", () => {
    expect(firstInvalidSection(["uuidCookieName", "analytics.exposure.event", "ga4PropertyId"])).toBe("identity");
    expect(firstInvalidSection(["ga4PropertyId", "name"])).toBe("external");
    expect(firstInvalidSection([])).toBe("general");
  });
  // B31 ④: 欄を変えたら、その欄のエラーだけを消す(同じ節の別の欄のエラーは残す)
  it("clears_field_errors_by_input_name", () => {
    const analytics = fieldKeysFor("analytics.exposure.event");
    expect(analytics("analytics.exposure.event")).toBe(true);
    expect(analytics("exposure.event")).toBe(true); // invalid_analytics は analytics. が付かない
    expect(analytics("exposure.keys")).toBe(false);
    expect(analytics("analytics.conversion.event")).toBe(false);
    const byoid = fieldKeysFor("byoidCookie");
    expect(byoid("byoidCookie")).toBe(true);
    expect(byoid("idSource")).toBe(true); // 参照する Cookie 名の欄のエラーは idSource で返る
    expect(byoid("visitorCookieName")).toBe(false);
    const origins = fieldKeysFor("allowedOrigins");
    expect(origins("allowedOrigins")).toBe(true);
    expect(origins("allowedOrigins.0")).toBe(true); // 配列の添字
    expect(origins("domain")).toBe(false);
    expect(origins("allowedOriginsX")).toBe(false);
  });
});
