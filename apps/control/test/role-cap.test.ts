import { describe, expect, it } from "vitest";
import { roleCapFromMetadata } from "../src/roles";

/** backlog B33 / 決定 48 (4): metadata の読み取りは fail-closed。読めない形は VIEWER に落とし、無いときだけ「上限なし」 */
describe("roleCapFromMetadata (B33, fail-closed)", () => {
  it("null_or_empty_metadata_means_no_cap", () => {
    expect(roleCapFromMetadata(null)).toBeNull();
    expect(roleCapFromMetadata(undefined)).toBeNull();
    expect(roleCapFromMetadata("")).toBeNull();
    expect(roleCapFromMetadata("null")).toBeNull(); // Better Auth が metadata 無しの鍵に書く値
  });

  it("object_with_roleCap_returns_it_and_object_without_roleCap_means_no_cap", () => {
    expect(roleCapFromMetadata('{"roleCap":"editor"}')).toBe("editor");
    expect(roleCapFromMetadata('{"other":1}')).toBeNull();
  });

  it("double_stringified_object_is_read_like_better_auth_does", () => {
    // Better Auth の一覧処理は二重 JSON 化された metadata を解釈する。認証側も同じ解釈にしないと「一覧では EDITOR、要求では上限なし」になる
    expect(roleCapFromMetadata(JSON.stringify(JSON.stringify({ roleCap: "editor" })))).toBe("editor");
  });

  it("non_object_or_unknown_or_owner_values_fall_to_viewer", () => {
    expect(roleCapFromMetadata("[]")).toBe("viewer");
    expect(roleCapFromMetadata("true")).toBe("viewer");
    expect(roleCapFromMetadata('"just a string"')).toBe("viewer");
    expect(roleCapFromMetadata('{"roleCap":"superuser"}')).toBe("viewer");
    expect(roleCapFromMetadata('{"roleCap":"owner"}')).toBe("viewer"); // owner 相当は「上限なし」= null で表す約束なので、値としては不正
    expect(roleCapFromMetadata("{not json")).toBe("viewer");
  });
});
