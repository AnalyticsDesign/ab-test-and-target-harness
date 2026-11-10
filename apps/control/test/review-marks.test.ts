import { describe, it, expect } from "vitest";
import { reviewMarkOf } from "../src/review-marks";

describe("review marks", () => {
  const cases: Array<[string, string | undefined, unknown, string | null]> = [
    ["HTML", ".title", {}, "code"], ["CSS", undefined, {}, "code"], ["CUSTOM_JS", undefined, {}, "code"],
    ["TEXT", "head > style", {}, "code"], ["TEXT", "STYLE#x", {}, "code"], ["TEXT", ".title", {}, null],
    ["ATTRIBUTE", ".x", { name: "rel", value: "stylesheet" }, "code"], ["ATTRIBUTE", ".x", { name: "Rel", value: "stylesheet" }, "code"],
    ["ATTRIBUTE", ".x", { name: "href", value: "https://cdn.example/x.css" }, "external_url"],
    ["ATTRIBUTE", ".x", { name: "src", value: "//cdn.example/x.js" }, "external_url"],
    ...[" https://x", "ht\ttps://x", "http:evil.example", "/\\evil.example", "//[", "//%"].map((value): [string, string, unknown, string] => ["ATTRIBUTE", ".x", { name: "href", value }, "external_url"]),
    ["ATTRIBUTE", ".x", { name: "HREF", value: "https://x" }, "external_url"],
    ["ATTRIBUTE", ".x", { name: "href", value: "/path" }, null],
    ["ATTRIBUTE", "link", { name: "href", value: "https://x" }, "code"],
    ...['[rel="stylesheet"]', "#stylesheet", ".my_style"].map((selector): [string, string, unknown, string] => ["TEXT", selector, {}, "code"]),
    ["IMAGE", "style", { src: "https://x" }, null],
  ];
  it.each(cases)("%s %s %j → %s", (type, selector, payload, expected) => {
    expect(reviewMarkOf({ type: type as string, selector: selector as string | undefined, payload })).toBe(expected);
  });
});
