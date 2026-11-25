import { expect, it } from "vitest";
import { kvStaleBannerText } from "@/lib/kv-stale-banner";

it.each(["pending", null, undefined] as const)("反映待ち、または理由が無いときの案内 (%s)", (reason) => {
  expect(kvStaleBannerText(reason)).toBe("配信ポインタが未収束です(自動で再同期します。通常 15 分以内に反映します)");
});
it("設定を読み取れないときは再公開を案内する", () => {
  expect(kvStaleBannerText("config_missing")).toBe("配信の設定が見つかりません。公開し直してください");
});
