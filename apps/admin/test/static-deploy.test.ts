import { describe, expect, it } from "vitest";
import { staticRedeployMessage } from "@/lib/static-deploy";

describe("staticRedeployMessage", () => {
  it("作り直しの結果を 3 つに分ける(skipped は自動の再試行が無いので、仕組みの設定の確認を案内する)", () => {
    expect(staticRedeployMessage("deployed")).toBe("配信ファイルを作り直しました");
    expect(staticRedeployMessage("pending")).toBe("まだ更新できていません。自動で再試行を続けます");
    expect(staticRedeployMessage("skipped")).toBe("配信ファイルを更新する仕組みが設定されていません(導入手順を確認してください)");
  });
});
